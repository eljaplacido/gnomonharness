//! gnomon desktop's logic, without the window.
//!
//! The desktop app is a thin window over `gnomon dashboard` (CONTRACTS.md
//! §15): it finds the gnomon this machine has ([`cli`]), starts the dashboard
//! for a folder the user picked ([`project`], [`dashboard`]), reads the
//! one-use sign-in link from the child's stdout ([`link`]), shows only that
//! page or its own launcher ([`nav`]), and stops the server with the window
//! ([`spawn`]). It remembers recent folders in its own config dir
//! ([`settings`]). Everything here builds and tests without a webview; the
//! Tauri crate beside it (`src-tauri/`) is glue.

pub mod cli;
pub mod dashboard;
pub mod link;
pub mod nav;
pub mod project;
pub mod settings;
pub mod spawn;

/// Unit tests that write an executable and run it, or fork, take turns: a
/// fork can inherit another test's still-open script, whose exec then fails
/// with ETXTBSY ("Text file busy").
#[cfg(test)]
pub(crate) fn test_serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}
