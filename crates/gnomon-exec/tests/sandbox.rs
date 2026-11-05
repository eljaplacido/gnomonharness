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

// ── reads = scoped ──
//
// Every credential here is a FAKE, planted in a fake HOME inside the test's own
// temp dir; HOME is set to it for the sandboxed command. No test reads, or
// tries to read, the real HOME's credentials.

/// A fake HOME holding planted (fake) credentials and typical tool caches.
fn fake_home(s: &Scene) -> PathBuf {
    let home = s.root.parent().unwrap().join("home");
    let put = |rel: &str, body: &str| {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    };
    put(".ssh/id_x", "FAKE-SSH-KEY-gnomon-test\n");
    put(".aws/credentials", "[default]\naws_secret_access_key = FAKE-AWS-gnomon-test\n");
    put(".config/gh/hosts.yml", "github.com:\n    oauth_token: FAKE-GH-gnomon-test\n");
    put(".cargo/credentials.toml", "[registry]\ntoken = \"FAKE-CARGO-gnomon-test\"\n");
    put("notes.txt", "FAKE-NOTES-gnomon-test\n");
    // Typical caches: readable under scoped reads.
    put(".cache/pip/http/cached", "pip-cache\n");
    put(".npm/_cacache/index", "npm-cache\n");
    put(".cargo/registry/index/entry", "cargo-registry\n");
    put(".gitconfig", "[user]\n\tname = Test\n\temail = test@example.invalid\n");
    home
}

fn scoped_in(s: &Scene, home: &Path, network: bool, reads: &[&Path], script: &str) -> Output {
    let mut c = Command::new(bin());
    c.args(["sandbox", "--root"]).arg(&s.root).arg("--write").arg(&s.tmp);
    c.args(["--network", if network { "on" } else { "off" }, "--reads", "scoped"]);
    for r in reads {
        c.arg("--read").arg(r);
    }
    c.args(["--", "/bin/sh", "-c", script]).current_dir(&s.root).env("HOME", home).env("TMPDIR", &s.tmp);
    c.output().expect("spawn gnomon-exec sandbox")
}

fn all_in(s: &Scene, home: &Path, script: &str) -> Output {
    Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .arg("--write")
        .arg(&s.tmp)
        .args(["--network", "on", "--", "/bin/sh", "-c", script])
        .current_dir(&s.root)
        .env("HOME", home)
        .output()
        .expect("spawn gnomon-exec sandbox")
}

fn require_scoped() -> Option<String> {
    let p = probe();
    if p["reads_scoped_supported"].as_bool() == Some(true) {
        return None;
    }
    Some(p["reason"].as_str().unwrap_or("reads = scoped is not supported on this platform").to_string())
}

macro_rules! require_scoped {
    () => {
        if let Some(why) = require_scoped() {
            eprintln!("SKIPPED: {}", why);
            return;
        }
    };
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

#[test]
fn scoped_reads_refuse_a_credential_in_home_and_the_control_reads_it() {
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    // The control first: the same command under reads = all reads the fake
    // key. Without it, a refusal below could be a typo in the path.
    let ctl = all_in(&s, &home, "cat ~/.ssh/id_x");
    assert!(text(&ctl).contains("FAKE-SSH-KEY"), "control must read it: {ctl:?}");
    for net in [true, false] {
        for (what, script) in [
            ("cat", "cat ~/.ssh/id_x"),
            ("aws", "cat ~/.aws/credentials"),
            ("gh", "cat ~/.config/gh/hosts.yml"),
            ("cargo creds", "cat ~/.cargo/credentials.toml"),
            ("a plain file in HOME", "cat ~/notes.txt"),
            ("grep -r HOME", "grep -rh FAKE ~ 2>&1"),
        ] {
            let out = scoped_in(&s, &home, net, &[], script);
            let t = text(&out);
            assert!(!t.contains("FAKE-"), "{what} (network {net}) read a planted secret: {t}");
            assert!(t.contains("Permission denied"), "{what} (network {net}) failed for another reason: {t}");
        }
        let out = scoped_in(&s, &home, net, &[], "ls ~");
        assert!(!out.status.success() && text(&out).contains("Permission denied"), "listing HOME: {out:?}");
    }
}

#[test]
fn scoped_reads_refuse_python_open_of_a_credential() {
    require_scoped!();
    require_tool!("python3");
    let s = scene();
    let home = fake_home(&s);
    let py = "python3 -c 'import os; print(open(os.path.expanduser(\"~/.ssh/id_x\")).read())'";
    let ctl = all_in(&s, &home, py);
    assert!(text(&ctl).contains("FAKE-SSH-KEY"), "control: {ctl:?}");
    for net in [true, false] {
        let out = scoped_in(&s, &home, net, &[], py);
        let t = text(&out);
        assert!(!t.contains("FAKE-SSH-KEY"), "{t}");
        assert!(t.contains("PermissionError"), "{t}");
    }
}

#[cfg(unix)]
#[test]
fn scoped_reads_follow_no_link_out_of_scope() {
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    std::os::unix::fs::symlink(home.join(".ssh/id_x"), s.root.join("lnk")).unwrap();
    let out = scoped_in(&s, &home, true, &[], "cat lnk");
    assert!(!text(&out).contains("FAKE-SSH-KEY") && text(&out).contains("Permission denied"), "symlink: {out:?}");
    // A hard link made from inside would give the key the root's read right;
    // Landlock refuses the link itself (EXDEV), so nothing is created.
    let out = scoped_in(&s, &home, true, &[], "ln ~/.ssh/id_x hl; cat hl");
    assert!(!text(&out).contains("FAKE-SSH-KEY"), "hard link: {out:?}");
    assert!(!s.root.join("hl").exists(), "the hard link was created");
}

#[test]
fn scoped_reads_cannot_execute_outside_the_scope() {
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    std::fs::create_dir_all(home.join("bin")).unwrap();
    std::fs::copy("/bin/true", home.join("bin/mytrue")).unwrap();
    let out = scoped_in(&s, &home, true, &[], "~/bin/mytrue");
    assert_eq!(out.status.code(), Some(126), "exec needs a read: {out:?}");
    // Granted with --read, it runs.
    let out = scoped_in(&s, &home, true, &[&home.join("bin")], "~/bin/mytrue");
    assert!(out.status.success(), "{out:?}");
}

#[test]
fn scoped_reads_leave_ordinary_tools_and_caches_working() {
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    for net in [true, false] {
        // System paths, the root, the temp dir, the typical caches and git's own config.
        let out = scoped_in(
            &s,
            &home,
            net,
            &[],
            "head -c1 /etc/passwd >/dev/null && echo hi > f && cat f && echo t > \"$TMPDIR/x\" && cat \"$TMPDIR/x\" \
             && cat ~/.cache/pip/http/cached ~/.npm/_cacache/index ~/.cargo/registry/index/entry \
             && git config --global user.name",
        );
        assert!(out.status.success(), "network {net}: {out:?}");
        let t = String::from_utf8_lossy(&out.stdout).to_string();
        for want in ["hi", "t", "pip-cache", "npm-cache", "cargo-registry", "Test"] {
            assert!(t.lines().any(|l| l == want), "missing {want:?}: {t}");
        }
    }
    if have("git") {
        let out = scoped_in(
            &s,
            &home,
            false,
            &[],
            "git init -q r && cd r && echo x > a && git add a && git commit -qm m && git log --oneline | wc -l",
        );
        assert!(out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "1", "git: {out:?}");
    }
    if have("python3") {
        let out = scoped_in(&s, &home, false, &[], "python3 -c 'import json, ssl, sqlite3, subprocess; print(\"py-ok\")'");
        assert!(text(&out).contains("py-ok"), "python3: {out:?}");
        let pip = scoped_in(&s, &home, false, &[], "python3 -m pip --version");
        if Command::new("python3").args(["-m", "pip", "--version"]).output().is_ok_and(|o| o.status.success()) {
            assert!(pip.status.success(), "pip: {pip:?}");
        }
    }
    if have("cc") {
        let out = scoped_in(
            &s,
            &home,
            false,
            &[],
            "printf 'int main(void){return 0;}' > \"$TMPDIR/a.c\" && cc \"$TMPDIR/a.c\" -o \"$TMPDIR/a\" && \"$TMPDIR/a\" && echo cc-ok",
        );
        assert!(text(&out).contains("cc-ok"), "cc: {out:?}");
    }
    if have("node") {
        // node is often installed under the real HOME (nvm): gnomon passes the
        // runtime's prefix as a --read, and so does this test.
        let node = String::from_utf8(Command::new("sh").args(["-c", "readlink -f \"$(command -v node)\""]).output().unwrap().stdout).unwrap();
        let prefix = Path::new(node.trim()).parent().and_then(|p| p.parent()).unwrap().to_path_buf();
        if exposes_home(&prefix) {
            eprintln!("SKIPPED node: its prefix {} is HOME or above it", prefix.display());
        } else {
            let out = scoped_in(&s, &home, false, &[&prefix], "node -e 'console.log(\"node-ok\")'");
            assert!(text(&out).contains("node-ok"), "node: {out:?}");
        }
    }
}

/// A --read of this path would be refused because it covers a home directory.
fn exposes_home(p: &Path) -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.starts_with(p)
}

#[test]
fn a_grant_that_would_expose_a_credential_is_refused_never_run() {
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    let marker = s.outside.join("ran.txt");
    let script = format!("echo ran > {}", sh_quote(&marker));
    let base = |root: &Path| -> Vec<String> {
        vec!["sandbox".into(), "--root".into(), root.display().to_string(), "--reads".into(), "scoped".into()]
    };
    let tail = |mut v: Vec<String>| -> Vec<String> {
        v.extend(["--".into(), "/bin/sh".into(), "-c".into(), script.clone()]);
        v
    };
    let cases: Vec<Vec<String>> = vec![
        tail([base(&s.root), vec!["--read".into(), home.display().to_string()]].concat()),
        tail([base(&s.root), vec!["--read".into(), home.join(".cargo").display().to_string()]].concat()),
        tail([base(&s.root), vec!["--read".into(), home.join(".ssh").display().to_string()]].concat()),
        tail([base(&s.root), vec!["--write".into(), home.display().to_string()]].concat()),
        tail(base(&home)),
        tail([base(&s.root), vec!["--read".into(), "/".into()]].concat()),
    ];
    for args in cases {
        let out = Command::new(bin()).args(&args).env("HOME", &home).output().unwrap();
        assert_eq!(out.status.code(), Some(125), "{args:?}: {out:?}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("cannot keep"), "{out:?}");
        assert!(!marker.exists(), "{args:?} ran the command");
    }
}

#[test]
fn a_malformed_read_scope_is_refused_never_run() {
    let s = scene();
    let marker = s.outside.join("ran.txt");
    let script = format!("echo ran > {}", sh_quote(&marker));
    let root = s.root.display().to_string();
    let cases: Vec<Vec<String>> = vec![
        vec!["--reads".into(), "maybe".into()],
        vec!["--read".into(), s.tmp.display().to_string()],
        vec!["--reads".into(), "scoped".into(), "--read".into(), s.root.join("missing").display().to_string()],
    ];
    for extra in cases {
        let mut args: Vec<String> = vec!["sandbox".into(), "--root".into(), root.clone()];
        args.extend(extra.clone());
        args.extend(["--".into(), "/bin/sh".into(), "-c".into(), script.clone()]);
        let out = Command::new(bin()).args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(125), "{extra:?}: {out:?}");
        assert!(!marker.exists(), "{extra:?} ran the command");
    }
}

#[test]
fn the_probe_publishes_the_read_scope_and_its_limits() {
    let p = probe();
    let lim = p["scoped_not_enforced"].as_array().expect("scoped limits are published");
    assert!(lim.iter().any(|l| l.as_str().unwrap_or("").contains("/etc")), "/etc stays readable, and says so: {p}");
    if cfg!(target_os = "linux") {
        assert_eq!(p["reads_scoped_supported"], p["supported"], "{p}");
        if p["supported"] == true {
            let reads: Vec<&str> = p["scoped_reads"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
            assert!(reads.contains(&"/usr") && reads.contains(&"/etc"), "{reads:?}");
            let prot: Vec<&str> = p["scoped_protected"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
            assert!(prot.iter().any(|q| q.ends_with("/.ssh")), "{prot:?}");
        }
    } else {
        assert_eq!(p["reads_scoped_supported"], false);
    }
}
