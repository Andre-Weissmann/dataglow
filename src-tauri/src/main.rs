// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// DATAGLOW desktop shell.
//
// This is deliberately the stock Tauri "vanilla" entry point: it opens the
// window declared in tauri.conf.json and loads the existing static site
// (frontendDist = "../"). No Rust-side commands are registered and no native
// APIs are exposed to the webview — the allowlist in tauri.conf.json is
// deny-by-default, so the window has only what a browser tab already has.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running DATAGLOW desktop shell");
}
