//! The dashboard child, end to end, against stand-ins for gnomon and, when
//! `GNOMON_DESKTOP_TEST_CLI` names one, against the real CLI.
//!
//! The stand-ins print what `gnomon dashboard` prints (dashboard.ts) and then
//! wait, or fail the way its exit codes say, so the start/read/stop path is
//! exercised on every OS without Node.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use gnomon_desktop_core::dashboard::{DashboardProcess, StartError, StartOptions};

const B: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

/// These tests write a script and then run it. In parallel, one test's fork
/// can inherit another's still-open script and that exec fails with ETXTBSY
/// ("Text file busy"), so they take turns. (The app never writes what it runs.)
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Write a stand-in gnomon into `dir` whose `dashboard` prints `lines`, then
/// either sleeps (exit = None) or exits with `exit`.
fn stand_in(dir: &Path, lines: &[String], exit: Option<i32>) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("gnomon");
        let mut s = String::from("#!/bin/sh\n");
        // The arguments it was given and where, for the test to check.
        s.push_str("echo \"$@\" > \"$0.args\"; pwd > \"$0.cwd\"\n");
        if exit.is_none() {
            // A child of its own, like node under a launcher: stopping must
            // reach it too. Started (and its pid written beside the script)
            // before the link is printed, so the test can never stop the
            // server before the child exists.
            s.push_str("sleep 60 & echo $! > \"$0.child\"\n");
        }
        for l in lines {
            s.push_str(&format!("printf '%s\\n' '{l}'\n"));
        }
        match exit {
            None => s.push_str("wait\n"),
            Some(code) => s.push_str(&format!("echo 'stand-in failing' >&2\nexit {code}\n")),
        }
        std::fs::write(&p, s).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }
    #[cfg(windows)]
    {
        let p = dir.join("gnomon.cmd");
        let mut s = String::from("@echo off\r\n");
        // Redirect first: `echo ... 0> file` would read the 0 as a handle.
        s.push_str("> \"%~f0.args\" echo %*\r\n> \"%~f0.cwd\" cd\r\n");
        for l in lines {
            if l.is_empty() {
                s.push_str("echo.\r\n");
            } else {
                s.push_str(&format!("echo {l}\r\n"));
            }
        }
        match exit {
            None => s.push_str("ping -n 60 127.0.0.1 >nul\r\n"),
            Some(code) => s.push_str(&format!("echo stand-in failing 1>&2\r\nexit /b {code}\r\n")),
        }
        std::fs::write(&p, s).unwrap();
        p
    }
}

fn path_env() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

fn cli_lines(port: u16) -> Vec<String> {
    vec![
        format!("gnomon dashboard - read-only - this machine only (127.0.0.1:{port})"),
        String::new(),
        format!("  http://127.0.0.1:{port}/#k={B}"),
        String::new(),
        "  The link signs one browser tab in, once, within 5 minutes.".into(),
    ]
}

fn opts(program: PathBuf, project: &Path, timeout: Duration) -> StartOptions {
    StartOptions {
        program,
        project: project.to_path_buf(),
        path_env: path_env(),
        timeout,
    }
}

#[test]
fn reads_the_link_and_stops_the_server_with_everything_it_started() {
    let _serial = serial();
    let bin = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let g = stand_in(bin.path(), &cli_lines(43123), None);
    let exited = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&exited);
    let (mut d, link) = DashboardProcess::start(
        &opts(g.clone(), project.path(), Duration::from_secs(20)),
        move || flag.store(true, Ordering::SeqCst),
    )
    .expect("started");
    assert_eq!(link.port(), 43123);
    assert_eq!(d.port(), 43123);
    assert_eq!(link.url(), format!("http://127.0.0.1:43123/#k={B}"));
    assert!(d.exited().is_none(), "still running");

    // It ran `dashboard --no-open --port 0 --dir <project>` in the project.
    let args = std::fs::read_to_string(format!("{}.args", g.display())).unwrap();
    assert!(
        args.trim()
            .starts_with("dashboard --no-open --port 0 --dir "),
        "{args}"
    );
    let cwd = std::fs::read_to_string(format!("{}.cwd", g.display())).unwrap();
    let real_project = std::fs::canonicalize(project.path()).unwrap();
    let real_cwd = std::fs::canonicalize(cwd.trim()).unwrap();
    assert_eq!(real_cwd, real_project);

    let started = Instant::now();
    d.stop();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(d.exited().is_some(), "stopped");
    // on_exit fires once stdout closes, which needs the whole tree gone.
    let until = Instant::now() + Duration::from_secs(10);
    while !exited.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        exited.load(Ordering::SeqCst),
        "on_exit ran: nothing holds the server's stdout"
    );

    #[cfg(unix)]
    {
        let child: i32 = std::fs::read_to_string(format!("{}.child", g.display()))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut gone = false;
        for _ in 0..100 {
            // SAFETY: signal 0 only probes.
            if unsafe { libc::kill(child, 0) } != 0 {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "the server's own child {child} outlived the stop");
    }
}

#[test]
fn dropping_it_stops_it() {
    let _serial = serial();
    let bin = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let g = stand_in(bin.path(), &cli_lines(43124), None);
    let exited = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&exited);
    let (d, _) = DashboardProcess::start(
        &opts(g, project.path(), Duration::from_secs(20)),
        move || flag.store(true, Ordering::SeqCst),
    )
    .unwrap();
    drop(d);
    let until = Instant::now() + Duration::from_secs(10);
    while !exited.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(exited.load(Ordering::SeqCst));
}

#[test]
fn an_exit_before_the_link_is_reported_with_its_contract_code() {
    let _serial = serial();
    let bin = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let g = stand_in(
        bin.path(),
        &["gnomon dashboard: cannot listen".to_string()],
        Some(4),
    );
    match DashboardProcess::start(&opts(g, project.path(), Duration::from_secs(20)), || {}) {
        Err(StartError::Exited { code, stderr }) => {
            assert_eq!(code, Some(4));
            assert!(stderr.contains("stand-in failing"), "{stderr}");
            let msg = StartError::Exited { code, stderr }.to_string();
            assert!(msg.contains("preconditions_unmet"), "{msg}");
        }
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("started"),
    }
}

#[test]
fn no_link_in_time_is_a_timeout_and_nothing_is_left_running() {
    let _serial = serial();
    let bin = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let lines = vec!["  http://localhost:8080/#k=AbCdEfGhIjKlMnOpQrStUvWxYz012345".to_string()];
    let g = stand_in(bin.path(), &lines, None);
    let started = Instant::now();
    match DashboardProcess::start(&opts(g, project.path(), Duration::from_millis(800)), || {}) {
        Err(StartError::NoLink { .. }) => {}
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("a localhost link must not be accepted"),
    }
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn a_missing_program_is_a_spawn_error() {
    let _serial = serial();
    let project = tempfile::tempdir().unwrap();
    let missing = project.path().join("no-such-gnomon");
    assert!(matches!(
        DashboardProcess::start(
            &opts(missing, project.path(), Duration::from_secs(5)),
            || {}
        ),
        Err(StartError::Spawn(_))
    ));
}

/// The real CLI. Opt in with GNOMON_DESKTOP_TEST_CLI=<path to gnomon>: it
/// starts `gnomon dashboard` for an empty temp folder, signs in over HTTP with
/// the link read from the pipe exactly as the page does, checks a second use
/// of the same link is refused, and checks the port is closed after stop.
#[test]
fn the_real_cli_signs_in_once_and_stops() {
    let _serial = serial();
    let Some(cli) = std::env::var_os("GNOMON_DESKTOP_TEST_CLI") else {
        eprintln!("skipped: set GNOMON_DESKTOP_TEST_CLI to run against a real gnomon");
        return;
    };
    let project = tempfile::tempdir().unwrap();
    let program = PathBuf::from(cli);
    let path = gnomon_desktop_core::cli::child_path(
        &program,
        &std::env::split_paths(&path_env()).collect::<Vec<_>>(),
    );
    let o = StartOptions {
        program,
        project: project.path().to_path_buf(),
        path_env: path,
        timeout: Duration::from_secs(60),
    };
    let (mut d, link) = DashboardProcess::start(&o, || {}).unwrap_or_else(|e| panic!("{e}"));
    let port = d.port();
    assert_ne!(port, 0);
    assert_ne!(port, 4890, "the app asks for --port 0, never a fixed port");

    let bootstrap = link.url().split("#k=").nth(1).unwrap().to_string();
    let (status, body) = post_auth(port, &bootstrap);
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"token\""), "{body}");
    let (status, _) = post_auth(port, &bootstrap);
    assert_eq!(status, 401, "a bootstrap works once");

    d.stop();
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
        "port {port} still open after stop"
    );
}

/// POST /auth the way the page does, with the headers the server checks.
fn post_auth(port: u16, bootstrap: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let body = format!("{{\"bootstrap\":\"{bootstrap}\"}}");
    let req = format!(
        "POST /auth HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Sec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    let status = out
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    // Never print the token: the body is only checked for the field's name.
    (
        status,
        if body.contains("\"token\"") {
            "{\"token\": <redacted>}".into()
        } else {
            body
        },
    )
}
