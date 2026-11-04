//! The sign-in link `gnomon dashboard` prints, read from the child's stdout.
//!
//! CONTRACTS.md §17: "The terminal prints `http://127.0.0.1:PORT/#k=<bootstrap>`.
//! The fragment never reaches a server. The page POSTs it once to `/auth` and
//! gets a bearer token. A bootstrap works once, and not after five minutes."
//!
//! The desktop app reads that line from the stdout pipe of the `gnomon
//! dashboard` it started itself: no file, no network call, nothing another
//! process on the machine can read. The parser is strict on purpose. Only the
//! loopback address the server binds is accepted (not `localhost`, which a
//! hosts file can point anywhere), the port must be a real one, and the
//! bootstrap must be the base64url alphabet the server mints, so a line that is
//! merely similar can never steer the window somewhere else.

use std::fmt;

/// The only host a sign-in link may name. `gnomon dashboard` binds here and
/// nowhere wider, and has no flag that widens it.
pub const LOOPBACK: &str = "127.0.0.1";

/// Shortest and longest bootstrap accepted. The server mints 24 random bytes
/// as base64url, 32 characters; the bounds leave room for a change of length
/// without accepting something that is plainly not a secret.
pub const BOOTSTRAP_MIN: usize = 16;
pub const BOOTSTRAP_MAX: usize = 128;

/// A parsed sign-in link. It holds a one-use secret, so its `Debug` output
/// redacts the bootstrap: the link goes to the webview and nowhere else.
#[derive(Clone, PartialEq, Eq)]
pub struct SignIn {
    port: u16,
    bootstrap: String,
}

impl SignIn {
    /// The dashboard's port on 127.0.0.1.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:PORT`, the one origin the window may show besides
    /// the bundled launcher.
    pub fn origin(&self) -> String {
        format!("http://{LOOPBACK}:{}", self.port)
    }

    /// The URL to load in the window. It carries the one-use bootstrap in the
    /// fragment; hand it to the webview, never to a log.
    pub fn url(&self) -> String {
        format!("http://{LOOPBACK}:{}/#k={}", self.port, self.bootstrap)
    }
}

impl fmt::Debug for SignIn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignIn")
            .field("port", &self.port)
            .field("bootstrap", &"<redacted>")
            .finish()
    }
}

fn is_bootstrap_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Read one line of the child's stdout. `Some` only for exactly
/// `http://127.0.0.1:<port>/#k=<bootstrap>`, surrounding whitespace allowed
/// (the CLI indents it, and Windows ends it with `\r\n`).
pub fn parse_sign_in_line(line: &str) -> Option<SignIn> {
    let s = line.trim();
    let rest = s.strip_prefix("http://127.0.0.1:")?;
    let (port_s, rest) = rest.split_once('/')?;
    if port_s.is_empty() || port_s.len() > 5 || port_s.starts_with('0') {
        return None;
    }
    if !port_s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u32 = port_s.parse().ok()?;
    if port == 0 || port > u32::from(u16::MAX) {
        return None;
    }
    let bootstrap = rest.strip_prefix("#k=")?;
    if !(BOOTSTRAP_MIN..=BOOTSTRAP_MAX).contains(&bootstrap.len()) {
        return None;
    }
    if !bootstrap.bytes().all(is_bootstrap_char) {
        return None;
    }
    Some(SignIn {
        port: port as u16,
        bootstrap: bootstrap.to_string(),
    })
}

/// The first sign-in link in a block of output, if any.
pub fn find_sign_in(output: &str) -> Option<SignIn> {
    output.lines().find_map(parse_sign_in_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // 32, like the server's

    /// What `gnomon dashboard` prints (dashboard.ts), byte for byte in shape.
    fn cli_output(port: u16) -> String {
        format!(
            "gnomon dashboard · read-only · this machine only (127.0.0.1:{port})\n\
             \n  http://127.0.0.1:{port}/#k={B}\n\n  The link signs one browser tab in, once, within 5 minutes.\n  \
             Ctrl-C stops the server.\n  Project: /tmp/p (no .gnomon/ yet)\n"
        )
    }

    #[test]
    fn reads_the_link_the_cli_prints() {
        let s = find_sign_in(&cli_output(43123)).expect("a link");
        assert_eq!(s.port(), 43123);
        assert_eq!(s.origin(), "http://127.0.0.1:43123");
        assert_eq!(s.url(), format!("http://127.0.0.1:43123/#k={B}"));
    }

    #[test]
    fn the_status_line_naming_the_port_is_not_a_link() {
        assert!(parse_sign_in_line(
            "gnomon dashboard · read-only · this machine only (127.0.0.1:43123)"
        )
        .is_none());
    }

    #[test]
    fn tolerates_indent_and_crlf() {
        assert!(parse_sign_in_line(&format!("  http://127.0.0.1:8080/#k={B}\r\n")).is_some());
        assert!(parse_sign_in_line(&format!("\thttp://127.0.0.1:8080/#k={B}")).is_some());
    }

    #[test]
    fn refuses_any_host_but_loopback_v4() {
        for host in [
            "localhost",
            "0.0.0.0",
            "127.0.0.2",
            "[::1]",
            "127.0.0.1.evil.com",
            "evil.com",
        ] {
            let line = format!("http://{host}:8080/#k={B}");
            assert!(parse_sign_in_line(&line).is_none(), "{line}");
        }
    }

    #[test]
    fn refuses_userinfo_and_other_schemes() {
        for line in [
            format!("http://127.0.0.1:8080@evil.com/#k={B}"),
            format!("https://127.0.0.1:8080/#k={B}"),
            format!("ws://127.0.0.1:8080/#k={B}"),
            format!("HTTP://127.0.0.1:8080/#k={B}"),
        ] {
            assert!(parse_sign_in_line(&line).is_none(), "{line}");
        }
    }

    #[test]
    fn refuses_bad_ports() {
        for port in [
            "0", "65536", "99999", "123456", "", "80a", "-1", "080", " 80",
        ] {
            let line = format!("http://127.0.0.1:{port}/#k={B}");
            assert!(parse_sign_in_line(&line).is_none(), "{line}");
        }
        assert_eq!(
            parse_sign_in_line(&format!("http://127.0.0.1:65535/#k={B}"))
                .unwrap()
                .port(),
            65535
        );
        assert_eq!(
            parse_sign_in_line(&format!("http://127.0.0.1:1/#k={B}"))
                .unwrap()
                .port(),
            1
        );
    }

    #[test]
    fn refuses_a_path_query_or_other_fragment() {
        for line in [
            format!("http://127.0.0.1:8080/x#k={B}"),
            format!("http://127.0.0.1:8080/?k={B}"),
            format!("http://127.0.0.1:8080/#t={B}"),
            format!("http://127.0.0.1:8080#k={B}"),
            format!("http://127.0.0.1:8080//#k={B}"),
        ] {
            assert!(parse_sign_in_line(&line).is_none(), "{line}");
        }
    }

    #[test]
    fn refuses_a_bootstrap_outside_the_alphabet_or_bounds() {
        for k in [
            "short",
            &"a".repeat(BOOTSTRAP_MAX + 1),
            "AbCdEfGhIjKlMnOp QrStUv",
            "AbCdEfGhIjKlMnOp&next=https://evil",
            "AbCdEfGhIjKlMnOp/../../x",
            "AbCdEfGhIjKlMnOp+QrStUvWx=",
            "AbCdEfGhIjKlMnOp\"onload",
        ] {
            let line = format!("http://127.0.0.1:8080/#k={k}");
            assert!(parse_sign_in_line(&line).is_none(), "{line}");
        }
        assert!(parse_sign_in_line(&format!(
            "http://127.0.0.1:8080/#k={}",
            "a".repeat(BOOTSTRAP_MIN)
        ))
        .is_some());
    }

    #[test]
    fn refuses_trailing_text() {
        assert!(parse_sign_in_line(&format!("http://127.0.0.1:8080/#k={B} and more")).is_none());
        assert!(parse_sign_in_line(&format!("open http://127.0.0.1:8080/#k={B}")).is_none());
    }

    #[test]
    fn debug_never_shows_the_bootstrap() {
        let s = parse_sign_in_line(&format!("http://127.0.0.1:8080/#k={B}")).unwrap();
        let shown = format!("{s:?}");
        assert!(!shown.contains(B), "{shown}");
        assert!(shown.contains("8080"));
    }

    #[test]
    fn the_first_link_wins() {
        let out = format!("http://127.0.0.1:1111/#k={B}\nhttp://127.0.0.1:2222/#k={B}\n");
        assert_eq!(find_sign_in(&out).unwrap().port(), 1111);
    }
}
