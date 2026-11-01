//! `gnomon-exec sandbox`, run as the real binary against real scratch trees.
//!
//! Every destructive command here targets a directory this file created inside
//! its own `tempfile::TempDir`, and asserts on the state of that directory
//! afterwards -- never on the command's text, and never on a path it did not
//! make.
//!
//! Each blocking test would FAIL without the sandbox: it asserts the outside
//! file still exists (or the supervisor's own blocked-connect line was
//! printed), which a plain `sh -c` would not leave behind.
//!
//! SKIPS. A kernel without Landlock (older than 5.13, or with it left out of
//! the boot-time LSM list) cannot run any of this, and CI runners differ. Each
//! such test prints `SKIPPED: <reason from sandbox-probe>` and returns, so a
//! skip is visible in `cargo test -- --nocapture` and never reads as a pass of
//! the property. Tests needing python3 or curl skip the same way without them.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

/// The binary under test. `GNOMON_EXEC_UNDER_TEST` swaps in another one -- the
/// negative control: point it at a wrapper that runs the command WITHOUT a
/// sandbox (and answers `sandbox-probe` as supported), and every test that
/// claims a block must fail. That run is how "would fail without the sandbox"
/// was checked rather than asserted; see the PR that added this file.
fn bin() -> String {
    std::env::var("GNOMON_EXEC_UNDER_TEST").unwrap_or_else(|_| env!("CARGO_BIN_EXE_gnomon-exec").to_string())
}

fn probe() -> Value {
    let out = Command::new(bin()).arg("sandbox-probe").output().expect("run sandbox-probe");
    assert!(out.status.success(), "sandbox-probe failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("sandbox-probe prints JSON")
}

/// None when the sandbox can run here; Some(reason) when the test must skip.
fn skip_reason(need_network: bool) -> Option<String> {
    let p = probe();
    let key = if need_network { "network_supported" } else { "supported" };
    if p[key].as_bool() == Some(true) {
        return None;
    }
    Some(p["reason"].as_str().unwrap_or("sandbox unsupported on this platform").to_string())
}

macro_rules! require_sandbox {
    ($net:expr) => {
        if let Some(why) = skip_reason($net) {
            eprintln!("SKIPPED: {}", why);
            return;
        }
    };
}

fn have(tool: &str) -> bool {
    Command::new("sh").arg("-c").arg(format!("command -v {tool}")).output().map(|o| o.status.success()).unwrap_or(false)
}

macro_rules! require_tool {
    ($t:expr) => {
        if !have($t) {
            eprintln!("SKIPPED: {} is not installed", $t);
            return;
        }
    };
}

/// A project root and a sibling "outside" directory holding a file to protect.
struct Scene {
    _dir: tempfile::TempDir,
    root: PathBuf,
    tmp: PathBuf,
    outside: PathBuf,
}

fn scene() -> Scene {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let tmp = dir.path().join("tmp");
    let outside = dir.path().join("outside");
    for d in [&root, &tmp, &outside] {
        std::fs::create_dir(d).unwrap();
    }
    std::fs::write(outside.join("keep.txt"), "keep").unwrap();
    std::fs::create_dir(outside.join("sub")).unwrap();
    std::fs::write(outside.join("sub").join("deep.txt"), "deep").unwrap();
    Scene { _dir: dir, root, tmp, outside }
}

fn sandboxed(s: &Scene, network: bool, script: &str) -> Output {
    Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .arg("--write")
        .arg(&s.tmp)
        .args(["--network", if network { "on" } else { "off" }, "--", "/bin/sh", "-c", script])
        .current_dir(&s.root)
        .output()
        .expect("spawn gnomon-exec sandbox")
}

fn sh_quote(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', "'\\''"))
}

fn intact(s: &Scene) {
    assert_eq!(std::fs::read_to_string(s.outside.join("keep.txt")).unwrap(), "keep");
    assert_eq!(std::fs::read_to_string(s.outside.join("sub/deep.txt")).unwrap(), "deep");
}

// ── filesystem ──

#[test]
fn writing_outside_the_root_is_refused_by_the_kernel() {
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        let target = s.outside.join("escaped.txt");
        let out = sandboxed(&s, net, &format!("echo x > {}", sh_quote(&target)));
        assert!(!target.exists(), "network={net}: the write landed outside the root");
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("Permission denied"), "{out:?}");
    }
}

#[test]
fn rm_rf_outside_the_root_deletes_nothing() {
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        let out = sandboxed(&s, net, &format!("rm -rf {}", sh_quote(&s.outside)));
        intact(&s);
        assert!(!out.status.success(), "rm reported success: {out:?}");
    }
}

#[test]
fn python_rmtree_outside_the_root_deletes_nothing() {
    // The case no text rule can see: no `rm` anywhere in the command.
    require_sandbox!(false);
    require_tool!("python3");
    let s = scene();
    let out = sandboxed(
        &s,
        false,
        &format!("python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' {}", sh_quote(&s.outside)),
    );
    intact(&s);
    assert!(String::from_utf8_lossy(&out.stderr).contains("PermissionError"), "{out:?}");
}

#[test]
fn moving_a_file_out_of_the_root_or_linking_one_in_is_refused() {
    require_sandbox!(false);
    let s = scene();
    std::fs::write(s.root.join("mine.txt"), "mine").unwrap();
    let out = sandboxed(
        &s,
        true,
        &format!(
            "mv mine.txt {o}/moved.txt; ln -s /etc/passwd {o}/link; mv {o}/keep.txt ./stolen.txt; true",
            o = sh_quote(&s.outside)
        ),
    );
    assert!(s.root.join("mine.txt").exists(), "{out:?}");
    assert!(!s.outside.join("moved.txt").exists());
    assert!(!s.outside.join("link").exists());
    intact(&s);
}

#[test]
fn writing_inside_the_root_and_the_temp_dir_works() {
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        let out = sandboxed(
            &s,
            net,
            &format!(
                "mkdir -p a/b && echo in > a/b/f.txt && mv a/b/f.txt a/g.txt && rm -rf a/b && \
                 echo t > {t}/scratch && echo n > /dev/null && echo done",
                t = sh_quote(&s.tmp)
            ),
        );
        assert!(out.status.success(), "network={net}: {out:?}");
        assert_eq!(std::fs::read_to_string(s.root.join("a/g.txt")).unwrap(), "in\n");
        assert!(!s.root.join("a/b").exists());
        assert!(s.tmp.join("scratch").exists());
    }
}

#[test]
fn reads_stay_allowed_everywhere() {
    require_sandbox!(false);
    let s = scene();
    let out = sandboxed(&s, false, &format!("cat {}/keep.txt && ls / >/dev/null", sh_quote(&s.outside)));
    assert!(out.status.success(), "{out:?}");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "keep");
}

#[test]
fn setuid_cannot_raise_privilege_inside() {
    // no_new_privs: a setuid binary (sudo, su, pkexec) runs with the caller's
    // privileges, so nothing inside can become root. Read from the kernel's
    // own report rather than by running sudo, whose failure without a password
    // would pass this test on an unsandboxed host too.
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        let out = sandboxed(&s, net, "grep NoNewPrivs /proc/self/status");
        let so = String::from_utf8_lossy(&out.stdout);
        if cfg!(target_os = "linux") {
            assert!(so.split_whitespace().eq(["NoNewPrivs:", "1"]), "network={net}: {so}");
        }
    }
}

// ── exit status and process shape ──

#[test]
fn the_command_exit_status_passes_through() {
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        assert_eq!(sandboxed(&s, net, "exit 7").status.code(), Some(7), "network={net}");
        assert_eq!(sandboxed(&s, net, "true").status.code(), Some(0));
        assert_eq!(sandboxed(&s, net, "no-such-command-xyz").status.code(), Some(127));
    }
}

#[cfg(unix)]
#[test]
fn a_command_killed_by_a_signal_is_reported_as_one() {
    use std::os::unix::process::ExitStatusExt;
    require_sandbox!(false);
    for net in [true, false] {
        let s = scene();
        let out = sandboxed(&s, net, "kill -TERM $$");
        assert_eq!(out.status.signal(), Some(15), "network={net}: {:?}", out.status);
    }
}

#[test]
fn it_returns_when_the_shell_does_not_when_a_background_job_does() {
    // The supervisor outlives the shell for as long as a job it backgrounded
    // runs, but the process the caller waits on must not.
    require_sandbox!(true);
    let s = scene();
    let t = Instant::now();
    let out = sandboxed(&s, false, "sleep 3 >/dev/null 2>&1 & echo started");
    assert!(out.status.success());
    assert!(t.elapsed() < Duration::from_millis(2500), "waited {:?} for a background job", t.elapsed());
}

// ── refusals ──

#[test]
fn a_malformed_invocation_is_refused_never_run() {
    let s = scene();
    let marker = s.outside.join("ran.txt");
    let script = format!("echo ran > {}", sh_quote(&marker));
    let cases: Vec<Vec<String>> = vec![
        vec!["sandbox".into(), "--".into(), "/bin/sh".into(), "-c".into(), script.clone()],
        vec!["sandbox".into(), "--root".into(), s.root.join("missing").display().to_string(), "--".into(), "/bin/sh".into(), "-c".into(), script.clone()],
        vec!["sandbox".into(), "--root".into(), s.root.display().to_string(), "--network".into(), "maybe".into(), "--".into(), "/bin/sh".into(), "-c".into(), script.clone()],
        vec!["sandbox".into(), "--root".into(), s.root.display().to_string(), "--bogus".into(), "--".into(), "/bin/sh".into(), "-c".into(), script.clone()],
        vec!["sandbox".into(), "--root".into(), s.root.display().to_string(), "--".into()],
    ];
    for args in cases {
        let out = Command::new(bin()).args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(125), "{args:?}: {out:?}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("sandbox refused"), "{out:?}");
        assert!(!marker.exists(), "{args:?} ran the command");
    }
}

#[test]
fn the_probe_reports_what_this_kernel_enforces() {
    let p = probe();
    assert!(p["not_enforced"].as_array().is_some_and(|a| !a.is_empty()), "the limits must be published");
    if cfg!(target_os = "linux") {
        // Agree with the kernel directly rather than with the probe's own code.
        let lsm = std::fs::read_to_string("/sys/kernel/security/lsm").unwrap_or_default();
        if lsm.split(',').any(|m| m.trim() == "landlock") {
            assert_eq!(p["supported"], true, "{p}");
            assert!(p["landlock_abi"].as_i64().unwrap() >= 1);
        } else {
            assert_eq!(p["supported"], false, "{p}");
            assert!(p["reason"].as_str().is_some());
        }
    }
    if cfg!(not(any(target_os = "linux", target_os = "macos"))) {
        assert_eq!(p["supported"], false);
    }
}

// ── network ──

/// A loopback server that answers one line to every connection.
fn local_server() -> (u16, std::thread::JoinHandle<()>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let h = std::thread::spawn(move || {
        l.set_nonblocking(false).unwrap();
        // Serve until nothing has connected for a while.
        let deadline = Instant::now() + Duration::from_secs(10);
        for c in l.incoming() {
            if let Ok(mut c) = c {
                let mut buf = [0u8; 1024];
                let _ = c.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = c.read(&mut buf);
                let _ = c.write_all(b"HTTP/1.0 200 OK\r\ncontent-length: 6\r\n\r\nlocal\n");
            }
            if Instant::now() > deadline {
                break;
            }
        }
    });
    (port, h)
}

#[test]
fn network_off_blocks_egress_in_the_kernel() {
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    // A literal address, so no DNS is involved and the only thing that can
    // refuse it is the connect itself. The supervisor's line is the evidence:
    // an offline machine also fails this connect, but never prints it.
    // 192.0.2.1 is TEST-NET-1 (RFC 5737), never routed: the negative control
    // (no sandbox) times out instead of reaching a real host.
    let out = sandboxed(
        &s,
        false,
        "python3 -c 'import socket; socket.create_connection((\"192.0.2.1\", 80), timeout=5)'",
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{out:?}");
    assert!(err.contains("blocked connect to 192.0.2.1:80"), "{err}");
    assert!(err.contains("Permission denied"), "{err}");
}

#[test]
fn network_off_refuses_udp_and_raw_sockets_outright() {
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let out = sandboxed(
        &s,
        false,
        "python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM)' && echo UDP-OPENED; \
         python3 -c 'import socket; socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)' && echo UDP6-OPENED; \
         python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)' && echo ICMP-OPENED; \
         true",
    );
    let so = String::from_utf8_lossy(&out.stdout);
    assert!(!so.contains("OPENED"), "{so}");
}

#[test]
fn network_off_still_reaches_a_local_server() {
    require_sandbox!(true);
    require_tool!("python3");
    let (port, _h) = local_server();
    let s = scene();
    for host in ["127.0.0.1", "localhost"] {
        let out = sandboxed(
            &s,
            false,
            &format!(
                "python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://{host}:{port}/\", timeout=5).read().decode().strip())'"
            ),
        );
        assert!(out.status.success(), "{host}: {out:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "local");
    }
}

#[test]
fn network_off_curl_external_fails_and_local_succeeds() {
    require_sandbox!(true);
    require_tool!("curl");
    let (port, _h) = local_server();
    let s = scene();
    let out = sandboxed(&s, false, &format!("curl -sS --max-time 5 http://127.0.0.1:{port}/"));
    assert!(out.status.success(), "{out:?}");
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "local");

    let out = sandboxed(&s, false, "curl -sS --max-time 5 http://192.0.2.1/");
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("blocked connect to 192.0.2.1:80"), "{out:?}");
}

#[test]
fn a_backgrounded_job_keeps_loopback_after_the_shell_exits() {
    require_sandbox!(true);
    require_tool!("python3");
    let (port, _h) = local_server();
    let s = scene();
    let result = s.root.join("bg.txt");
    let out = sandboxed(
        &s,
        false,
        &format!(
            "(sleep 0.4; python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://127.0.0.1:{port}/\", timeout=5).read().decode().strip())' > bg.txt 2>&1) >/dev/null 2>&1 &"
        ),
    );
    assert!(out.status.success());
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if std::fs::read_to_string(&result).map(|s| s.contains("local")).unwrap_or(false) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("background job never reached the local server: {:?}", std::fs::read_to_string(&result));
}

#[test]
fn network_on_does_not_filter_sockets() {
    require_sandbox!(false);
    require_tool!("python3");
    let s = scene();
    let out = sandboxed(&s, true, "python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM)' && echo UDP-OK");
    assert!(String::from_utf8_lossy(&out.stdout).contains("UDP-OK"), "{out:?}");
}
