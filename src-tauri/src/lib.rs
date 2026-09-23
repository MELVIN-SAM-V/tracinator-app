mod bootstrap;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::sleep;

use bootstrap::{ensure_server_runtime, ServerRuntime};

const DEFAULT_PORT: u16 = 7331;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Owns the spawned backend's `Child` (for shutdown/kill) and the port it
/// ended up bound to (chosen at runtime — see `pick_port`).
struct BackendState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
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

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .to_path_buf()
}

fn spawn_backend(runtime: &ServerRuntime, port: u16) -> std::io::Result<Child> {
    let root = repo_root();
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

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
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

async fn post(port: u16, path: &str) {
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
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

    let child = match spawn_backend(&runtime, port) {
        Ok(child) => child,
        Err(e) => {
            fatal(&handle, format!("Failed to start Tracinator's backend: {e}"));
            return;
        }
    };
    *handle.state::<BackendState>().child.lock().unwrap() = Some(child);

    let url = format!("http://127.0.0.1:{port}/");
    let main_window = WebviewWindowBuilder::new(
        &handle,
        "main",
        WebviewUrl::External(url.parse().expect("constructed URL is valid")),
    )
    .title("Tracinator")
    .inner_size(1280.0, 800.0)
    .min_inner_size(760.0, 480.0)
    .visible(false)
    // No OS title bar — the frontend draws its own (App.tsx's top bar +
    // WindowControls.tsx), VS Code-style. ResizeHandles.tsx reimplements
    // edge/corner resize, lost along with the OS frame.
    .decorations(false)
    .build();

    let main_window = match main_window {
        Ok(w) => w,
        Err(e) => {
            fatal(&handle, format!("Failed to create the main window: {e}"));
            return;
        }
    };

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    if wait_for_health(port, deadline).await {
        if let Some(splash) = handle.get_webview_window("splashscreen") {
            let _ = splash.close();
        }
        let _ = main_window.show();
        let _ = main_window.set_focus();
    } else {
        fatal(&handle, "Tracinator's backend didn't start in time.");
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
    if port != 0 {
        post(port, "/api/shutdown").await;
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
