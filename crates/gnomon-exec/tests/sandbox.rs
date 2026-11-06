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

/// Fifth review: gnomon's state under the root is read-only to the command
/// where the kernel can say so (macOS); Linux's Landlock cannot take a
/// subtree back out of a granted root, and the probe says so rather than
/// pretend.
#[test]
fn readonly_paths_under_the_root_are_refused_where_the_kernel_can() {
    require_sandbox!(true);
    let s = scene();
    let surface = s.root.join(".gnomon");
    std::fs::create_dir(&surface).unwrap();
    std::fs::write(surface.join("policy.toml"), "exec = \"os\"\n").unwrap();
    let out = Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .arg("--write")
        .arg(&s.tmp)
        .arg("--readonly")
        .arg(&surface)
        .args(["--network", "on", "--", "/bin/sh", "-c"])
        .arg(format!("echo off > {}/policy.toml; echo ok > {}/work.txt", sh_quote(&surface), sh_quote(&s.root)))
        .current_dir(&s.root)
        .output()
        .expect("spawn gnomon-exec sandbox");
    assert_eq!(std::fs::read_to_string(s.root.join("work.txt")).unwrap(), "ok\n", "{out:?}");
    let enforced = probe()["readonly_enforced"].as_bool().unwrap();
    assert_eq!(enforced, cfg!(target_os = "macos"));
    if enforced {
        assert_eq!(std::fs::read_to_string(surface.join("policy.toml")).unwrap(), "exec = \"os\"\n", "{out:?}");
    }
}

/// Sixth review, finding 3: where `--readonly` is enforced, a read-only
/// path's parent below the root cannot be renamed away from it (`mv .git
/// .git-old && mkdir .git`), while files inside that parent stay writable.
#[test]
fn a_readonly_paths_parent_cannot_be_renamed_where_the_kernel_can() {
    require_sandbox!(true);
    if !probe()["readonly_enforced"].as_bool().unwrap() {
        return;
    }
    let s = scene();
    let git = s.root.join(".git");
    std::fs::create_dir(&git).unwrap();
    std::fs::write(git.join("config"), "[core]\n").unwrap();
    let out = Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .arg("--write")
        .arg(&s.tmp)
        .arg("--readonly")
        .arg(git.join("config"))
        .args(["--network", "on", "--", "/bin/sh", "-c"])
        .arg(format!(
            "echo x > {g}/index; mv {g} {r}/.git-old; mkdir -p {g}; echo ok > {r}/work.txt",
            g = sh_quote(&git),
            r = sh_quote(&s.root)
        ))
        .current_dir(&s.root)
        .output()
        .expect("spawn gnomon-exec sandbox");
    assert_eq!(std::fs::read_to_string(s.root.join("work.txt")).unwrap(), "ok\n", "{out:?}");
    assert!(!s.root.join(".git-old").exists(), ".git was renamed: {out:?}");
    assert_eq!(std::fs::read_to_string(git.join("config")).unwrap(), "[core]\n");
    assert_eq!(std::fs::read_to_string(git.join("index")).unwrap(), "x\n", "files inside .git stay writable: {out:?}");
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

/// `--network none`: what gnomon's own git runs under (third review,
/// finding 9). Off, AND no loopback: a filter a command planted could
/// otherwise hand what it read to a listener the command left running.
#[test]
fn network_none_refuses_loopback_that_off_allows() {
    require_sandbox!(true);
    require_tool!("python3");
    let (port, _h) = local_server();
    let s = scene();
    let script = format!(
        "python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://127.0.0.1:{port}/\", timeout=5).read().decode().strip())'"
    );
    let none = Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .args(["--network", "none", "--", "/bin/sh", "-c", &script])
        .current_dir(&s.root)
        .output()
        .expect("spawn gnomon-exec sandbox");
    assert!(!none.status.success(), "{none:?}");
    assert!(!String::from_utf8_lossy(&none.stdout).contains("local"), "{none:?}");
    assert!(
        String::from_utf8_lossy(&none.stderr).contains(&format!("blocked connect to 127.0.0.1:{port}")),
        "{none:?}"
    );
    // CONTROL: the same connect under --network off reaches the server.
    let off = sandboxed(&s, false, &script);
    assert!(off.status.success(), "{off:?}");
    assert_eq!(String::from_utf8_lossy(&off.stdout).trim(), "local");
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
        // Asked outside the sandbox with the same HOME: a pip in the user site
        // of the real HOME is not this test's subject.
        if Command::new("python3").args(["-m", "pip", "--version"]).env("HOME", &home).output().is_ok_and(|o| o.status.success()) {
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

// ── review fixes (PR #156): temp-dir cleanup, unix sockets, env, signals, /dev ──

/// A unix-socket server at `path` (pathname) that answers "outside\n" to every
/// connection, for as long as the returned handle lives.
#[cfg(target_os = "linux")]
fn unix_server(path: &Path) -> std::thread::JoinHandle<()> {
    let l = std::os::unix::net::UnixListener::bind(path).unwrap();
    l.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match l.accept() {
                Ok((mut c, _)) => {
                    let _ = c.write_all(b"outside\n");
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    })
}

#[cfg(target_os = "linux")]
const UNIX_CLIENT: &str = "python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sys.argv[1]); print(\"REPLY:\" + s.recv(64).decode().strip())'";

#[test]
#[cfg(target_os = "linux")]
fn a_unix_socket_outside_the_sandbox_is_refused_under_either_network_mode() {
    // The systemd-run --user escape: a daemon on a socket outside the root acts
    // for whoever connects. The server here stands in for that daemon.
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let sock = s.outside.join("daemon.sock");
    let _h = unix_server(&sock);
    for network in [false, true] {
        let out = sandboxed(&s, network, &format!("{UNIX_CLIENT} {}", sh_quote(&sock)));
        let t = text(&out);
        assert!(!t.contains("REPLY:outside"), "network={network}: reached a daemon outside the sandbox: {t}");
        assert!(t.contains("blocked connect to unix socket"), "network={network}: {t}");
    }
    // Control: the same client, unsandboxed, reaches it -- so the refusal above is the sandbox's.
    let out = Command::new("sh").arg("-c").arg(format!("{UNIX_CLIENT} {}", sh_quote(&sock))).output().unwrap();
    assert!(text(&out).contains("REPLY:outside"), "control: {}", text(&out));
}

#[test]
#[cfg(target_os = "linux")]
fn a_unix_socket_inside_the_root_still_works() {
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    for (network, name) in [(false, "a.sock"), (true, "b.sock")] {
        let sock = s.root.join(name);
        let _h = unix_server(&sock);
        // Relative, from the root: resolved against the caller's cwd.
        let out = sandboxed(&s, network, &format!("{UNIX_CLIENT} {name}"));
        assert!(text(&out).contains("REPLY:outside"), "network={network}: {}", text(&out));
    }
}

#[test]
#[cfg(target_os = "linux")]
fn a_symlink_in_the_root_to_an_outside_socket_is_refused() {
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let sock = s.outside.join("d.sock");
    let _h = unix_server(&sock);
    std::os::unix::fs::symlink(&sock, s.root.join("link.sock")).unwrap();
    let out = sandboxed(&s, true, &format!("{UNIX_CLIENT} link.sock"));
    assert!(!text(&out).contains("REPLY:outside"), "{}", text(&out));
}

#[test]
#[cfg(target_os = "linux")]
fn an_abstract_unix_socket_is_refused() {
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let name = format!("gnomon-test-{}", std::process::id());
    let l = std::os::unix::net::UnixListener::bind_addr(
        &<std::os::unix::net::SocketAddr as std::os::linux::net::SocketAddrExt>::from_abstract_name(name.as_bytes()).unwrap(),
    )
    .unwrap();
    l.set_nonblocking(true).unwrap();
    let client = format!(
        "python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(\"\\0{name}\"); print(\"CONNECTED\")'"
    );
    for network in [false, true] {
        let out = sandboxed(&s, network, &client);
        assert!(!text(&out).contains("CONNECTED"), "network={network}: {}", text(&out));
    }
    let out = Command::new("sh").arg("-c").arg(&client).output().unwrap();
    assert!(text(&out).contains("CONNECTED"), "control: {}", text(&out));
}

#[test]
#[cfg(target_os = "linux")]
fn bus_agent_and_multiplexer_variables_are_not_inherited() {
    require_sandbox!(false);
    let s = scene();
    for network in [false, true] {
        if !network && skip_reason(true).is_some() {
            continue;
        }
        let out = Command::new(bin())
            .args(["sandbox", "--root"])
            .arg(&s.root)
            .arg("--write")
            .arg(&s.tmp)
            .args(["--network", if network { "on" } else { "off" }, "--", "/bin/sh", "-c", "env"])
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/0/bus")
            .env("SSH_AUTH_SOCK", "/tmp/ssh-x/agent.1")
            .env("TMUX", "/tmp/tmux-0/default,1,0")
            .env("XDG_RUNTIME_DIR", "/run/user/0")
            .env("GNOMON_KEEP_ME", "1")
            .current_dir(&s.root)
            .output()
            .unwrap();
        let env = String::from_utf8_lossy(&out.stdout);
        for gone in ["DBUS_SESSION_BUS_ADDRESS=", "SSH_AUTH_SOCK=", "TMUX=", "XDG_RUNTIME_DIR="] {
            assert!(!env.lines().any(|l| l.starts_with(gone)), "{gone} leaked: {env}");
        }
        assert!(env.contains("GNOMON_KEEP_ME=1"), "an ordinary variable must pass: {env}");
    }
}

#[test]
#[cfg(target_os = "linux")]
fn signals_do_not_reach_a_process_outside_the_call_on_abi_6() {
    require_sandbox!(false);
    if probe()["landlock_abi"].as_i64().unwrap_or(0) < 6 {
        eprintln!("SKIPPED: Landlock ABI < 6 has no signal scoping");
        return;
    }
    let s = scene();
    let mut victim = Command::new("sleep").arg("30").spawn().unwrap();
    for network in [false, true] {
        if !network && skip_reason(true).is_some() {
            continue;
        }
        let out = sandboxed(&s, network, &format!("kill -TERM {} && echo SENT; sleep 0.2 & kill $! && echo OWN-OK", victim.id()));
        let t = text(&out);
        assert!(!t.contains("SENT"), "network={network}: signalled a process outside the sandbox: {t}");
        assert!(t.contains("OWN-OK"), "network={network}: its own child must stay signallable: {t}");
    }
    assert!(victim.try_wait().unwrap().is_none(), "the outside process was killed");
    let _ = victim.kill();
    let _ = victim.wait();
}

#[test]
#[cfg(target_os = "linux")]
fn scoped_reads_do_not_grant_dev_shm() {
    require_sandbox!(false);
    require_scoped!();
    let s = scene();
    let home = fake_home(&s);
    if !Path::new("/dev/shm").is_dir() {
        eprintln!("SKIPPED: no /dev/shm here");
        return;
    }
    let out = scoped_in(&s, &home, true, &[], "ls /dev/shm >/dev/null && echo SHM-LISTED; head -c 4 /dev/urandom | wc -c");
    let t = text(&out);
    assert!(!t.contains("SHM-LISTED"), "{t}");
    assert!(t.contains('4'), "/dev/urandom and /dev/null must stay usable: {t}");
}

// ── sandbox-clean ──

/// A tree like a per-call temp dir after a hostile command: a real
/// subdirectory, a symlink to the victim, and a symlink to a victim FILE.
#[cfg(unix)]
fn hostile_tmp(s: &Scene) -> PathBuf {
    let t = s.tmp.join("call");
    std::fs::create_dir_all(t.join("d/deeper")).unwrap();
    std::fs::write(t.join("d/f"), "x").unwrap();
    std::fs::write(t.join("d/deeper/g"), "x").unwrap();
    std::os::unix::fs::symlink(&s.outside, t.join("s")).unwrap();
    std::os::unix::fs::symlink(s.outside.join("keep.txt"), t.join("f-link")).unwrap();
    std::os::unix::fs::symlink(&s.outside, t.join("d/inner-link")).unwrap();
    t
}

#[test]
#[cfg(unix)]
fn sandbox_clean_empties_the_dir_and_follows_no_link() {
    let s = scene();
    let t = hostile_tmp(&s);
    let out = Command::new(bin()).arg("sandbox-clean").arg(&t).output().unwrap();
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(std::fs::read_dir(&t).unwrap().count(), 0, "the temp dir is emptied");
    assert!(t.is_dir(), "the dir itself is left for the caller's rmdir");
    intact(&s);
}

#[test]
#[cfg(target_os = "linux")]
fn sandbox_clean_survives_a_directory_swapped_for_a_symlink_mid_removal() {
    // The PoC: a job left running exchanges a full directory with a symlink to
    // the victim (renameat2 RENAME_EXCHANGE) while the cleaner works. An
    // unsandboxed `rm -rf` lost hundreds of the victim's files to this.
    let s = scene();
    let victim = s.outside.join("victim");
    let mut lost = 0;
    for _ in 0..20 {
        std::fs::create_dir_all(&victim).unwrap();
        for i in 0..100 {
            std::fs::write(victim.join(format!("f{i}")), "v").unwrap();
        }
        let t = s.tmp.join("race");
        std::fs::create_dir_all(t.join("d")).unwrap();
        for i in 0..100 {
            std::fs::write(t.join(format!("d/f{i}")), "x").unwrap();
        }
        let _ = std::fs::remove_file(t.join("s"));
        std::os::unix::fs::symlink(&victim, t.join("s")).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (tt, st) = (t.clone(), stop.clone());
        let racer = std::thread::spawn(move || {
            let d = std::ffi::CString::new(tt.join("d").as_os_str().as_encoded_bytes()).unwrap();
            let l = std::ffi::CString::new(tt.join("s").as_os_str().as_encoded_bytes()).unwrap();
            while !st.load(std::sync::atomic::Ordering::Relaxed) {
                // SAFETY: renameat2(AT_FDCWD, d, AT_FDCWD, s, RENAME_EXCHANGE).
                unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, d.as_ptr(), libc::AT_FDCWD, l.as_ptr(), 2u32) };
            }
        });
        std::thread::sleep(Duration::from_millis(20));
        let _ = Command::new(bin()).arg("sandbox-clean").arg(&t).output().unwrap();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        racer.join().unwrap();
        lost += 100 - std::fs::read_dir(&victim).unwrap().count();
        let _ = std::fs::remove_file(t.join("s"));
        let _ = std::fs::remove_file(t.join("d"));
        let _ = std::fs::remove_dir_all(&t);
    }
    assert_eq!(lost, 0, "sandbox-clean deleted {lost} files outside the temp dir");
}

// ── second review (PR #156): C, D, E, I, fail-closed, sandbox-kill ──

/// renameat2(RENAME_EXCHANGE) of `a` and `b`, in a loop, until `stop`.
#[cfg(target_os = "linux")]
fn swapper(a: PathBuf, b: PathBuf, stop: std::sync::Arc<std::sync::atomic::AtomicBool>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let a = std::ffi::CString::new(a.as_os_str().as_encoded_bytes()).unwrap();
        let b = std::ffi::CString::new(b.as_os_str().as_encoded_bytes()).unwrap();
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            // SAFETY: renameat2(AT_FDCWD, a, AT_FDCWD, b, RENAME_EXCHANGE).
            unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), 2u32) };
        }
    })
}

/// A unix server that counts the connections it accepts.
#[cfg(target_os = "linux")]
fn counting_server(path: &Path, secs: u64) -> (std::sync::Arc<std::sync::atomic::AtomicUsize>, std::thread::JoinHandle<()>) {
    let l = std::os::unix::net::UnixListener::bind(path).unwrap();
    l.set_nonblocking(true).unwrap();
    let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    let h = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            match l.accept() {
                Ok((mut c, _)) => {
                    n2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let _ = c.write_all(b"x\n");
                }
                Err(_) => std::thread::sleep(Duration::from_millis(1)),
            }
        }
    });
    (n, h)
}

#[test]
#[cfg(target_os = "linux")]
fn c_a_directory_swapped_for_a_symlink_never_reaches_an_outside_socket() {
    // Second review, C: the supervisor canonicalised the path and then
    // connected BY PATH, so a directory swapped for a symlink in between
    // reached the daemon outside. Now the socket is opened O_PATH with no
    // symlink on the way and connected through the descriptor.
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let real = s.root.join("x");
    std::fs::create_dir(&real).unwrap();
    let (inside, _hi) = counting_server(&real.join("s.sock"), 20);
    let (outside_hits, _ho) = counting_server(&s.outside.join("s.sock"), 20);
    std::os::unix::fs::symlink(&s.outside, s.root.join("y")).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sw = swapper(real.clone(), s.root.join("y"), stop.clone());
    let client = format!(
        "python3 -c 'import socket\nfor _ in range(400):\n s=socket.socket(socket.AF_UNIX)\n try:\n  s.connect(\"{}\")\n except OSError:\n  pass\n s.close()\nprint(\"DONE\")'",
        real.join("s.sock").display()
    );
    let out = sandboxed(&s, false, &client);
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    sw.join().unwrap();
    assert!(text(&out).contains("DONE"), "{}", text(&out));
    let reached = outside_hits.load(std::sync::atomic::Ordering::Relaxed);
    assert_eq!(reached, 0, "{reached} connect(s) reached the socket outside the sandbox through the swap");
    assert!(inside.load(std::sync::atomic::Ordering::Relaxed) > 0, "the inside socket must stay reachable");
}

#[test]
#[cfg(target_os = "linux")]
fn c_a_server_bound_by_a_relative_name_is_refused() {
    // Peer::Unknown is refused: getpeername cannot place it.
    require_sandbox!(true);
    require_tool!("python3");
    let s = scene();
    let server = "import socket,os,time\ns=socket.socket(socket.AF_UNIX); s.bind(\"rel.sock\"); s.listen(4); time.sleep(5)";
    let mut srv = Command::new("python3").arg("-c").arg(server).current_dir(&s.root).spawn().unwrap();
    for _ in 0..100 {
        if s.root.join("rel.sock").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = sandboxed(&s, true, &format!("{UNIX_CLIENT} rel.sock"));
    let _ = srv.kill();
    let _ = srv.wait();
    assert!(text(&out).contains("cannot be named"), "{}", text(&out));
}

#[test]
#[cfg(unix)]
fn d_sandbox_clean_refuses_a_temp_dir_swapped_for_a_symlink() {
    // Second review, D: with the temp dir's PARENT writable, the dir itself
    // can become a symlink to $HOME before the clean. It was canonicalised,
    // so $HOME was emptied.
    use std::os::unix::fs::MetadataExt;
    let s = scene();
    let t = s.tmp.join("call");
    std::fs::create_dir(&t).unwrap();
    let m = std::fs::metadata(&t).unwrap();
    let (dev, ino) = (m.dev().to_string(), m.ino().to_string());
    // The command swaps it: the real dir moves aside, a link to the victim takes its name.
    std::fs::rename(&t, s.tmp.join("aside")).unwrap();
    std::os::unix::fs::symlink(&s.outside, &t).unwrap();
    let out = Command::new(bin()).args(["sandbox-clean"]).arg(&t).args(["--dev", &dev, "--ino", &ino]).output().unwrap();
    assert!(!out.status.success(), "a symlinked temp dir must be refused: {}", text(&out));
    intact(&s);
    // A different real directory under the recorded name: identity mismatch.
    std::fs::remove_file(&t).unwrap();
    std::fs::create_dir(&t).unwrap();
    std::fs::write(t.join("other"), "o").unwrap();
    let out = Command::new(bin()).args(["sandbox-clean"]).arg(&t).args(["--dev", &dev, "--ino", &ino]).output().unwrap();
    assert!(!out.status.success(), "{}", text(&out));
    assert!(text(&out).contains("not the directory gnomon made"), "{}", text(&out));
    assert!(t.join("other").exists(), "a directory gnomon did not make is left alone");
    // A symlink HIGHER up the path is refused too (Linux: RESOLVE_NO_SYMLINKS).
    #[cfg(target_os = "linux")]
    {
        std::os::unix::fs::symlink(&s.tmp, s.root.join("tlink")).unwrap();
        let aside = std::fs::metadata(s.tmp.join("aside")).unwrap();
        let out = Command::new(bin())
            .arg("sandbox-clean")
            .arg(s.root.join("tlink/aside"))
            .args(["--dev", &aside.dev().to_string(), "--ino", &aside.ino().to_string()])
            .output()
            .unwrap();
        assert!(!out.status.success(), "{}", text(&out));
    }
    // The right directory, by its own path: cleaned.
    std::fs::write(s.tmp.join("aside/junk"), "j").unwrap();
    let aside = std::fs::metadata(s.tmp.join("aside")).unwrap();
    let out = Command::new(bin())
        .arg("sandbox-clean")
        .arg(s.tmp.join("aside"))
        .args(["--dev", &aside.dev().to_string(), "--ino", &aside.ino().to_string()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(std::fs::read_dir(s.tmp.join("aside")).unwrap().count(), 0);
}

#[test]
#[cfg(target_os = "linux")]
fn e_scoped_reads_cannot_open_another_terminal() {
    // Second review, E: /dev/pts was readable and writable under scoped reads,
    // so another terminal's input could be read. A pty the test opens stands
    // in for the operator's other terminal.
    require_sandbox!(false);
    require_scoped!();
    require_tool!("python3");
    let s = scene();
    let home = fake_home(&s);
    // SAFETY: posix_openpt / grantpt / unlockpt / ptsname on a fresh master.
    let (master, slave) = unsafe {
        let m = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        assert!(m >= 0);
        assert_eq!(libc::grantpt(m), 0);
        assert_eq!(libc::unlockpt(m), 0);
        let p = std::ffi::CStr::from_ptr(libc::ptsname(m)).to_string_lossy().into_owned();
        (m, p)
    };
    let probe = format!("python3 -c 'import os; os.open(\"{slave}\", os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK); print(\"OPENED\")'");
    let out = scoped_in(&s, &home, true, &[], &probe);
    assert!(!text(&out).contains("OPENED"), "another terminal was opened under scoped reads: {}", text(&out));
    // Control: unsandboxed, it opens.
    let out = Command::new("sh").arg("-c").arg(&probe).output().unwrap();
    assert!(text(&out).contains("OPENED"), "control: {}", text(&out));
    // SAFETY: closed once.
    unsafe { libc::close(master) };
}

#[test]
#[cfg(target_os = "linux")]
fn i_the_kernel_keyring_is_refused() {
    require_sandbox!(false);
    require_tool!("python3");
    let s = scene();
    // keyctl(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 0)
    let script = format!(
        "python3 -c 'import ctypes; c=ctypes.CDLL(None, use_errno=True); r=c.syscall({}, 0, -3, 0); print(\"R=%d E=%d\" % (r, ctypes.get_errno()))'",
        libc::SYS_keyctl
    );
    for network in [false, true] {
        if !network && skip_reason(true).is_some() {
            continue;
        }
        let out = sandboxed(&s, network, &script);
        assert!(text(&out).contains(&format!("R=-1 E={}", libc::EPERM)), "network={network}: {}", text(&out));
    }
    // Control: unsandboxed, keyctl is not refused with EPERM.
    let out = Command::new("sh").arg("-c").arg(&script).output().unwrap();
    assert!(!text(&out).contains(&format!("R=-1 E={}", libc::EPERM)), "control: {}", text(&out));
}

/// Children of `pid`, from /proc.
#[cfg(target_os = "linux")]
fn children_of(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    for e in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(p) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(st) = std::fs::read_to_string(format!("/proc/{p}/stat")) else { continue };
        let Some(rest) = st.rfind(')').map(|i| &st[i + 2..]) else { continue };
        if rest.split_whitespace().nth(1).and_then(|v| v.parse::<u32>().ok()) == Some(pid) {
            out.push(p);
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| s.rfind(')').map(|i| !s[i + 2..].starts_with('Z')).unwrap_or(false))
        .unwrap_or(false)
}

#[test]
#[cfg(target_os = "linux")]
fn the_command_dies_with_its_supervisor() {
    // Fail-closed gap: a supervisor that died left the command running,
    // unsupervised and unreaped.
    require_sandbox!(true);
    let s = scene();
    let mut g = Command::new(bin())
        .args(["sandbox", "--root"])
        .arg(&s.root)
        .args(["--network", "off", "--", "/bin/sh", "-c", "echo $$ > cmd.pid; exec sleep 30"])
        .current_dir(&s.root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut cmd = 0u32;
    for _ in 0..200 {
        if let Some(p) = std::fs::read_to_string(s.root.join("cmd.pid")).ok().and_then(|t| t.trim().parse().ok()) {
            cmd = p;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(cmd > 0, "the command never started");
    let sup = children_of(g.id());
    assert_eq!(sup.len(), 1, "one supervisor under gnomon-exec: {sup:?}");
    // SAFETY: SIGKILL to the supervisor this test started.
    unsafe { libc::kill(sup[0] as i32, libc::SIGKILL) };
    let st = g.wait().unwrap();
    assert_eq!(st.code(), Some(125), "gnomon-exec reports the lost supervisor as a refusal");
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(cmd) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let still = alive(cmd);
    if still {
        // SAFETY: cleaning up the orphan this test caused.
        unsafe { libc::kill(cmd as i32, libc::SIGKILL) };
    }
    assert!(!still, "the command outlived its supervisor");
}

#[test]
#[cfg(target_os = "linux")]
fn report_fd_names_the_supervisor_and_the_command_cannot_write_it() {
    use std::os::unix::process::CommandExt;
    require_sandbox!(true);
    let s = scene();
    let mut fds = [0i32; 2];
    // SAFETY: a plain pipe.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let w = fds[1];
    let mut c = Command::new(bin());
    c.args(["sandbox", "--root"])
        .arg(&s.root)
        .args(["--network", "off", "--report-fd", "3", "--", "/bin/sh", "-c", "echo PPID=$PPID; echo forged >&3 && echo WROTE"])
        .current_dir(&s.root);
    // SAFETY: dup2 in the child before exec.
    unsafe {
        c.pre_exec(move || {
            if libc::dup2(w, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let out = c.output().unwrap();
    // SAFETY: the parent's copy of the write end, closed once.
    unsafe { libc::close(w) };
    let mut buf = String::new();
    // SAFETY: the read end, owned from here.
    let mut r = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[0]) };
    r.read_to_string(&mut buf).unwrap();
    let t = text(&out);
    assert!(!t.contains("WROTE"), "the command wrote the report fd: {t}");
    let ppid = t.lines().find_map(|l| l.strip_prefix("PPID=")).unwrap_or("").trim().to_string();
    assert!(ppid.parse::<u32>().is_ok(), "the command did not run: {t}");
    assert_eq!(buf.split_whitespace().next().unwrap_or(""), ppid, "the reported pid is the command's parent, the supervisor: {buf:?} vs {t}");
    assert!(buf.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) > 0, "and its start time: {buf:?}");
}

#[test]
#[cfg(target_os = "linux")]
fn sandbox_kill_signals_a_job_an_earlier_call_started_and_nothing_else() {
    require_sandbox!(true);
    let s = scene();
    // Call 1 starts a server-like job and says who its supervisor is ($PPID
    // of the shell) and the job's pid.
    let out = sandboxed(&s, false, "echo SUP=$PPID; sleep 30 >/dev/null 2>&1 & echo JOB=$!");
    let t = text(&out);
    let get = |k: &str| t.lines().find_map(|l| l.strip_prefix(k)).and_then(|v| v.trim().parse::<i32>().ok()).unwrap();
    let (sup, job) = (get("SUP="), get("JOB="));
    let start = std::fs::read_to_string(format!("/proc/{sup}/stat")).unwrap();
    let start: u64 = start[start.rfind(')').unwrap() + 2..].split_whitespace().nth(19).unwrap().parse().unwrap();
    // Call 2 cannot (ABI 6 scoping) -- the reason the escape hatch exists.
    if probe()["landlock_abi"].as_i64().unwrap_or(0) >= 6 {
        let out = sandboxed(&s, false, &format!("kill {job} && echo KILLED"));
        assert!(!text(&out).contains("KILLED"), "{}", text(&out));
    }
    let mut victim = Command::new("sleep").arg("30").spawn().unwrap();
    let kill = |sups: &[String], pid: i32| {
        let mut c = Command::new(bin());
        c.arg("sandbox-kill");
        for s in sups {
            c.args(["--supervisor", s]);
        }
        c.args(["--", &pid.to_string(), "TERM"]).output().unwrap()
    };
    let me = vec![format!("{sup}:{start}")];
    // Refused: a process no sandboxed call started.
    let out = kill(&me, victim.id() as i32);
    assert!(!out.status.success(), "{}", text(&out));
    assert!(victim.try_wait().unwrap().is_none(), "an unrelated process was signalled");
    // Refused: the supervisor named with the wrong start time (a reused pid).
    let out = kill(&[format!("{sup}:{}", start + 1)], job);
    assert!(!out.status.success(), "{}", text(&out));
    assert!(alive(job as u32));
    // Refused: the supervisor itself.
    let out = kill(&me, sup);
    assert!(!out.status.success(), "{}", text(&out));
    // Signalled: the job.
    let out = kill(&me, job);
    assert!(out.status.success(), "{}", text(&out));
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(job as u32) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(job as u32), "the job survived sandbox-kill");
    let _ = victim.kill();
    let _ = victim.wait();
}
