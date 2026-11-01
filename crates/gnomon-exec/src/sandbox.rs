//! `gnomon-exec sandbox`: run one command under a kernel-enforced sandbox.
//!
//! This is what `[sandbox] exec = "os"` runs every `bash` command through. It
//! exists because the bash rules (`bash_deny` / `bash_allow`) read the TEXT of
//! a command, and no reading of text is complete: `python3 -c
//! 'import shutil; shutil.rmtree("/elsewhere")'` contains no `rm` for a rule to
//! match. G2b measured exactly that class. A rule over text is an intent filter;
//! this is containment, enforced by the kernel on whatever the command turns
//! out to execute.
//!
//! THE POLICY, the same on every platform that has one:
//!   - Reads and execution are allowed everywhere, so system tools work.
//!   - Writes (create, modify, truncate, delete, rename, link, mkdir, mknod)
//!     are allowed only beneath the project root, the per-call temp directory
//!     and any `--write` directory the caller names, plus the handful of device
//!     files every program expects to write (/dev/null and friends).
//!   - `--network off`: no egress. Loopback stays reachable, because a local
//!     server is not egress -- `curl http://localhost:3000/health` is how a
//!     developer, or a test, checks a server it started.
//!
//! HOW, per platform:
//!   - Linux: Landlock for the filesystem; for `--network off`, a seccomp
//!     filter plus a small supervisor process. See `linux` below.
//!   - macOS: `sandbox-exec` with a generated SBPL profile. See `macos`.
//!   - Anything else: REFUSED, exit 125, with the reason. Never run unsandboxed:
//!     a sandbox that silently degrades to "off" is the failure this repository
//!     keeps finding in its own history (docs/SANDBOX-DESIGN.md).
//!
//! WHAT IT DOES NOT DO is stated in `NOT_ENFORCED` and printed by `probe`, so a
//! caller can show the operator the limits rather than imply there are none.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The wrapper's own failure, distinct from anything the command returns.
/// 125 is what `env`, `docker run` and `podman run` use for the same thing:
/// "the wrapper could not run the command", as opposed to 126 (found, not
/// executable) and 127 (not found), which the shell already owns.
pub const SANDBOX_REFUSED: i32 = 125;

/// What the caller asked for.
#[derive(Debug, Clone)]
pub struct Policy {
    /// The project root: writable, recursively.
    pub root: PathBuf,
    /// Further writable directories: the per-call temp dir, `extra_roots`.
    pub writable: Vec<PathBuf>,
    /// May the command reach hosts other than this one?
    pub network: bool,
}

/// What this machine can enforce, for `gnomon-exec sandbox-probe`.
#[derive(Debug, Serialize)]
pub struct Probe {
    pub platform: &'static str,
    /// Can `sandbox` run a command here at all?
    pub supported: bool,
    /// Can it run one with `--network off`?
    pub network_supported: bool,
    /// "landlock", "landlock+seccomp", "seatbelt", or "none".
    pub mechanism: String,
    /// Linux only: the Landlock ABI version the kernel reports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landlock_abi: Option<i32>,
    /// Why `supported` (or `network_supported`) is false, in words an operator
    /// can act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Guarantees this kernel cannot give, beyond the general limits.
    pub degraded: Vec<String>,
    /// The general limits: true on every platform, published so nobody reads
    /// more containment into `os` than is there.
    pub not_enforced: Vec<&'static str>,
}

/// The limits of this sandbox, said once, here, and printed by `probe`.
pub const NOT_ENFORCED: &[&str] = &[
    "reads: the command can read any file your user can (secrets in $HOME included)",
    "writes inside the root: .gnomon/, .git/ and every other file under the project root stay writable",
    "unix sockets: a daemon reachable over one (the docker socket, the systemd user bus via systemd-run, a running tmux) can act outside the sandbox",
    "loopback: a local service that itself reaches the network (a proxy, a DNS resolver) is reachable",
    "inbound: a server the command binds on a non-loopback address accepts connections",
    "signals: the command can signal other processes your user owns",
    "already-open descriptors: anything inherited is used as inherited",
];

/// Print `msg` as the wrapper's refusal and exit 125. Never returns.
pub fn refuse(msg: &str) -> ! {
    eprintln!("gnomon-exec: sandbox refused: {msg}");
    std::process::exit(SANDBOX_REFUSED);
}

/// Canonical, absolute, existing directory -- or a refusal.
///
/// Canonical because both backends match on real paths: a symlinked root (or
/// macOS's /tmp -> /private/tmp) granted by its link name would grant nothing.
fn canonical_dir(p: &Path, what: &str) -> Result<PathBuf, String> {
    let c = std::fs::canonicalize(p).map_err(|e| format!("{what} {} cannot be resolved: {e}", p.display()))?;
    if !c.is_dir() {
        return Err(format!("{what} {} is not a directory", c.display()));
    }
    Ok(c)
}

impl Policy {
    /// Resolve every path to its canonical form, refusing on any that fails.
    pub fn canonical(&self) -> Result<Policy, String> {
        Ok(Policy {
            root: canonical_dir(&self.root, "--root")?,
            writable: self
                .writable
                .iter()
                .map(|w| canonical_dir(w, "--write"))
                .collect::<Result<_, _>>()?,
            network: self.network,
        })
    }

    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    pub fn writable_dirs(&self) -> Vec<&Path> {
        std::iter::once(self.root.as_path()).chain(self.writable.iter().map(|p| p.as_path())).collect()
    }
}

/// Run `argv` under `policy`. Never returns: it execs the command, or exits
/// with the command's status, or refuses with 125.
pub fn run(policy: &Policy, argv: &[String]) -> ! {
    if argv.is_empty() {
        refuse("no command given after `--`");
    }
    let policy = match policy.canonical() {
        Ok(p) => p,
        Err(e) => refuse(&e),
    };
    platform::run(&policy, argv)
}

pub fn probe() -> Probe {
    platform::probe()
}

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use unsupported as platform;

// ─────────────────────────────────────────────
// Unsupported platforms
// ─────────────────────────────────────────────

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod unsupported {
    use super::*;

    const WHY: &str = "no OS sandbox is implemented for this platform. \
        On Windows, run gnomon inside WSL2 (Landlock is available there on a 5.13+ kernel), \
        or set [sandbox] exec = \"docker\", or exec = \"off\" to run bash unsandboxed on purpose";

    pub fn probe() -> Probe {
        Probe {
            platform: std::env::consts::OS,
            supported: false,
            network_supported: false,
            mechanism: "none".into(),
            landlock_abi: None,
            reason: Some(WHY.into()),
            degraded: vec![],
            not_enforced: NOT_ENFORCED.to_vec(),
        }
    }

    pub fn run(_policy: &Policy, _argv: &[String]) -> ! {
        refuse(WHY)
    }
}

// ─────────────────────────────────────────────
// macOS: sandbox-exec (Seatbelt)
// ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::unix::process::CommandExt;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    pub fn probe() -> Probe {
        let present = Path::new(SANDBOX_EXEC).is_file();
        Probe {
            platform: "macos",
            supported: present,
            network_supported: present,
            mechanism: if present { "seatbelt".into() } else { "none".into() },
            landlock_abi: None,
            reason: (!present).then(|| format!("{SANDBOX_EXEC} is missing")),
            degraded: vec![],
            not_enforced: NOT_ENFORCED.to_vec(),
        }
    }

    /// An SBPL string literal. Paths are the only values interpolated, and a
    /// path may contain `"` or `\`.
    fn lit(p: &Path) -> String {
        let s = p.to_string_lossy();
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// The profile. `(allow default)`, then deny every write, then re-allow
    /// writes beneath the granted directories. In SBPL a later matching rule
    /// overrides an earlier one, so the order is the policy.
    pub fn profile(policy: &Policy) -> String {
        let mut p = String::from("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n");
        for d in policy.writable_dirs() {
            p.push_str(&format!("  (subpath {})\n", lit(d)));
        }
        for dev in ["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper", "/dev/ptmx"] {
            p.push_str(&format!("  (literal \"{dev}\")\n"));
        }
        p.push_str("  (regex #\"^/dev/fd/[0-9]+$\")\n  (regex #\"^/dev/ttys[0-9]+$\"))\n");
        if !policy.network {
            // Bazel's darwin sandbox, verbatim (--sandbox_block_network).
            // A fifth line, `(allow network-bind (local ip "*:*"))`, was
            // tried so a server binding every interface could start; on
            // macos-latest CI, curl to 192.0.2.1 then hung instead of being
            // refused. So a server under network = false on macOS must bind
            // loopback, and the README says so.
            p.push_str(
                "(deny network*)\n\
                 (allow network* (local ip \"localhost:*\"))\n\
                 (allow network* (remote ip \"localhost:*\"))\n\
                 (allow network* (remote unix-socket))\n",
            );
        }
        p
    }

    pub fn run(policy: &Policy, argv: &[String]) -> ! {
        if !Path::new(SANDBOX_EXEC).is_file() {
            refuse(&format!("{SANDBOX_EXEC} is missing, so nothing can enforce the sandbox"));
        }
        let err = std::process::Command::new(SANDBOX_EXEC)
            .arg("-p")
            .arg(profile(policy))
            .args(argv)
            .exec();
        refuse(&format!("could not exec {SANDBOX_EXEC}: {err}"))
    }
}

// ─────────────────────────────────────────────
// Linux: Landlock (+ seccomp and a supervisor for --network off)
// ─────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub mod linux {
    //! FILESYSTEM -- Landlock. A ruleset that HANDLES every write right the
    //! kernel knows, and grants them beneath the writable directories only.
    //! Read and execute are not handled, so they stay allowed everywhere.
    //!
    //! NETWORK -- `--network off`. Landlock cannot express it: its network
    //! rules (ABI 4) match TCP ports, not addresses, so they cannot tell
    //! `127.0.0.1:8080` from `93.184.216.34:8080`. A network namespace can, but
    //! it gives the command its OWN loopback -- a server the operator started
    //! on the host, or one the previous bash call backgrounded, would vanish --
    //! and unprivileged user namespaces are blocked by AppArmor on stock Ubuntu
    //! (docs/SANDBOX-DESIGN.md measured it). So:
    //!
    //!   1. A seccomp filter refuses, in the kernel, every socket that could
    //!      carry a datagram to an arbitrary address: only AF_UNIX, AF_NETLINK
    //!      and TCP over AF_INET/AF_INET6 may be created. UDP, raw/ICMP, SCTP,
    //!      vsock and the rest get EACCES. TCP Fast Open (MSG_FASTOPEN, which
    //!      connects from sendto/sendmsg) gets EACCES. io_uring gets ENOSYS,
    //!      because its CONNECT op would bypass the filter.
    //!   2. `connect(2)` -- the one call that picks a TCP destination -- is
    //!      handed to a supervisor through SECCOMP_RET_USER_NOTIF. It reads the
    //!      address, and if it is loopback it performs the connect ITSELF, on
    //!      its own duplicate of the very same socket (pidfd_getfd), with the
    //!      bytes it checked. It never answers "continue": a continued syscall
    //!      re-reads the caller's memory, which another thread may have changed
    //!      after the check -- the time-of-check/time-of-use hole the seccomp
    //!      documentation warns about. Anything else gets EACCES.
    //!
    //! The supervisor must be an ANCESTOR of the command: pidfd_getfd and
    //! process_vm_readv need ptrace rights, and Yama (ptrace_scope = 1, the
    //! Ubuntu default) grants those only to ancestors. It is also a child
    //! subreaper, so a job the command backgrounds stays its descendant after
    //! the shell exits, and keeps being served.

    use super::*;
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // ── Landlock uapi (linux/landlock.h) ──
    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: u32 = 1;
    pub const FS_EXECUTE: u64 = 1 << 0;
    pub const FS_WRITE_FILE: u64 = 1 << 1;
    pub const FS_READ_FILE: u64 = 1 << 2;
    pub const FS_REMOVE_DIR: u64 = 1 << 4;
    pub const FS_REMOVE_FILE: u64 = 1 << 5;
    pub const FS_MAKE_CHAR: u64 = 1 << 6;
    pub const FS_MAKE_DIR: u64 = 1 << 7;
    pub const FS_MAKE_REG: u64 = 1 << 8;
    pub const FS_MAKE_SOCK: u64 = 1 << 9;
    pub const FS_MAKE_FIFO: u64 = 1 << 10;
    pub const FS_MAKE_BLOCK: u64 = 1 << 11;
    pub const FS_MAKE_SYM: u64 = 1 << 12;
    pub const FS_REFER: u64 = 1 << 13; // ABI 2
    pub const FS_TRUNCATE: u64 = 1 << 14; // ABI 3

    /// Rights a rule on a non-directory may carry. Anything else is EINVAL.
    const FILE_RIGHTS: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    /// Device files every program expects to be able to write.
    const WRITABLE_DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/ptmx", "/dev/pts"];

    fn errno() -> i32 {
        io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    /// The Landlock ABI the running kernel offers, or the errno that says why
    /// not: ENOSYS (kernel older than 5.13, or built without it) or EOPNOTSUPP
    /// (built in, but not enabled at boot).
    pub fn landlock_abi() -> Result<i32, i32> {
        // SAFETY: the documented version query; no pointers are dereferenced.
        let r = unsafe {
            libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0usize, CREATE_RULESET_VERSION)
        };
        if r < 0 {
            Err(errno())
        } else {
            Ok(r as i32)
        }
    }

    /// Every write right this ABI can handle.
    pub fn write_rights(abi: i32) -> u64 {
        let mut a = FS_WRITE_FILE
            | FS_REMOVE_DIR
            | FS_REMOVE_FILE
            | FS_MAKE_CHAR
            | FS_MAKE_DIR
            | FS_MAKE_REG
            | FS_MAKE_SOCK
            | FS_MAKE_FIFO
            | FS_MAKE_BLOCK
            | FS_MAKE_SYM;
        if abi >= 2 {
            a |= FS_REFER;
        }
        if abi >= 3 {
            a |= FS_TRUNCATE;
        }
        a
    }

    fn landlock_unavailable(err: i32) -> String {
        match err {
            libc::EOPNOTSUPP => "Landlock is built into this kernel but disabled at boot. Add `landlock` to the \
                kernel's lsm= parameter (see /sys/kernel/security/lsm), or set [sandbox] exec = \"docker\""
                .into(),
            libc::ENOSYS => "this kernel has no Landlock (it needs Linux 5.13 or later, built with \
                CONFIG_SECURITY_LANDLOCK). Set [sandbox] exec = \"docker\", or exec = \"off\" to run bash \
                unsandboxed on purpose"
                .into(),
            e => format!("Landlock is unavailable (errno {e})"),
        }
    }

    // ── seccomp / BPF ──

    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7;

    /// Is the network supervisor implemented for this CPU? The BPF program
    /// reads syscall arguments as little-endian 64-bit words and names one
    /// audit arch; both are true of the two targets gnomon ships.
    pub const NETWORK_ARCH_SUPPORTED: bool = cfg!(any(target_arch = "x86_64", target_arch = "aarch64"));

    const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
    const SECCOMP_GET_ACTION_AVAIL: libc::c_uint = 2;
    const RET_ALLOW: u32 = 0x7fff_0000;
    const RET_KILL_PROCESS: u32 = 0x8000_0000;
    const RET_ERRNO: u32 = 0x0005_0000;
    const RET_USER_NOTIF: u32 = 0x7fc0_0000;

    const BPF_LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const BPF_ALU_AND_K: u16 = 0x04 | 0x50;
    const BPF_JMP_JEQ_K: u16 = 0x05 | 0x10;
    const BPF_JMP_JGE_K: u16 = 0x05 | 0x30;
    const BPF_JMP_JSET_K: u16 = 0x05 | 0x40;
    const BPF_RET_K: u16 = 0x06;

    const OFF_NR: u32 = 0;
    const OFF_ARCH: u32 = 4;
    /// Low 32 bits of syscall argument `n` (little-endian).
    const fn off_arg(n: u32) -> u32 {
        16 + 8 * n
    }

    const MSG_FASTOPEN: u32 = 0x2000_0000;

    /// A jump target in the tiny assembler below.
    #[derive(Clone, Copy)]
    enum T {
        Next,
        L(&'static str),
    }

    enum Ins {
        Ld(u32),
        And(u32),
        Jeq(u32, T, T),
        #[allow(dead_code)] // used on x86_64 only
        Jge(u32, T, T),
        Jset(u32, T, T),
        Ret(u32),
        Label(&'static str),
    }

    /// Resolve labels to relative jumps. Panics on an unknown label or a jump
    /// too far for BPF's 8-bit offsets -- both are bugs in this file, caught by
    /// the unit test that assembles the program.
    fn assemble(prog: &[Ins]) -> Vec<libc::sock_filter> {
        let mut labels = std::collections::HashMap::new();
        let mut pos = 0usize;
        for i in prog {
            match i {
                Ins::Label(l) => {
                    labels.insert(*l, pos);
                }
                _ => pos += 1,
            }
        }
        let mut out = Vec::new();
        let rel = |t: T, at: usize| -> u8 {
            match t {
                T::Next => 0,
                T::L(l) => {
                    let to = *labels.get(l).unwrap_or_else(|| panic!("bpf: unknown label {l}"));
                    let d = to.checked_sub(at + 1).expect("bpf: backward jump");
                    u8::try_from(d).expect("bpf: jump too far")
                }
            }
        };
        for i in prog {
            let at = out.len();
            let f = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
            match *i {
                Ins::Label(_) => continue,
                Ins::Ld(o) => out.push(f(BPF_LD_W_ABS, 0, 0, o)),
                Ins::And(k) => out.push(f(BPF_ALU_AND_K, 0, 0, k)),
                Ins::Jeq(k, a, b) => out.push(f(BPF_JMP_JEQ_K, rel(a, at), rel(b, at), k)),
                Ins::Jge(k, a, b) => out.push(f(BPF_JMP_JGE_K, rel(a, at), rel(b, at), k)),
                Ins::Jset(k, a, b) => out.push(f(BPF_JMP_JSET_K, rel(a, at), rel(b, at), k)),
                Ins::Ret(k) => out.push(f(BPF_RET_K, 0, 0, k)),
            }
        }
        out
    }

    /// The `--network off` filter. See the module comment for the reasoning.
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    pub fn network_filter() -> Vec<libc::sock_filter> {
        use Ins::*;
        use T::*;
        let mut p = vec![
            Ld(OFF_ARCH),
            // A foreign ABI (i386 via int 0x80 on x86_64) has different syscall
            // numbers, so nothing below would mean what it says. Kill it.
            Jeq(AUDIT_ARCH, Next, L("kill")),
            Ld(OFF_NR),
        ];
        #[cfg(target_arch = "x86_64")]
        p.push(Jge(0x4000_0000, L("enosys"), Next)); // the x32 ABI
        p.extend([
            Jeq(libc::SYS_connect as u32, L("notify"), Next),
            Jeq(libc::SYS_socket as u32, L("socket"), Next),
            Jeq(libc::SYS_sendto as u32, L("flags3"), Next),
            Jeq(libc::SYS_sendmsg as u32, L("flags2"), Next),
            Jeq(libc::SYS_sendmmsg as u32, L("flags3"), Next),
            Jeq(libc::SYS_io_uring_setup as u32, L("enosys"), Next),
            Jeq(libc::SYS_io_uring_enter as u32, L("enosys"), Next),
            Jeq(libc::SYS_io_uring_register as u32, L("enosys"), Next),
            Ret(RET_ALLOW),
            Label("socket"),
            Ld(off_arg(0)),
            Jeq(libc::AF_UNIX as u32, L("allow"), Next),
            Jeq(libc::AF_NETLINK as u32, L("allow"), Next),
            Jeq(libc::AF_INET as u32, L("inet"), Next),
            Jeq(libc::AF_INET6 as u32, L("inet"), L("eacces")),
            Label("inet"),
            Ld(off_arg(1)),
            And(!((libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC) as u32)),
            Jeq(libc::SOCK_STREAM as u32, Next, L("eacces")),
            Ld(off_arg(2)),
            Jeq(0, L("allow"), Next),
            Jeq(libc::IPPROTO_TCP as u32, L("allow"), L("eacces")),
            Label("flags3"),
            Ld(off_arg(3)),
            Jset(MSG_FASTOPEN, L("eacces"), L("allow")),
            Label("flags2"),
            Ld(off_arg(2)),
            Jset(MSG_FASTOPEN, L("eacces"), L("allow")),
            Label("notify"),
            Ret(RET_USER_NOTIF),
            Label("allow"),
            Ret(RET_ALLOW),
            Label("eacces"),
            Ret(RET_ERRNO | libc::EACCES as u32),
            Label("enosys"),
            Ret(RET_ERRNO | libc::ENOSYS as u32),
            Label("kill"),
            Ret(RET_KILL_PROCESS),
        ]);
        assemble(&p)
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    pub fn network_filter() -> Vec<libc::sock_filter> {
        Vec::new()
    }

    /// Why `--network off` cannot be enforced here, or None if it can.
    pub fn network_unavailable() -> Option<String> {
        if !NETWORK_ARCH_SUPPORTED {
            return Some(format!(
                "network = false is enforced on x86_64 and aarch64 only, and this is {}",
                std::env::consts::ARCH
            ));
        }
        let mut action: u32 = RET_USER_NOTIF;
        // SAFETY: SECCOMP_GET_ACTION_AVAIL reads one u32 from the pointer.
        let r = unsafe { libc::syscall(libc::SYS_seccomp, SECCOMP_GET_ACTION_AVAIL, 0, &mut action as *mut u32) };
        if r != 0 {
            return Some(
                "this kernel has no seccomp user notification (Linux 5.0+), which network = false needs".into(),
            );
        }
        // SAFETY: an invalid pidfd only probes for the syscall's existence.
        let r = unsafe { libc::syscall(libc::SYS_pidfd_getfd, -1, 0, 0) };
        if r < 0 && errno() == libc::ENOSYS {
            return Some("this kernel has no pidfd_getfd (Linux 5.6+), which network = false needs".into());
        }
        None
    }

    pub fn probe() -> Probe {
        let abi = landlock_abi();
        let net = network_unavailable();
        let mut degraded = Vec::new();
        if let Ok(a) = abi {
            if a < 2 {
                degraded.push(
                    "Landlock ABI 1: renaming or hard-linking a file into a different directory fails with EXDEV, \
                     even inside the root (needs ABI 2, Linux 5.19)"
                        .to_string(),
                );
            }
            if a < 3 {
                degraded.push(
                    "truncate(2) of a file outside the root is not blocked (needs Landlock ABI 3, Linux 6.2); \
                     opening it for writing still is"
                        .to_string(),
                );
            }
        }
        if let Some(n) = &net {
            degraded.push(format!("network = false cannot be enforced: {n}"));
        }
        let ok = abi.is_ok();
        Probe {
            platform: "linux",
            supported: ok,
            network_supported: ok && net.is_none(),
            mechanism: match (ok, net.is_none()) {
                (true, true) => "landlock+seccomp".into(),
                (true, false) => "landlock".into(),
                _ => "none".into(),
            },
            landlock_abi: abi.ok(),
            reason: match abi {
                Err(e) => Some(landlock_unavailable(e)),
                Ok(_) => net,
            },
            degraded,
            not_enforced: NOT_ENFORCED.to_vec(),
        }
    }

    fn cstr(p: &Path) -> CString {
        CString::new(p.as_os_str().as_bytes()).unwrap_or_else(|_| refuse(&format!("{} contains a NUL", p.display())))
    }

    fn add_rule(ruleset: i32, path: &Path, access: u64) -> Result<(), String> {
        let c = cstr(path);
        // SAFETY: c is a valid NUL-terminated path.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(format!("open {}: {}", path.display(), io::Error::last_os_error()));
        }
        let attr = PathBeneathAttr { allowed_access: access, parent_fd: fd };
        // SAFETY: attr is a valid landlock_path_beneath_attr for the call's duration.
        let r = unsafe {
            libc::syscall(libc::SYS_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &attr as *const PathBeneathAttr, 0)
        };
        let e = io::Error::last_os_error();
        // SAFETY: fd was opened above and is closed once.
        unsafe { libc::close(fd) };
        if r < 0 {
            return Err(format!("landlock_add_rule {}: {e}", path.display()));
        }
        Ok(())
    }

    /// Confine THIS process's filesystem writes, irrevocably, for it and every
    /// process it starts.
    fn apply_landlock(policy: &Policy) -> Result<(), String> {
        let abi = landlock_abi().map_err(landlock_unavailable)?;
        let handled = write_rights(abi);
        let attr = RulesetAttr { handled_access_fs: handled };
        // SAFETY: attr outlives the call; the size is the struct's.
        let ruleset = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const RulesetAttr,
                std::mem::size_of::<RulesetAttr>(),
                0u32,
            )
        } as i32;
        if ruleset < 0 {
            return Err(format!("landlock_create_ruleset: {}", io::Error::last_os_error()));
        }
        let result = (|| {
            for d in policy.writable_dirs() {
                add_rule(ruleset, d, handled)?;
            }
            for dev in WRITABLE_DEVICES {
                let p = Path::new(dev);
                let Ok(meta) = std::fs::metadata(p) else { continue };
                let access = if meta.is_dir() { FS_WRITE_FILE } else { (FS_WRITE_FILE | FS_TRUNCATE) & handled & FILE_RIGHTS };
                add_rule(ruleset, p, access)?;
            }
            set_no_new_privs()?;
            // SAFETY: ruleset is a valid Landlock ruleset fd.
            if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) } < 0 {
                return Err(format!("landlock_restrict_self: {}", io::Error::last_os_error()));
            }
            Ok(())
        })();
        // SAFETY: closed once.
        unsafe { libc::close(ruleset) };
        result
    }

    /// Required by both Landlock and seccomp for an unprivileged caller, and a
    /// guarantee of its own: setuid binaries (sudo, su, pkexec) cannot gain
    /// privilege inside the sandbox.
    fn set_no_new_privs() -> Result<(), String> {
        // SAFETY: plain prctl with integer arguments.
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
            return Err(format!("PR_SET_NO_NEW_PRIVS: {}", io::Error::last_os_error()));
        }
        Ok(())
    }

    /// Install the network filter and return the notification listener fd.
    fn install_network_filter() -> Result<i32, String> {
        let filter = network_filter();
        if filter.is_empty() {
            return Err(network_unavailable().unwrap_or_else(|| "no network filter for this arch".into()));
        }
        let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr() as *mut libc::sock_filter };
        // SAFETY: prog points at `filter`, which outlives the call.
        let fd = unsafe {
            libc::syscall(
                libc::SYS_seccomp,
                SECCOMP_SET_MODE_FILTER,
                libc::SECCOMP_FILTER_FLAG_NEW_LISTENER,
                &prog as *const libc::sock_fprog,
            )
        };
        if fd < 0 {
            return Err(format!("seccomp: {}", io::Error::last_os_error()));
        }
        Ok(fd as i32)
    }

    fn exec_argv(argv: &[String]) -> ! {
        let cargs: Vec<CString> = argv
            .iter()
            .map(|a| CString::new(a.as_bytes()).unwrap_or_else(|_| refuse("an argument contains a NUL byte")))
            .collect();
        let mut ptrs: Vec<*const libc::c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: NUL-terminated array of valid C strings.
        unsafe { libc::execvp(ptrs[0], ptrs.as_ptr()) };
        let e = io::Error::last_os_error();
        eprintln!("gnomon-exec: {}: {e}", argv[0]);
        // 127 / 126, as a shell would report it.
        std::process::exit(if e.raw_os_error() == Some(libc::ENOENT) { 127 } else { 126 });
    }

    pub fn run(policy: &Policy, argv: &[String]) -> ! {
        if policy.network {
            // Filesystem only: confine this process and become the command.
            // No fork, no supervisor -- the cheap path.
            if let Err(e) = apply_landlock(policy) {
                refuse(&e);
            }
            exec_argv(argv);
        }
        if let Some(why) = network_unavailable() {
            refuse(&format!("{why}. Set [sandbox] network = true to run with the filesystem sandbox only"));
        }
        // Fail before forking if Landlock is not there: the refusal should come
        // from the process the caller is waiting on.
        if let Err(e) = landlock_abi() {
            refuse(&landlock_unavailable(e));
        }
        supervised(policy, argv)
    }

    // ── The supervised path (--network off) ──
    //
    //   gnomon-exec (G)          the process the caller waits on
    //     └─ supervisor (S)      child subreaper; serves connect() notifications
    //          └─ command (C)    Landlock + seccomp, then exec sh -c ...
    //
    // G exits with C's status as soon as C exits, so a caller sees the same
    // exit timing as an unsandboxed command. S outlives C for as long as any
    // process under the filter lives (a backgrounded server, say), then exits.

    fn pipe() -> [i32; 2] {
        let mut p = [0i32; 2];
        // SAFETY: p has room for two fds.
        if unsafe { libc::pipe2(p.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            refuse(&format!("pipe: {}", io::Error::last_os_error()));
        }
        p
    }

    fn write_all(fd: i32, buf: &[u8]) {
        let mut off = 0;
        while off < buf.len() {
            // SAFETY: buf[off..] is valid for reads.
            let n = unsafe { libc::write(fd, buf[off..].as_ptr().cast(), buf.len() - off) };
            if n < 0 {
                if errno() == libc::EINTR {
                    continue;
                }
                return;
            }
            off += n as usize;
        }
    }

    fn supervised(policy: &Policy, argv: &[String]) -> ! {
        let status = pipe(); // S -> G: C's wait status, 4 bytes
        let mut chan = [0i32; 2]; // C -> S: the listener fd, SCM_RIGHTS
        // SAFETY: chan has room for two fds.
        if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, chan.as_mut_ptr()) }
            != 0
        {
            refuse(&format!("socketpair: {}", io::Error::last_os_error()));
        }

        // SAFETY: this process is single-threaded here, so fork is sound.
        match unsafe { libc::fork() } {
            -1 => refuse(&format!("fork: {}", io::Error::last_os_error())),
            0 => {
                // S
                // SAFETY: closing fds this process owns.
                unsafe {
                    libc::close(status[0]);
                }
                supervisor(policy, argv, status[1], chan)
            }
            _ => {
                // G
                // SAFETY: closing fds this process owns.
                unsafe {
                    libc::close(status[1]);
                    libc::close(chan[0]);
                    libc::close(chan[1]);
                }
                let mut buf = [0u8; 4];
                let mut got = 0;
                while got < 4 {
                    // SAFETY: buf[got..] is valid for writes.
                    let n = unsafe { libc::read(status[0], buf[got..].as_mut_ptr().cast(), 4 - got) };
                    if n < 0 && errno() == libc::EINTR {
                        continue;
                    }
                    if n <= 0 {
                        refuse("the sandbox supervisor exited without reporting the command's status");
                    }
                    got += n as usize;
                }
                exit_like(i32::from_ne_bytes(buf))
            }
        }
    }

    /// Exit the way the command did: its code, or the signal that killed it.
    fn exit_like(ws: i32) -> ! {
        if libc::WIFEXITED(ws) {
            std::process::exit(libc::WEXITSTATUS(ws));
        }
        if libc::WIFSIGNALED(ws) {
            let sig = libc::WTERMSIG(ws);
            // SAFETY: restoring the default action and raising it on ourselves.
            unsafe {
                libc::signal(sig, libc::SIG_DFL);
                libc::raise(sig);
            }
            std::process::exit(128 + sig);
        }
        std::process::exit(SANDBOX_REFUSED)
    }

    fn supervisor(policy: &Policy, argv: &[String], status_w: i32, chan: [i32; 2]) -> ! {
        // SAFETY: plain prctl; orphans of the command reparent to S, so they
        // stay S's descendants and Yama keeps letting S serve them.
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };

        // SAFETY: still single-threaded.
        let child = unsafe { libc::fork() };
        if child < 0 {
            eprintln!("gnomon-exec: sandbox refused: fork: {}", io::Error::last_os_error());
            write_all(status_w, &(SANDBOX_REFUSED << 8).to_ne_bytes());
            std::process::exit(0);
        }
        if child == 0 {
            // C
            // SAFETY: closing fds this process owns.
            unsafe {
                libc::close(status_w);
                libc::close(chan[0]);
            }
            command(policy, argv, chan[1]);
        }

        // S: no stdin or stdout -- it must not hold the caller's pipes open
        // past the command. stderr is kept, for the blocked-connect notices, until
        // the command exits (see serve).
        // SAFETY: fd juggling on fds this process owns.
        unsafe {
            libc::close(chan[1]);
            let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
            if null >= 0 {
                libc::dup2(null, 0);
                libc::dup2(null, 1);
                libc::close(null);
            }
        }
        let listener = recv_fd(chan[0]);
        // SAFETY: closed once.
        unsafe { libc::close(chan[0]) };

        // SAFETY: pidfd_open of our own child.
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, child, 0) } as i32;

        let Some(listener) = listener else {
            // C failed before installing the filter and has already said why.
            let mut ws = 0;
            // SAFETY: waiting on our own child.
            unsafe { libc::waitpid(child, &mut ws, 0) };
            write_all(status_w, &ws.to_ne_bytes());
            std::process::exit(0);
        };

        serve(listener, child, pidfd, status_w)
    }

    /// C: confine, filter, hand the listener to S, become the command.
    fn command(policy: &Policy, argv: &[String], chan: i32) -> ! {
        if let Err(e) = apply_landlock(policy) {
            refuse(&e);
        }
        let listener = match install_network_filter() {
            Ok(fd) => fd,
            Err(e) => refuse(&e),
        };
        if !send_fd(chan, listener) {
            refuse(&format!("could not hand the filter to the supervisor: {}", io::Error::last_os_error()));
        }
        // The command must never hold the listener: whoever holds it answers
        // the notifications, and a command that answered its own would grant
        // itself any connect it liked.
        // SAFETY: closed once.
        unsafe {
            libc::close(listener);
            libc::close(chan);
        }
        exec_argv(argv)
    }

    fn send_fd(sock: i32, fd: i32) -> bool {
        // SAFETY: a standard SCM_RIGHTS sendmsg with a correctly sized buffer.
        unsafe {
            let mut byte = [0u8; 1];
            let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
            let space = libc::CMSG_SPACE(std::mem::size_of::<i32>() as u32) as usize;
            let mut cbuf = vec![0u8; space];
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = space as _;
            let c = libc::CMSG_FIRSTHDR(&msg);
            (*c).cmsg_level = libc::SOL_SOCKET;
            (*c).cmsg_type = libc::SCM_RIGHTS;
            (*c).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as _;
            std::ptr::write_unaligned(libc::CMSG_DATA(c).cast::<i32>(), fd);
            libc::sendmsg(sock, &msg, 0) == 1
        }
    }

    fn recv_fd(sock: i32) -> Option<i32> {
        // SAFETY: a standard SCM_RIGHTS recvmsg with a correctly sized buffer.
        unsafe {
            let mut byte = [0u8; 1];
            let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
            let space = libc::CMSG_SPACE(std::mem::size_of::<i32>() as u32) as usize;
            let mut cbuf = vec![0u8; space];
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = space as _;
            loop {
                let n = libc::recvmsg(sock, &mut msg, libc::MSG_CMSG_CLOEXEC);
                if n < 0 && errno() == libc::EINTR {
                    continue;
                }
                if n <= 0 {
                    return None;
                }
                break;
            }
            let c = libc::CMSG_FIRSTHDR(&msg);
            if c.is_null() || (*c).cmsg_type != libc::SCM_RIGHTS {
                return None;
            }
            Some(std::ptr::read_unaligned(libc::CMSG_DATA(c).cast::<i32>()))
        }
    }

    /// S's loop: answer connect() notifications until no filtered process is
    /// left, reporting C's status to G the moment C exits.
    fn serve(listener: i32, child: i32, pidfd: i32, status_w: i32) -> ! {
        let notices = Arc::new(AtomicUsize::new(0));
        let mut status_w = Some(status_w);
        loop {
            let mut fds = [
                libc::pollfd { fd: listener, events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: if status_w.is_some() { pidfd } else { -1 }, events: libc::POLLIN, revents: 0 },
            ];
            // Without a pidfd (it cannot fail on a kernel that has
            // pidfd_getfd, but be safe) poll C every 10 ms instead.
            let timeout = if status_w.is_none() { 250 } else if pidfd < 0 { 10 } else { -1 };
            // SAFETY: fds is a valid array of two pollfds.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) };
            if n < 0 && errno() != libc::EINTR {
                break;
            }

            if let Some(w) = status_w {
                let mut ws = 0;
                // SAFETY: waiting on our own child, without blocking.
                if unsafe { libc::waitpid(child, &mut ws, libc::WNOHANG) } == child {
                    write_all(w, &ws.to_ne_bytes());
                    // Let go of the caller's stderr too. Unsandboxed, `sleep 30
                    // >/dev/null 2>&1 &` leaves nothing holding the caller's
                    // pipes once sh exits; a supervisor still holding stderr
                    // would make a caller that reads to EOF wait for the job.
                    // Measured: it did, for the whole `sleep`. A blocked
                    // connect from a job after this point still fails; it is
                    // only no longer announced.
                    // SAFETY: closing and redirecting fds this process owns.
                    unsafe {
                        libc::close(w);
                        let null = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                        if null >= 0 {
                            libc::dup2(null, 2);
                            libc::close(null);
                        }
                    }
                    status_w = None;
                }
            } else {
                // Reap whatever the command orphaned onto us.
                // SAFETY: non-blocking wait for any child.
                while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
            }

            if fds[0].revents & libc::POLLIN != 0 {
                // SAFETY: an all-zero seccomp_notif is the required input.
                let mut req: libc::seccomp_notif = unsafe { std::mem::zeroed() };
                // SAFETY: req is a correctly sized seccomp_notif.
                let r = unsafe { libc::ioctl(listener, libc::SECCOMP_IOCTL_NOTIF_RECV as _, &mut req) };
                if r == 0 {
                    let notices = notices.clone();
                    // A connect can block (a unix socket with a full backlog),
                    // and one stalled connect must not stall every other.
                    std::thread::spawn(move || answer_connect(listener, req, &notices));
                }
            }
            if fds[0].revents & (libc::POLLHUP | libc::POLLERR) != 0 && status_w.is_none() {
                break;
            }
        }
        std::process::exit(0)
    }

    /// The loopback test. 0.0.0.0 and :: are included: Linux connects them to
    /// the local host, so they never leave the machine either.
    pub fn is_local(addr: &[u8]) -> Option<bool> {
        let family = u16::from_ne_bytes([*addr.first()?, *addr.get(1)?]) as i32;
        match family {
            libc::AF_INET => {
                let ip = addr.get(4..8)?;
                Some(ip[0] == 127 || ip == [0, 0, 0, 0])
            }
            libc::AF_INET6 => {
                let ip = addr.get(8..24)?;
                let mapped = ip[..10].iter().all(|b| *b == 0) && ip[10] == 0xff && ip[11] == 0xff;
                let loop6 = ip[..15].iter().all(|b| *b == 0) && (ip[15] == 1 || ip[15] == 0);
                Some(loop6 || (mapped && (ip[12] == 127 || ip[12..16] == [0, 0, 0, 0])))
            }
            // Not a route off the machine: a unix socket, or AF_UNSPEC, which
            // dissolves a socket's association.
            libc::AF_UNIX | libc::AF_UNSPEC => Some(true),
            _ => Some(false),
        }
    }

    fn describe(addr: &[u8]) -> String {
        let family = u16::from_ne_bytes([addr[0], addr[1]]) as i32;
        let port = || u16::from_be_bytes([addr[2], addr[3]]);
        match family {
            libc::AF_INET if addr.len() >= 8 => {
                format!("{}.{}.{}.{}:{}", addr[4], addr[5], addr[6], addr[7], port())
            }
            libc::AF_INET6 if addr.len() >= 24 => {
                let mut b = [0u8; 16];
                b.copy_from_slice(&addr[8..24]);
                format!("[{}]:{}", std::net::Ipv6Addr::from(b), port())
            }
            f => format!("an address of family {f}"),
        }
    }

    fn id_valid(listener: i32, id: u64) -> bool {
        // SAFETY: the ioctl reads one u64.
        unsafe { libc::ioctl(listener, libc::SECCOMP_IOCTL_NOTIF_ID_VALID as _, &id) == 0 }
    }

    /// The thread-group id of a thread: the notification names the calling
    /// THREAD, and pidfd_open rejects a non-leader thread before Linux 6.9.
    fn tgid_of(tid: u32) -> Option<i32> {
        let s = std::fs::read_to_string(format!("/proc/{tid}/status")).ok()?;
        s.lines().find_map(|l| l.strip_prefix("Tgid:")).and_then(|v| v.trim().parse().ok())
    }

    fn answer_connect(listener: i32, req: libc::seccomp_notif, notices: &AtomicUsize) {
        let mut resp = libc::seccomp_notif_resp { id: req.id, val: 0, error: 0, flags: 0 };
        let error = connect_for(listener, &req, notices);
        match error {
            Ok(()) => {}
            Err(e) => resp.error = -e,
        }
        // SAFETY: resp is a correctly sized seccomp_notif_resp. ENOENT (the
        // caller is gone) needs no handling.
        unsafe { libc::ioctl(listener, libc::SECCOMP_IOCTL_NOTIF_SEND as _, &mut resp) };
    }

    /// Perform the caller's connect() on its behalf, if the destination is
    /// local. Returns the errno the caller should see.
    fn connect_for(listener: i32, req: &libc::seccomp_notif, notices: &AtomicUsize) -> Result<(), i32> {
        let args = req.data.args;
        let fd = args[0] as i32;
        let len = (args[2] as u32 as usize).min(std::mem::size_of::<libc::sockaddr_storage>());
        let mut addr = vec![0u8; len];

        // 1. Copy the address OUT of the caller. From here on only this copy
        //    is looked at, and only this copy is connected to.
        let local = libc::iovec { iov_base: addr.as_mut_ptr().cast(), iov_len: len };
        let remote = libc::iovec { iov_base: args[1] as usize as *mut libc::c_void, iov_len: len };
        if len > 0 {
            // SAFETY: both iovecs describe `len` bytes; the remote one is
            // validated by the kernel against the caller's address space.
            let n = unsafe { libc::process_vm_readv(req.pid as i32, &local, 1, &remote, 1, 0) };
            if n != len as isize {
                return Err(if n < 0 && errno() == libc::EPERM { libc::EACCES } else { libc::EFAULT });
            }
        }
        if !id_valid(listener, req.id) {
            return Err(libc::EINTR); // the caller is gone; nobody reads this
        }

        // 2. Decide.
        match is_local(&addr) {
            None => return Err(libc::EINVAL),
            Some(false) => {
                if notices.fetch_add(1, Ordering::Relaxed) < 5 {
                    eprintln!(
                        "gnomon-exec: network = false: blocked connect to {} (only loopback is allowed)",
                        describe(&addr)
                    );
                }
                return Err(libc::EACCES);
            }
            Some(true) => {}
        }

        // 3. Connect the caller's own socket, from here.
        let tgid = tgid_of(req.pid).ok_or(libc::ESRCH)?;
        // SAFETY: pidfd_open with an integer pid.
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, tgid, 0) } as i32;
        if pidfd < 0 {
            return Err(libc::ESRCH);
        }
        // The pidfd is only known to name the caller if the notification is
        // still live after it was opened (a pid can be reused).
        if !id_valid(listener, req.id) {
            // SAFETY: closed once.
            unsafe { libc::close(pidfd) };
            return Err(libc::EINTR);
        }
        // SAFETY: duplicating the caller's descriptor into this process.
        let theirs = unsafe { libc::syscall(libc::SYS_pidfd_getfd, pidfd, fd, 0) } as i32;
        let getfd_err = errno();
        // SAFETY: closed once.
        unsafe { libc::close(pidfd) };
        if theirs < 0 {
            if getfd_err == libc::EBADF {
                return Err(libc::EBADF);
            }
            if notices.fetch_add(1, Ordering::Relaxed) < 5 {
                eprintln!(
                    "gnomon-exec: network = false: could not verify a connect (pidfd_getfd: errno {getfd_err}); refused"
                );
            }
            return Err(libc::EACCES);
        }

        // A relative unix socket path names a file relative to the CALLER's
        // working directory, not this process's.
        if u16::from_ne_bytes([addr[0], addr[1]]) as i32 == libc::AF_UNIX && len > 2 && addr[2] != 0 && addr[2] != b'/' {
            let rel_end = addr[2..].iter().position(|b| *b == 0).map(|i| i + 2).unwrap_or(len);
            let rel = Path::new(std::ffi::OsStr::from_bytes(&addr[2..rel_end])).to_path_buf();
            let Ok(cwd) = std::fs::read_link(format!("/proc/{}/cwd", req.pid)) else {
                // SAFETY: closed once.
                unsafe { libc::close(theirs) };
                return Err(libc::ENOENT);
            };
            let abs = cwd.join(rel);
            let bytes = abs.as_os_str().as_bytes();
            if bytes.len() >= 108 {
                // SAFETY: closed once.
                unsafe { libc::close(theirs) };
                return Err(libc::ENAMETOOLONG);
            }
            addr.truncate(2);
            addr.extend_from_slice(bytes);
            addr.push(0);
        }

        // SAFETY: addr holds a sockaddr of addr.len() bytes.
        let r = unsafe { libc::connect(theirs, addr.as_ptr().cast(), addr.len() as libc::socklen_t) };
        let e = errno();
        // SAFETY: closed once.
        unsafe { libc::close(theirs) };
        if r < 0 {
            Err(e)
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn v4(a: [u8; 4]) -> Vec<u8> {
            let mut s = vec![0u8; 16];
            s[..2].copy_from_slice(&(libc::AF_INET as u16).to_ne_bytes());
            s[2..4].copy_from_slice(&80u16.to_be_bytes());
            s[4..8].copy_from_slice(&a);
            s
        }

        fn v6(a: [u8; 16]) -> Vec<u8> {
            let mut s = vec![0u8; 28];
            s[..2].copy_from_slice(&(libc::AF_INET6 as u16).to_ne_bytes());
            s[8..24].copy_from_slice(&a);
            s
        }

        #[test]
        fn loopback_is_local_and_everything_else_is_not() {
            assert_eq!(is_local(&v4([127, 0, 0, 1])), Some(true));
            assert_eq!(is_local(&v4([127, 1, 2, 3])), Some(true));
            assert_eq!(is_local(&v4([0, 0, 0, 0])), Some(true));
            assert_eq!(is_local(&v4([93, 184, 216, 34])), Some(false));
            assert_eq!(is_local(&v4([10, 0, 0, 1])), Some(false), "a private address is another host");
            assert_eq!(is_local(&v4([192, 168, 1, 1])), Some(false));
            let mut one = [0u8; 16];
            one[15] = 1;
            assert_eq!(is_local(&v6(one)), Some(true), "::1");
            assert_eq!(is_local(&v6([0u8; 16])), Some(true), "::");
            let mut mapped = [0u8; 16];
            mapped[10] = 0xff;
            mapped[11] = 0xff;
            mapped[12..].copy_from_slice(&[127, 0, 0, 1]);
            assert_eq!(is_local(&v6(mapped)), Some(true), "::ffff:127.0.0.1");
            mapped[12..].copy_from_slice(&[1, 1, 1, 1]);
            assert_eq!(is_local(&v6(mapped)), Some(false), "::ffff:1.1.1.1 is IPv4 egress in IPv6 clothing");
            let mut g = [0u8; 16];
            g[0] = 0x20;
            g[1] = 0x01;
            assert_eq!(is_local(&v6(g)), Some(false));
        }

        #[test]
        fn a_truncated_address_is_not_guessed_at() {
            assert_eq!(is_local(&[]), None);
            assert_eq!(is_local(&(libc::AF_INET as u16).to_ne_bytes()), None);
        }

        #[test]
        fn unknown_families_are_not_local() {
            // AF_VSOCK reaches the hypervisor: another machine.
            let s = (libc::AF_VSOCK as u16).to_ne_bytes();
            assert_eq!(is_local(&[s[0], s[1], 0, 0]), Some(false));
        }

        #[test]
        fn the_network_filter_assembles() {
            // assemble() panics on an unknown label or an over-long jump; this
            // is what catches either before a kernel ever sees the program.
            let f = network_filter();
            if NETWORK_ARCH_SUPPORTED {
                assert!(f.len() > 20 && f.len() < 100, "{} instructions", f.len());
                assert_eq!(f.last().unwrap().k, RET_KILL_PROCESS);
            }
        }

        #[test]
        fn write_rights_grow_with_the_abi_and_never_include_reads() {
            for abi in 1..=7 {
                let w = write_rights(abi);
                assert_eq!(w & (FS_READ_FILE | FS_EXECUTE), 0, "reads must stay unhandled (allowed)");
                assert_ne!(w & FS_WRITE_FILE, 0);
            }
            assert_eq!(write_rights(1) & FS_REFER, 0);
            assert_ne!(write_rights(2) & FS_REFER, 0);
            assert_eq!(write_rights(2) & FS_TRUNCATE, 0);
            assert_ne!(write_rights(3) & FS_TRUNCATE, 0);
        }
    }
}
