mod bootstrap;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::sleep;

use bootstrap::{ensure_server_runtime, ServerRuntime};

const DEFAULT_PORT: u16 = 7331;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Owns the spawned backend's `Child` (for shutdown/kill), the port it
/// ended up bound to (chosen at runtime — see `pick_port`), and the
/// per-launch API token every /api request must carry (see `new_api_token`).
struct BackendState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
    api_token: Mutex<String>,
}

/// Name of the env var the backend reads its token from, and of the request
/// header it expects it in (tracinator/server/app.py, API_TOKEN_ENV /
/// API_TOKEN_HEADER).
const API_TOKEN_ENV: &str = "TRACINATOR_API_TOKEN";
const API_TOKEN_HEADER: &str = "X-Tracinator-Token";

/// 32 random bytes, hex-encoded. The backend refuses /api requests without
/// it, so a web page open in the user's browser can't drive it (via DNS
/// rebinding, say) — /api/trace evaluates its args as Python, so reaching it
/// means running arbitrary code. Hex keeps it safe to drop into a header
/// and a JS string literal as-is.
fn new_api_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Hands the token to the frontend without the backend ever serving it (a
/// DNS-rebinding page can read anything the backend serves). Tauri runs
/// initialization scripts on every page the window loads — and on Windows in
/// subframes too — so it only sets the token on the backend's own origin.
fn token_init_script(port: u16, token: &str) -> String {
    format!(
        "if (window.location.origin === 'http://127.0.0.1:{port}') {{ \
         window.__TRACINATOR_API_TOKEN__ = '{token}'; }}"
    )
}

/// Tries `cli.py`'s own default port first so a dev used to `tracinator ui`
/// sees the same port; falls back to whatever the OS hands out on conflict.
fn pick_port() -> u16 {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", DEFAULT_PORT)) {
        drop(listener);
        return DEFAULT_PORT;
    }
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).expect("failed to bind an OS-assigned port");
    let port = listener
        .local_addr()
        .expect("bound listener has a local addr")
        .port();
    drop(listener);
    port
}

/// The folder the file browser starts in (the user can switch it with
/// "Open folder"). Dev builds use this repo, as `tauri dev` always has.
/// Release builds must not: `CARGO_MANIFEST_DIR` is the *build machine's*
/// path, baked in at compile time, and on any other PC that folder doesn't
/// exist, so spawning the backend with it as cwd fails outright.
fn default_project_root(handle: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent directory")
            .to_path_buf();
    }
    handle
        .path()
        .home_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn spawn_backend(
    runtime: &ServerRuntime,
    port: u16,
    root: &Path,
    api_token: &str,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(&runtime.python);
    // -P (PYTHONSAFEPATH, 3.11+): `-m` normally prepends cwd to sys.path,
    // which would let a *traced project* that happens to contain a
    // `tracinator/` (or any bundled dep's) directory silently shadow the
    // bundled interpreter's own installed copy of that package — this bit
    // real during testing here, since tracinator's own repo is the default
    // traced project and contains exactly that.
    cmd.arg("-P")
        .arg("-m")
        .arg("tracinator.desktop_launcher")
        .arg("--project-root")
        .arg(&root)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&root)
        .stdin(Stdio::null());

    if let Some(pythonpath) = &runtime.pythonpath {
        cmd.env("PYTHONPATH", pythonpath);
    }
    // Read (and removed from its environment) by app.py at import.
    cmd.env(API_TOKEN_ENV, api_token);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    #[cfg(windows)]
    tie_to_app_lifetime(&child);
    Ok(child)
}

/// Puts the backend (and anything it spawns, like the traced code's
/// interpreter) in a Job Object that kills its members once the job's last
/// handle closes, i.e. when this process ends however it ends. Some exits
/// skip `shutdown_backend`: the updater's install step launches the
/// installer and then calls `std::process::exit(0)` directly. The orphaned
/// backend kept the runtime folder's python.exe in use, so the updated
/// app's bootstrap couldn't replace that folder and failed with "Access is
/// denied" on every launch. The job handle is deliberately never closed,
/// since closing it would kill the backend.
#[cfg(windows)]
fn tie_to_app_lifetime(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            log::warn!("CreateJobObjectW failed; the backend may outlive the app on a hard exit");
            return;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0;
        if !configured || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            log::warn!(
                "couldn't put the backend in a kill-on-close job; it may outlive the app on a hard exit"
            );
            CloseHandle(job);
        }
    }
}

async fn get(port: u16, path: &str) -> Option<String> {
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

async fn post(port: u16, path: &str, api_token: &str) {
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{API_TOKEN_HEADER}: {api_token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)).await {
        let _ = stream.write_all(request.as_bytes()).await;
        let mut buf = Vec::new();
        let _ = stream.read_to_end(&mut buf).await;
    }
}

async fn wait_for_health(port: u16, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if let Some(response) = get(port, "/api/health").await {
            if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
                return true;
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
    false
}

fn fatal(handle: &AppHandle, message: impl Into<String>) {
    handle
        .dialog()
        .message(message.into())
        .title("Tracinator")
        .blocking_show();
    handle.exit(1);
}

async fn boot(handle: AppHandle) {
    let port = pick_port();
    *handle.state::<BackendState>().port.lock().unwrap() = port;

    let runtime = match ensure_server_runtime(&handle).await {
        Ok(runtime) => runtime,
        Err(e) => {
            fatal(&handle, format!("Failed to set up Tracinator's backend: {e}"));
            return;
        }
    };

    let api_token = match new_api_token() {
        Ok(token) => token,
        Err(e) => {
            fatal(&handle, format!("Failed to generate Tracinator's session token: {e}"));
            return;
        }
    };
    *handle.state::<BackendState>().api_token.lock().unwrap() = api_token.clone();

    let root = default_project_root(&handle);
    let child = match spawn_backend(&runtime, port, &root, &api_token) {
        Ok(child) => child,
        Err(e) => {
            fatal(&handle, format!("Failed to start Tracinator's backend: {e}"));
            return;
        }
    };
    *handle.state::<BackendState>().child.lock().unwrap() = Some(child);

    // The main window must not exist until the backend is listening:
    // created any earlier, WebView2 renders its own "127.0.0.1 refused to
    // connect" error page, which can flash up before the real UI loads.
    if !wait_for_health(port, Instant::now() + HEALTH_TIMEOUT).await {
        fatal(&handle, "Tracinator's backend didn't start in time.");
        return;
    }

    let url = format!("http://127.0.0.1:{port}/");
    let main_window = WebviewWindowBuilder::new(
        &handle,
        "main",
        WebviewUrl::External(url.parse().expect("constructed URL is valid")),
    )
    .initialization_script(token_init_script(port, &api_token))
    .title("Tracinator")
    .inner_size(1280.0, 800.0)
    .min_inner_size(760.0, 480.0)
    .visible(false)
    // No OS title bar — the frontend draws its own (App.tsx's top bar +
    // WindowControls.tsx), VS Code-style. ResizeHandles.tsx reimplements
    // edge/corner resize, lost along with the OS frame.
    .decorations(false)
    // Swap splash -> main only once the UI has actually rendered, so the
    // user never sees a blank/white webview in between.
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            if let Some(splash) = window.app_handle().get_webview_window("splashscreen") {
                let _ = splash.close();
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build();

    if let Err(e) = main_window {
        fatal(&handle, format!("Failed to create the main window: {e}"));
    }
}

/// `Child::kill()` is a hard kill on every platform (SIGKILL on Unix,
/// TerminateProcess on Windows) — Rust's stdlib has no portable graceful
/// signal. So: ask nicely over HTTP first (this hits the same
/// `server.should_exit = True` mechanism `cli.py` already uses on Ctrl+C,
/// via `/api/shutdown`), give it a grace period to exit on its own, and only
/// fall back to a hard kill if it hasn't by then.
async fn shutdown_backend(handle: &AppHandle) {
    let state = handle.state::<BackendState>();
    let port = *state.port.lock().unwrap();
    let api_token = state.api_token.lock().unwrap().clone();
    if port != 0 {
        post(port, "/api/shutdown", &api_token).await;
    }

    let deadline = Instant::now() + SHUTDOWN_GRACE;
    loop {
        let exited = {
            let mut guard = state.child.lock().unwrap();
            match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            }
        };
        if exited {
            break;
        }
        if Instant::now() >= deadline {
            if let Some(mut child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            break;
        }
        sleep(Duration::from_millis(100)).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        // Checks tauri.conf.json's `plugins.updater.endpoints` for a newer
        // signed release; see UpdateBanner.tsx for the prompt-before-install
        // UI this backs. tauri-plugin-process's relaunch() is what actually
        // restarts into the new version after downloadAndInstall() finishes.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendState {
            child: Mutex::new(None),
            port: Mutex::new(0),
            api_token: Mutex::new(String::new()),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(boot(handle));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        shutdown_backend(window.app_handle()).await;
                        let _ = window.close();
                        std::process::exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
