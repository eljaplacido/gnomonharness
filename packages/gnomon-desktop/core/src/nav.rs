//! Where the window may go.
//!
//! Exactly two places: the launcher bundled into the app, and the dashboard
//! this app started, on `http://127.0.0.1:<its port>`. Every other navigation
//! is cancelled, and new windows and downloads are refused (main.rs), so the
//! window can never become a general browser: not for a link in a record, not
//! for a redirect, not for another local server on another port.
//!
//! The launcher's own origin differs by platform: Tauri serves bundled assets
//! as `tauri://localhost` on macOS and Linux and as `http://tauri.localhost` on
//! Windows (its default, `useHttpsScheme: false`).

use crate::link::LOOPBACK;

/// The launcher's URL on this platform, to navigate back to it.
pub fn launcher_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}

/// Is this the bundled launcher (the app's own assets)?
pub fn is_launcher(scheme: &str, host: Option<&str>) -> bool {
    matches!(
        (scheme, host),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

/// Is this the dashboard this app started?
pub fn is_dashboard(
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    dashboard_port: Option<u16>,
) -> bool {
    match (scheme, host, port, dashboard_port) {
        ("http", Some(h), Some(p), Some(d)) => h == LOOPBACK && p == d && d != 0,
        _ => false,
    }
}

/// The navigation policy. `whole` is the full URL, for `about:blank`, which
/// some webviews navigate to while a window is being set up: it has no origin
/// and nothing to talk to.
pub fn navigation_allowed(
    whole: &str,
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    dashboard_port: Option<u16>,
) -> bool {
    whole == "about:blank"
        || is_launcher(scheme, host)
        || is_dashboard(scheme, host, port, dashboard_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(scheme: &str, host: Option<&str>, port: Option<u16>, active: Option<u16>) -> bool {
        navigation_allowed("", scheme, host, port, active)
    }

    #[test]
    fn the_launcher_is_always_allowed() {
        assert!(allowed("tauri", Some("localhost"), None, None));
        assert!(allowed("http", Some("tauri.localhost"), Some(80), None));
        assert!(allowed(
            "https",
            Some("tauri.localhost"),
            Some(443),
            Some(9000)
        ));
    }

    #[test]
    fn the_dashboard_only_on_its_own_port() {
        assert!(allowed("http", Some("127.0.0.1"), Some(43123), Some(43123)));
        assert!(!allowed(
            "http",
            Some("127.0.0.1"),
            Some(43124),
            Some(43123)
        ));
        assert!(!allowed("http", Some("127.0.0.1"), Some(43123), None));
        assert!(!allowed("http", Some("127.0.0.1"), Some(0), Some(0)));
    }

    #[test]
    fn nothing_else() {
        let active = Some(43123);
        assert!(!allowed("http", Some("localhost"), Some(43123), active));
        assert!(!allowed("https", Some("127.0.0.1"), Some(43123), active));
        assert!(!allowed("ws", Some("127.0.0.1"), Some(43123), active));
        assert!(!allowed("https", Some("github.com"), Some(443), active));
        assert!(!allowed(
            "http",
            Some("tauri.localhost.evil.com"),
            Some(80),
            active
        ));
        assert!(!allowed("tauri", Some("evil"), None, active));
        assert!(!allowed("file", None, None, active));
        assert!(!allowed("data", None, None, active));
        assert!(!allowed("javascript", None, None, active));
        assert!(!navigation_allowed(
            "about:srcdoc",
            "about",
            None,
            None,
            active
        ));
    }

    #[test]
    fn about_blank_is_inert_and_allowed() {
        assert!(navigation_allowed("about:blank", "about", None, None, None));
    }

    #[test]
    fn the_launcher_url_is_a_launcher() {
        let u = launcher_url();
        let (scheme, rest) = u.split_once("://").unwrap();
        let host = rest.trim_end_matches('/');
        assert!(is_launcher(scheme, Some(host)));
    }
}
