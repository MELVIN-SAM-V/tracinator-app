// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // WebKitGTK >=2.42's default DMA-BUF renderer assumes it can share GPU
  // buffers directly with the compositor via GBM/DRI — a real render node
  // (/dev/dri/renderD*) is required for that handshake to work at all. Under
  // WSLg (and VMs/remote desktops generally) that node is frequently absent
  // even when the rest of the GPU passthrough stack (compute, D3D12) is
  // fine, and WebKit doesn't fall back gracefully: it silently drops to a
  // far slower path where even trivial paints (e.g. a button's :hover)
  // visibly lag. Must be set before WebKit's process-wide GL state
  // initializes, i.e. before app_lib::run() creates the first webview — an
  // env var set from within Rust once a window exists is too late. Confirmed
  // against this exact symptom: identical UI was smooth in a native browser
  // hitting the same backend, laggy only inside this webview, with
  // libEGL/MESA "failed to create dri2 screen" warnings on launch.
  #[cfg(target_os = "linux")]
  std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

  app_lib::run();
}
