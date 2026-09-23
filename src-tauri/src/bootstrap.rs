//! First-run dependency bootstrap: unpacks the private interpreter +
//! offline wheelhouse baked into the app bundle by
//! `infra/scripts/build_desktop_runtime.sh`, and `pip install --target`s
//! tracinator's own server deps with no venv, no network, no system Python.
//! Idempotent across launches via a version-keyed marker file. Unrelated to
//! `tracinator/server/app.py`'s `resolve_python_executable` — that picks
//! the interpreter for *traced* code, a separate, already-shipped concern.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

// Array-form `bundle.resources` (see tauri.windows.conf.json /
// tauri.linux.conf.json) preserves each platform's zip under its original,
// suffixed name rather than the map form's target rename — the map form
// silently kept the source name in at least the Windows MSI/WiX bundle, so
// this resolves the resource by the name it's actually bundled under.
fn runtime_resource_path() -> &'static str {
    if cfg!(windows) {
        "resources/runtime-windows-x86_64.zip"
    } else {
        "resources/runtime-linux-x86_64.zip"
    }
}

/// What `spawn_backend` needs to run tracinator's own server.
pub struct ServerRuntime {
    pub python: PathBuf,
    /// Set only for the bundled runtime — the bootstrap installs straight
    /// into a bare directory (no venv), so PYTHONPATH is what makes those
    /// packages importable.
    pub pythonpath: Option<PathBuf>,
}

fn bundled_python_rel() -> &'static str {
    if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3"
    }
}

/// Dev-only fallback for when the runtime archive hasn't been built
/// (see infra/scripts/build_desktop_runtime.sh) — keeps `cargo tauri dev`
/// fast for pure-Rust iteration without requiring a ~75MB archive rebuild
/// every time. A packaged build always has the resource, so this path is
/// never taken there.
fn dev_fallback_python() -> PathBuf {
    let mut path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .to_path_buf();
    path.push(".venv");
    if cfg!(windows) {
        path.push("Scripts");
        path.push("python.exe");
    } else {
        path.push("bin");
        path.push("python");
    }
    path
}

fn unzip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(relative_path) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(relative_path);

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Runs the bundled interpreter's own pip, offline, against the wheelhouse
/// zipped alongside it.
fn install_site_packages(python: &Path, wheelhouse: &Path, target: &Path) -> Result<(), String> {
    let output = Command::new(python)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-index")
        .arg("--find-links")
        .arg(wheelhouse)
        .arg("--target")
        .arg(target)
        .arg("tracinator")
        .output()
        .map_err(|e| format!("failed to run the bundled interpreter's pip: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "bundled pip install failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Ensures a private, bundled Python + tracinator's own deps are ready to
/// run. Downloads nothing at runtime — everything comes from the resource
/// archive baked into the app bundle at build time. Skipped entirely (after
/// the first successful run) via a version-keyed marker file, so an app
/// update re-bootstraps but a normal relaunch doesn't redo the work.
pub async fn ensure_server_runtime(handle: &AppHandle) -> Result<ServerRuntime, String> {
    let runtime_resource = runtime_resource_path();
    let resource_path = handle
        .path()
        .resolve(runtime_resource, BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());

    let Some(resource_path) = resource_path else {
        log::warn!(
            "{runtime_resource} not found (run infra/scripts/build_desktop_runtime.sh) — \
             falling back to the dev .venv; this is not a distributable build"
        );
        return Ok(ServerRuntime {
            python: dev_fallback_python(),
            pythonpath: None,
        });
    };

    let app_data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let version = handle.package_info().version.to_string();
    let runtime_dir = app_data_dir.join("runtime");
    let marker_path = app_data_dir.join(format!("runtime-{version}.ok"));
    let site_packages = runtime_dir.join("site-packages");
    let python = runtime_dir.join(bundled_python_rel());

    if !marker_path.exists() {
        if let Some(splash) = handle.get_webview_window("splashscreen") {
            let _ =
                splash.eval("document.getElementById('status').textContent = 'Setting up…';");
        }

        let runtime_dir = runtime_dir.clone();
        let python = python.clone();
        let site_packages = site_packages.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if runtime_dir.exists() {
                fs::remove_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
            }
            fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
            unzip(&resource_path, &runtime_dir)?;
            install_site_packages(&python, &runtime_dir.join("wheelhouse"), &site_packages)
        })
        .await
        .map_err(|e| format!("bootstrap task panicked: {e}"))??;

        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
        fs::write(&marker_path, &version).map_err(|e| e.to_string())?;
    }

    Ok(ServerRuntime {
        python,
        pythonpath: Some(site_packages),
    })
}
