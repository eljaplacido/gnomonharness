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
//!   - `--reads all` (the default): reads and execution are allowed everywhere,
//!     so system tools work.
//!   - `--reads scoped` (Linux only): reads -- and so execution, which needs a
//!     read -- are allowed only beneath the root, the writable directories, the
//!     system directories in `SYSTEM_READ`, the toolchain directories in
//!     `HOME_TOOLCHAIN_READ` that exist, and every `--read` path the caller
//!     names. Landlock is an allow-list: what is not granted is unreadable, so
//!     `~/.ssh` is unreadable because nothing grants it, and any grant that
//!     would cover a path in `PROTECTED_HOME` is refused (or, for a default,
//!     dropped) rather than applied.
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

/// How far a command's reads reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reads {
    /// Every file the user can read. The default, and the only mode before
    /// `--reads` existed.
    All,
    /// The allow-list in the module comment. Linux only.
    Scoped,
}

/// What the caller asked for.
#[derive(Debug, Clone)]
pub struct Policy {
    /// The project root: writable, recursively.
    pub root: PathBuf,
    /// Further writable directories: the per-call temp dir, `extra_roots`.
    pub writable: Vec<PathBuf>,
    /// Further readable paths (directories or files) under `Reads::Scoped`:
    /// `[sandbox] read_roots`, and the gnomon install the caller runs from.
    pub readable: Vec<PathBuf>,
    pub reads: Reads,
    /// May the command reach hosts other than this one?
    pub network: bool,
    /// Under `network` false: may it still connect to this host's loopback?
    /// `--network off` yes (a dev server, a local registry); `--network none`
    /// no -- gnomon's own git, which has no business reaching a listener a
    /// command may have left running (third review, finding 9).
    pub loopback: bool,
    /// `--report-fd N`: write the supervisor's pid to this descriptor, once,
    /// and close it in every process the command can reach (sandbox-kill).
    pub report_fd: Option<i32>,
}

/// System directories a scoped command may read, when they exist: where
/// programs, their libraries and their configuration live, plus the kernel's
/// views and the device files. An allow-list, so whatever these hold stays
/// readable -- /etc included.
pub const SYSTEM_READ: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/proc", "/sys",
    "/snap", "/nix/store", "/home/linuxbrew/.linuxbrew",
];

/// The device files a scoped command may read, file by file. Not `/dev` as a
/// whole: that would grant `/dev/shm` (another process's shared memory, POSIX
/// semaphores), `/dev/mqueue`, and any block or character device the user's
/// groups can open. `/dev/fd` and `/dev/std*` are links into `/proc/self`,
/// which is granted with `/proc`.
///
/// Not `/dev/pts` either: that is every terminal of every session the user
/// has open, and reading one races its shell for the keystrokes typed there
/// (PR #156 second review, finding E). The call's OWN terminal -- whatever
/// pty its stdin, stdout or stderr is -- is granted by name (`own_ptys`).
/// A pty the command creates through /dev/ptmx cannot be granted ahead of
/// time (Landlock rules name existing files), so under reads = "scoped" a
/// program that opens a new pty's slave (`script`, `expect`, pexpect) fails.
pub const DEVICE_READ: &[&str] = &["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/ptmx"];

/// The ptys this process's stdin, stdout and stderr are, if any: the call's
/// own terminal, which it may read and write under reads = "scoped".
pub fn own_ptys() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for fd in 0..=2 {
        if let Ok(t) = std::fs::read_link(format!("/proc/self/fd/{fd}")) {
            let ok = t.starts_with("/dev/pts/")
                && t.file_name().map(|n| n.to_string_lossy().bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
            if ok && !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// Environment variables that name a channel to something OUTSIDE the
/// sandbox: a session bus, an agent holding keys, a terminal multiplexer, a
/// display server, an editor's IPC socket. Each is removed from the command's
/// environment. Removing a variable is hygiene, not containment -- a command
/// can guess the default path -- so under the supervisor the connect itself is
/// checked as well (see `linux::unix_allowed`).
pub const SCRUBBED_ENV: &[&str] = &[
    "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE",
    "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID",
    "XDG_RUNTIME_DIR", "TMUX", "TMUX_PANE", "STY", "ZELLIJ", "ZELLIJ_SESSION_NAME",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE",
    "KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "WEZTERM_UNIX_SOCKET", "ALACRITTY_SOCKET",
    "NVIM", "NVIM_LISTEN_ADDRESS", "VSCODE_IPC_HOOK", "VSCODE_IPC_HOOK_CLI", "VSCODE_GIT_IPC_HANDLE",
    "DOCKER_HOST", "CONTAINER_HOST", "PODMAN_HOST", "PULSE_SERVER", "PIPEWIRE_REMOTE",
    "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "INVOCATION_ID", "JOURNAL_STREAM",
];

/// Remove `SCRUBBED_ENV` from this process's environment, so the command
/// inherits none of it. Called while single-threaded, before anything forks.
pub fn scrub_env() {
    for v in SCRUBBED_ENV {
        std::env::remove_var(v);
    }
}

/// Toolchain and package-cache paths under `$HOME` a scoped command may read,
/// when they exist. Chosen to hold programs and downloaded packages, never a
/// login: `~/.cargo/bin` and `~/.cargo/registry` rather than `~/.cargo`, which
/// holds `credentials.toml`; git's configuration file by file, because
/// `~/.config/git/credentials` is where git's store helper keeps passwords.
pub const HOME_TOOLCHAIN_READ: &[&str] = &[
    ".local/bin", ".local/lib", ".local/share/pnpm", ".cargo/bin", ".cargo/registry", ".cargo/git", ".rustup",
    ".nvm", ".volta", ".bun/bin", ".deno/bin", ".pyenv", ".rbenv", "go/bin", "go/pkg/mod", ".npm",
    ".cache/pip", ".cache/uv", ".cache/go-build", ".cache/pypoetry", ".cache/node/corepack", ".cache/node-gyp",
    ".cache/pnpm", ".cache/yarn", ".m2/repository", ".gradle/caches",
    ".gradle/wrapper", ".gitconfig", ".config/git/config", ".config/git/ignore", ".config/git/attributes",
];

/// Where credentials live, relative to a home directory. Under `Reads::Scoped`
/// none of these is granted, and a grant that would cover one -- the root, a
/// writable directory, a `--read` -- is refused. Landlock is an allow-list, so
/// this list does not make anything unreadable by itself; it stops a grant
/// (`--read ~`, a root of `$HOME`) from making it readable again.
pub const PROTECTED_HOME: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".config/gh", ".config/hub",
    ".config/glab-cli", ".netrc", ".git-credentials", ".config/git/credentials", ".npmrc", ".yarnrc",
    ".yarnrc.yml", ".pypirc", ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml",
    ".m2/settings.xml", ".gradle/gradle.properties", ".terraform.d", ".vault-token", ".password-store",
    ".local/share/keyrings", ".pki", ".local/share/gnomon/credentials.json", ".claude", ".claude.json", ".codex",
    ".local/share/opencode", ".mozilla", ".thunderbird", ".config/google-chrome", ".config/chromium",
    ".config/BraveSoftware", ".config/microsoft-edge", ".config/vivaldi", ".config/opera", "snap/firefox",
    "snap/chromium",
];

/// The same, under `$XDG_CONFIG_HOME` and `$XDG_DATA_HOME` when they are set.
const PROTECTED_XDG_CONFIG: &[&str] = &["gh", "hub", "glab-cli", "gcloud", "git/credentials"];
const PROTECTED_XDG_DATA: &[&str] = &["gnomon/credentials.json", "keyrings", "opencode"];

/// Every home directory this process can name: `$HOME` and the password
/// database's entry. They differ under a substituted HOME, and a credential
/// under either is someone's.
fn homes() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute()) {
        out.push(h);
    }
    #[cfg(unix)]
    {
        // SAFETY: getpwuid returns a pointer into static storage or null; it
        // is read once, here, before anything else could call it.
        unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if !pw.is_null() && !(*pw).pw_dir.is_null() {
                let dir = std::ffi::CStr::from_ptr((*pw).pw_dir);
                use std::os::unix::ffi::OsStrExt;
                out.push(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())));
            }
        }
    }
    let mut seen = Vec::new();
    for h in out {
        let c = std::fs::canonicalize(&h).unwrap_or(h);
        if !seen.contains(&c) {
            seen.push(c);
        }
    }
    seen
}

/// The credential locations `Reads::Scoped` keeps unreadable, as absolute
/// paths. Each is listed both as named and, when it exists, as its canonical
/// target, so a `~/.ssh` that is a symlink is protected at both ends.
pub fn protected_paths() -> Vec<PathBuf> {
    let mut raw = Vec::new();
    for h in homes() {
        raw.extend(PROTECTED_HOME.iter().map(|r| h.join(r)));
    }
    for (var, list) in [("XDG_CONFIG_HOME", PROTECTED_XDG_CONFIG), ("XDG_DATA_HOME", PROTECTED_XDG_DATA)] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from).filter(|b| b.is_absolute()) {
            raw.extend(list.iter().map(|r| base.join(r)));
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for p in raw {
        if let Ok(c) = std::fs::canonicalize(&p) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// The protected path a read grant of `grant` would expose: one beneath it,
/// or one it is beneath.
pub fn exposes<'a>(grant: &Path, protected: &'a [PathBuf]) -> Option<&'a PathBuf> {
    protected.iter().find(|q| q.starts_with(grant) || grant.starts_with(q))
}

/// Everything a `Reads::Scoped` command may read besides the writable
/// directories, with whether each is a directory (Landlock grants a file only
/// the rights a file can carry). `Err` names a grant the caller made that
/// would expose a credential: that is refused, never trimmed, because the
/// caller asked for something this mode cannot give.
pub fn read_grants(policy: &Policy) -> Result<Vec<(PathBuf, bool)>, String> {
    let protected = protected_paths();
    let asked = std::iter::once(("--root", &policy.root))
        .chain(policy.writable.iter().map(|w| ("--write", w)))
        .chain(policy.readable.iter().map(|r| ("--read", r)));
    for (what, p) in asked {
        if let Some(q) = exposes(p, &protected) {
            return Err(format!(
                "reads = scoped cannot keep {} unreadable: {what} {} contains it (or is inside it). \
                 Grant a narrower directory, or use reads = \"all\" knowing that reads are not confined",
                q.display(),
                p.display()
            ));
        }
    }
    let mut grants: Vec<(PathBuf, bool)> = Vec::new();
    let push = |p: PathBuf, grants: &mut Vec<(PathBuf, bool)>| {
        // Defaults that would expose a credential are dropped, not refused:
        // dropping one only takes access away.
        // Nor is one a granted directory already covers (/bin is /usr/bin).
        if exposes(&p, &protected).is_some() || grants.iter().any(|(g, d)| g == &p || (*d && p.starts_with(g))) {
            return;
        }
        let is_dir = p.is_dir();
        grants.push((p, is_dir));
    };
    for s in SYSTEM_READ {
        if let Ok(c) = std::fs::canonicalize(s) {
            if c.is_dir() {
                push(c, &mut grants);
            }
        }
    }
    for d in DEVICE_READ {
        if let Ok(c) = std::fs::canonicalize(d) {
            push(c, &mut grants);
        }
    }
    for t in own_ptys() {
        push(t, &mut grants);
    }
    // /etc/resolv.conf is a symlink into /run on systemd hosts; a resolver that
    // cannot read it falls back to 127.0.0.1:53, so grant the one file.
    if let Ok(c) = std::fs::canonicalize("/etc/resolv.conf") {
        if !grants.iter().any(|(g, d)| *d && c.starts_with(g)) {
            push(c, &mut grants);
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute()).or_else(|| homes().into_iter().next()) {
        for rel in HOME_TOOLCHAIN_READ {
            if let Ok(c) = std::fs::canonicalize(home.join(rel)) {
                push(c, &mut grants);
            }
        }
    }
    for r in &policy.readable {
        grants.push((r.clone(), r.is_dir()));
    }
    Ok(grants)
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
    /// Can `sandbox --reads scoped` run here?
    pub reads_scoped_supported: bool,
    /// Under `--reads scoped`, what is readable on this machine besides the
    /// root, the writable directories and `--read` paths: the system
    /// directories and toolchain paths that exist here.
    pub scoped_reads: Vec<String>,
    /// Under `--reads scoped`, the credential locations no grant may cover.
    pub scoped_protected: Vec<String>,
    /// The limits of `--reads scoped` in particular.
    pub scoped_not_enforced: Vec<&'static str>,
}

/// The limits of this sandbox, said once, here, and printed by `probe`.
pub const NOT_ENFORCED: &[&str] = &[
    "reads, under reads = \"all\" (the default): the command can read any file your user can (secrets in $HOME included); reads = \"scoped\" narrows this on Linux",
    "writes inside the root: .gnomon/, .git/ and every other file under the project root stay writable",
    "unix sockets, where the supervisor cannot run (see degraded) or on macOS: a daemon reachable over one (the docker socket, the systemd user bus via systemd-run, a running tmux) can act outside the sandbox. On Linux with the supervisor, connect() to a pathname socket outside the root and the writable directories, and to any abstract socket, is refused; a datagram sent with sendto/sendmsg to a socket path is not vetted",
    "loopback: a local service that itself reaches the network (a proxy, a DNS resolver -- systemd-resolved's socket and 127.0.0.53 included, so a DNS lookup can carry data out under network = false) is reachable",
    "inbound: a server the command binds on a non-loopback address accepts connections",
    "signals: on Landlock ABI 6+ the command cannot signal a process outside its own call (so not a job an EARLIER bash call started: gnomon's `sandbox-kill <pid>` does that from outside); below ABI 6, and on macOS, it can signal any process your user owns -- its own supervisor included: SIGSTOP stalls every connect the supervisor vets, SIGKILL ends the call (the command dies with it). gnomon's timeout and cancel freeze and kill the call's whole subtree, the supervisor last",
    "macOS: Seatbelt confines writes only; mach services, launchctl, osascript and other IPC run outside the sandbox and can act for the command",
    "POSIX shared memory (/dev/shm): not granted, so shm_open and Python multiprocessing locks fail",
    "metadata outside the root: chmod, chown, utime and extended attributes of files outside the root are not confined by Landlock",
    "already-open descriptors: anything inherited is used as inherited",
    "the environment, beyond the variables gnomon removes (bus, agent and multiplexer sockets; every key variable a surface named; names that look like secrets): anything else exported to gnomon is inherited",
    "/dev/pts under reads = \"all\": every terminal stays writable (reads are unconfined there anyway)",
];

/// The limits of `--reads scoped`: what it does not hide.
pub const SCOPED_NOT_ENFORCED: &[&str] = &[
    "an allow-list, not a deny-list: everything under the system directories stays readable, /etc included (and whatever an administrator or a tool left world-readable there)",
    "inside the root everything is readable: a .env, a token in .git/config, a key someone committed",
    "the environment: bash inherits gnomon's, minus the bus and agent sockets, every key variable a surface named, and names that look like secrets; a token exported in your shell under another name is readable with printenv",
    "ptys: only the call's own terminal is granted; a program that opens a NEW pty's slave (script, expect, pexpect) fails",
    "unix sockets, where the supervisor cannot run: an agent that holds a key (ssh-agent, gpg-agent, a keyring over D-Bus, the docker socket) can still be asked to use it; the key file stays unreadable, the capability does not",
    "only bash is scoped: gnomon's own read and grep tools are governed by [sandbox] level, not by reads = scoped",
    "Landlock ABI 1-2 (Linux before 6.2): truncate(2) of a file outside the root is not blocked",
    "a hard link to a credential placed inside the root beforehand is readable: Landlock judges the path, not the inode (creating one from inside the sandbox is refused)",
    "already-open descriptors: anything inherited is used as inherited",
    "command lines of your other processes (/proc/<pid>/cmdline) are readable; their environments and memory are not (Landlock denies ptrace-mode access to processes outside the sandbox)",
    "toolchain defaults (HOME_TOOLCHAIN_READ) are trusted to hold no credentials; a token someone wrote into ~/.cargo/registry or ~/.npm is readable",
    "git's own config files (~/.gitconfig, ~/.config/git/config) are readable, so git keeps your identity and settings: a token written there (a url.<base>.insteadOf with credentials in it, an http.extraHeader) is readable; keep tokens in a credential helper (~/.git-credentials and ~/.config/git/credentials stay unreadable)",
    "Linux only: on macOS and elsewhere reads = scoped refuses rather than runs",
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

/// Canonical, absolute, existing file or directory -- or a refusal.
fn canonical_path(p: &Path, what: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(p).map_err(|e| format!("{what} {} cannot be resolved: {e}", p.display()))
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
            readable: self
                .readable
                .iter()
                .map(|r| canonical_path(r, "--read"))
                .collect::<Result<_, _>>()?,
            reads: self.reads,
            network: self.network,
            loopback: self.loopback,
            report_fd: self.report_fd,
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
    // Resolve the read scope here, in the process the caller waits on, so a
    // grant that would expose a credential is refused before anything forks.
    let grants = match policy.reads {
        Reads::All => None,
        Reads::Scoped => match read_grants(&policy) {
            Ok(g) => Some(g),
            Err(e) => refuse(&e),
        },
    };
    scrub_env();
    platform::run(&policy, grants.as_deref(), argv)
}

/// `gnomon-exec sandbox-clean <dir>`: empty a per-call temp directory the
/// sandboxed command could write, without ever acting outside it.
///
/// The caller (bashTool) used to `rm -rf` the directory itself, unsandboxed,
/// after the call. A job the command left running could swap a subdirectory
/// for a symlink to anywhere (renameat2 RENAME_EXCHANGE) between the remover's
/// check and its descent, and the remover followed it: measured, 604 files
/// outside the root deleted. Two independent guards here, so either alone
/// holds:
///   1. every step is relative to a directory descriptor this process opened
///      with O_NOFOLLOW, and no entry is ever followed -- a symlink is unlinked
///      as a symlink, wherever it points;
///   2. on Linux the process first confines its own writes, with Landlock, to
///      `dir` -- so even a path that did escape would be refused by the kernel.
///
/// `dir` itself is left in place (removing it needs a write right on its
/// parent, which the confinement does not grant); the caller removes the then
/// empty directory with rmdir, which follows nothing either.
///
/// SECOND REVIEW, finding D. `dir` used to be canonicalised first. When the
/// temp dir's PARENT is writable by a sandboxed command (an extra root holding
/// /tmp, a TMPDIR inside the root), the command could replace `dir` with a
/// symlink to $HOME between the call and the clean, and the canonical path --
/// $HOME -- was then confined to and emptied. Now `dir` is opened with no
/// symlink anywhere on its path (openat2 RESOLVE_NO_SYMLINKS), its identity is
/// checked against the device and inode gnomon recorded when it made the
/// directory, and the Landlock confinement names that DESCRIPTOR, not a path.
pub fn clean(dir: &Path, id: Option<(u64, u64)>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let fd = fs_nofollow::open_dir_strict(dir).map_err(|e| format!("sandbox-clean {}: {e}", dir.display()))?;
        let r = (|| {
            if let Some((dev, ino)) = id {
                let (d, i) = fs_nofollow::dev_ino(fd).map_err(|e| format!("sandbox-clean {}: {e}", dir.display()))?;
                if (d, i) != (dev, ino) {
                    return Err(format!(
                        "sandbox-clean {}: not the directory gnomon made (device/inode {d}/{i}, expected {dev}/{ino}); left alone",
                        dir.display()
                    ));
                }
            }
            #[cfg(target_os = "linux")]
            linux::confine_writes_to_fd(fd)?;
            fs_nofollow::empty_fd(fd).map_err(|e| format!("sandbox-clean {}: {e}", dir.display()))
        })();
        // SAFETY: closed once.
        unsafe { libc::close(fd) };
        r
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, id);
        Err("sandbox-clean is implemented on Unix only".into())
    }
}

/// `gnomon-exec sandbox-kill --supervisor <pid>:<start>... -- <pid> [signal]`.
///
/// Signals scoped to the call (Landlock ABI 6, `SCOPE_SIGNAL`) mean a bash
/// call cannot stop a server an EARLIER call started: each call is its own
/// domain. This is the narrow way back, run by gnomon OUTSIDE the sandbox: it
/// signals `pid` only if `pid` descends from one of this session's
/// supervisors -- each a child subreaper, so everything a call started, however
/// it daemonised, stays beneath it -- named with its start time so a reused
/// pid is not mistaken for one. Anything else is refused. Exit 0: signalled;
/// 1: refused or failed, with the reason on stderr; 2: usage.
pub fn kill_cmd(args: &[String]) -> i32 {
    let mut sups: Vec<(i32, u64)> = Vec::new();
    let mut i = 0;
    while i < args.len() && args[i] != "--" {
        if args[i] == "--supervisor" {
            let parsed = args.get(i + 1).and_then(|v| {
                let (p, t) = v.split_once(':')?;
                Some((p.parse::<i32>().ok()?, t.parse::<u64>().ok()?))
            });
            match parsed {
                Some(x) => sups.push(x),
                None => {
                    eprintln!("gnomon-exec: sandbox-kill --supervisor needs <pid>:<start>");
                    return 2;
                }
            }
            i += 2;
        } else {
            eprintln!("gnomon-exec: sandbox-kill: unknown argument {:?}", args[i]);
            return 2;
        }
    }
    let rest = if i < args.len() { &args[i + 1..] } else { &args[args.len()..] };
    let Some(target) = rest.first().and_then(|v| v.parse::<i32>().ok()) else {
        eprintln!("gnomon-exec: sandbox-kill needs a pid");
        return 2;
    };
    let sig = match rest.get(1) {
        None => 15,
        Some(v) => match signal_number(v) {
            Some(n) => n,
            None => {
                eprintln!("gnomon-exec: sandbox-kill: unknown signal {v:?}");
                return 2;
            }
        },
    };
    match kill_descendant(&sups, target, sig) {
        Ok(()) => {
            println!("signalled {target} with {sig}");
            0
        }
        Err(e) => {
            eprintln!("gnomon-exec: sandbox-kill refused: {e}");
            1
        }
    }
}

/// A signal by name (TERM, SIGTERM) or number, limited to the ones a person
/// stops a server with.
pub fn signal_number(v: &str) -> Option<i32> {
    let name = v.trim_start_matches('-').to_ascii_uppercase();
    let name = name.strip_prefix("SIG").unwrap_or(&name);
    #[cfg(unix)]
    let table: &[(&str, i32)] = &[
        ("HUP", libc::SIGHUP),
        ("INT", libc::SIGINT),
        ("QUIT", libc::SIGQUIT),
        ("KILL", libc::SIGKILL),
        ("USR1", libc::SIGUSR1),
        ("USR2", libc::SIGUSR2),
        ("TERM", libc::SIGTERM),
        ("CONT", libc::SIGCONT),
        ("STOP", libc::SIGSTOP),
    ];
    #[cfg(not(unix))]
    let table: &[(&str, i32)] = &[];
    if let Some((_, n)) = table.iter().find(|(n, _)| *n == name) {
        return Some(*n);
    }
    match name.parse::<i32>() {
        Ok(n) if (0..=31).contains(&n) => Some(n),
        _ => None,
    }
}

/// `pid`'s parent and start time (clock ticks since boot), from /proc.
#[cfg(target_os = "linux")]
pub fn proc_parent_and_start(pid: i32) -> Option<(i32, u64)> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold anything, spaces and
    // parentheses included: count fields from the LAST `)`.
    let rest = s.get(s.rfind(')')? + 2..)?;
    let f: Vec<&str> = rest.split_whitespace().collect();
    // rest starts at field 3 (state); ppid is field 4, starttime field 22.
    Some((f.get(1)?.parse().ok()?, f.get(19)?.parse().ok()?))
}

#[cfg(target_os = "linux")]
fn kill_descendant(sups: &[(i32, u64)], target: i32, sig: i32) -> Result<(), String> {
    if target <= 1 {
        return Err(format!("{target} is not a process a sandboxed call started"));
    }
    if sups.iter().any(|(p, _)| *p == target) {
        return Err(format!("{target} is a sandbox supervisor, not a process the command started"));
    }
    // Pin the target's identity first: from here on a pid reused by another
    // process cannot be the one signalled.
    // SAFETY: pidfd_open with an integer pid.
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, target, 0) } as i32;
    if pidfd < 0 {
        return Err(format!("no process {target} ({})", std::io::Error::last_os_error()));
    }
    let r = (|| {
        let mut cur = target;
        let mut found = false;
        for _ in 0..4096 {
            let Some((ppid, _)) = proc_parent_and_start(cur) else { break };
            if let Some((_, start)) = sups.iter().find(|(p, _)| *p == ppid) {
                if proc_parent_and_start(ppid).map(|(_, s)| s) == Some(*start) {
                    found = true;
                    break;
                }
            }
            if ppid <= 1 {
                break;
            }
            cur = ppid;
        }
        if !found {
            return Err(format!(
                "{target} was not started by a sandboxed bash call of this session; only those can be signalled this way"
            ));
        }
        // Still the process the walk looked at: a pidfd to a process that has
        // exited (whose pid may since name another) fails here with ESRCH.
        // SAFETY: pidfd_send_signal with signal 0 sends nothing.
        if unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd, 0, std::ptr::null::<u8>(), 0) } != 0 {
            return Err(format!("{target} has exited"));
        }
        // SAFETY: as above, with the requested signal.
        if unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd, sig, std::ptr::null::<u8>(), 0) } != 0 {
            return Err(format!("signal {sig} to {target}: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    })();
    // SAFETY: closed once.
    unsafe { libc::close(pidfd) };
    r
}

#[cfg(not(target_os = "linux"))]
fn kill_descendant(_sups: &[(i32, u64)], _target: i32, _sig: i32) -> Result<(), String> {
    Err("sandbox-kill is implemented on Linux only; signals are not scoped elsewhere, so `kill` works inside the call".into())
}

/// Removal that never follows a symbolic link. See `clean`.
#[cfg(unix)]
pub mod fs_nofollow {
    use std::ffi::{CStr, CString};
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// Deeper than any real scratch tree; a tree built to exhaust descriptors
    /// is left behind rather than chased.
    const MAX_DEPTH: usize = 256;

    fn last() -> io::Error {
        io::Error::last_os_error()
    }

    /// Open `dir` (absolute) as a directory, following no symlink in ANY
    /// component: openat2 RESOLVE_NO_SYMLINKS on Linux; elsewhere O_NOFOLLOW,
    /// which covers the last component only.
    pub fn open_dir_strict(dir: &Path) -> io::Result<i32> {
        if !dir.is_absolute() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not an absolute path"));
        }
        #[cfg(target_os = "linux")]
        {
            // SAFETY: plain open of "/".
            let slash = unsafe { libc::open(c"/".as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if slash < 0 {
                return Err(last());
            }
            let rel = dir.strip_prefix("/").unwrap_or(dir);
            let r = super::linux::openat2_strict(slash, rel, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .map_err(io::Error::from_raw_os_error);
            // SAFETY: closed once.
            unsafe { libc::close(slash) };
            r
        }
        #[cfg(not(target_os = "linux"))]
        {
            let c = CString::new(dir.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: c is a valid NUL-terminated path.
            let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            if fd < 0 {
                Err(last())
            } else {
                Ok(fd)
            }
        }
    }

    /// The device and inode of `fd`.
    pub fn dev_ino(fd: i32) -> io::Result<(u64, u64)> {
        // SAFETY: a zeroed stat is valid output space.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: fd is a descriptor the caller owns.
        if unsafe { libc::fstat(fd, &mut st) } != 0 {
            return Err(last());
        }
        #[allow(clippy::unnecessary_cast)]
        Ok((st.st_dev as u64, st.st_ino as u64))
    }

    /// Empty the directory `fd`, leaving it.
    pub fn empty_fd(fd: i32) -> io::Result<()> {
        empty_at(fd, 0)
    }

    /// Empty `dir` (opened O_NOFOLLOW), leaving `dir` itself.
    #[allow(dead_code)]
    pub fn empty_dir(dir: &Path) -> io::Result<()> {
        let c = CString::new(dir.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: c is a valid NUL-terminated path.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(last());
        }
        let r = empty_at(fd, 0);
        // SAFETY: closed once.
        unsafe { libc::close(fd) };
        r
    }

    /// The names in the directory `fd`, without `.` and `..`.
    fn names(fd: i32) -> io::Result<Vec<CString>> {
        // SAFETY: dup of an fd this process owns; fdopendir takes ownership of the dup.
        let d = unsafe { libc::dup(fd) };
        if d < 0 {
            return Err(last());
        }
        // SAFETY: d is a directory fd.
        let dirp = unsafe { libc::fdopendir(d) };
        if dirp.is_null() {
            let e = last();
            // SAFETY: fdopendir failed, so d is still ours.
            unsafe { libc::close(d) };
            return Err(e);
        }
        // SAFETY: rewind, since the dup shares the offset with fd.
        unsafe { libc::rewinddir(dirp) };
        let mut out = Vec::new();
        loop {
            // SAFETY: dirp is a valid DIR*.
            let ent = unsafe { libc::readdir(dirp) };
            if ent.is_null() {
                break;
            }
            // SAFETY: d_name is NUL-terminated.
            let name = unsafe { CStr::from_ptr((*ent).d_name.as_ptr()) };
            let b = name.to_bytes();
            if b == b"." || b == b".." {
                continue;
            }
            out.push(name.to_owned());
        }
        // SAFETY: closes d as well.
        unsafe { libc::closedir(dirp) };
        Ok(out)
    }

    fn empty_at(fd: i32, depth: usize) -> io::Result<()> {
        let mut first_err: Option<io::Error> = None;
        for name in names(fd)? {
            if let Err(e) = remove_at(fd, &name, depth) {
                first_err.get_or_insert(e);
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Remove one entry of `fd`: a directory recursively, anything else --
    /// a symlink included -- with a plain unlink of the entry itself.
    fn remove_at(fd: i32, name: &CStr, depth: usize) -> io::Result<()> {
        // SAFETY: a zeroed stat is valid output space.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: fstatat with AT_SYMLINK_NOFOLLOW never follows the entry.
        if unsafe { libc::fstatat(fd, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            let e = last();
            return if e.raw_os_error() == Some(libc::ENOENT) { Ok(()) } else { Err(e) };
        }
        if (st.st_mode & libc::S_IFMT) != libc::S_IFDIR {
            // SAFETY: unlinkat of a name relative to fd; a symlink is removed, not followed.
            if unsafe { libc::unlinkat(fd, name.as_ptr(), 0) } != 0 {
                let e = last();
                // A directory swapped in since the stat: try once as one.
                if e.raw_os_error() == Some(libc::EISDIR) || e.raw_os_error() == Some(libc::EPERM) {
                    return remove_dir_at(fd, name, depth);
                }
                if e.raw_os_error() != Some(libc::ENOENT) {
                    return Err(e);
                }
            }
            return Ok(());
        }
        remove_dir_at(fd, name, depth)
    }

    fn remove_dir_at(fd: i32, name: &CStr, depth: usize) -> io::Result<()> {
        if depth >= MAX_DEPTH {
            return Err(io::Error::other("directory tree too deep"));
        }
        // O_NOFOLLOW: if the entry became a symlink since the stat, this fails
        // (ELOOP / ENOTDIR) instead of opening wherever it points.
        // SAFETY: openat relative to fd.
        let sub = unsafe {
            libc::openat(fd, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if sub < 0 {
            let e = last();
            return match e.raw_os_error() {
                Some(libc::ENOENT) => Ok(()),
                // Now a symlink or a file: remove the entry itself, never its target.
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => {
                    // SAFETY: unlinkat of a name relative to fd.
                    if unsafe { libc::unlinkat(fd, name.as_ptr(), 0) } != 0 {
                        let e = last();
                        if e.raw_os_error() != Some(libc::ENOENT) {
                            return Err(e);
                        }
                    }
                    Ok(())
                }
                _ => Err(e),
            };
        }
        let r = empty_at(sub, depth + 1);
        // SAFETY: closed once.
        unsafe { libc::close(sub) };
        r?;
        // SAFETY: rmdir of a name relative to fd; fails on a non-empty or non-directory entry.
        if unsafe { libc::unlinkat(fd, name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            let e = last();
            if e.raw_os_error() != Some(libc::ENOENT) {
                return Err(e);
            }
        }
        Ok(())
    }
}

/// The probe's description of `--reads scoped` on this machine.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn scoped_description() -> (Vec<String>, Vec<String>) {
    let probe_policy = Policy {
        root: PathBuf::from("/nonexistent-gnomon-probe-root"),
        writable: vec![],
        readable: vec![],
        reads: Reads::Scoped,
        network: true,
        loopback: true,
        report_fd: None,
    };
    let reads = read_grants(&probe_policy)
        .map(|g| g.into_iter().map(|(p, _)| p.display().to_string()).collect())
        .unwrap_or_default();
    let protected = protected_paths().into_iter().map(|p| p.display().to_string()).collect();
    (reads, protected)
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
            reads_scoped_supported: false,
            scoped_reads: vec![],
            scoped_protected: vec![],
            scoped_not_enforced: SCOPED_NOT_ENFORCED.to_vec(),
        }
    }

    pub fn run(_policy: &Policy, _grants: Option<&[(PathBuf, bool)]>, _argv: &[String]) -> ! {
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

    /// Why `network = false` is not offered here. Measured on macos-latest
    /// (macOS 26, arm64) CI, 2026-11-05: under the profile's network lines
    /// (Bazel's `--sandbox_block_network`, verbatim) `curl` to 192.0.2.1 was
    /// not refused -- it timed out after 3 s, so the connect went out. Those
    /// lines held on the macOS the earlier CI ran. Until a Mac can show which
    /// profile holds on which release, the network half refuses rather than
    /// offering a block that may not be there.
    pub const NETWORK_UNVERIFIED: &str = "network = false is not offered on macOS: the Seatbelt network block let a \
        connect to 192.0.2.1 through on macOS 26 (CI, 2026-11-05). Set [sandbox] network = true to run with \
        the filesystem sandbox only, or exec = \"docker\"";

    pub fn probe() -> Probe {
        let present = Path::new(SANDBOX_EXEC).is_file();
        Probe {
            platform: "macos",
            supported: present,
            network_supported: false,
            mechanism: if present { "seatbelt".into() } else { "none".into() },
            landlock_abi: None,
            reason: Some(if present { NETWORK_UNVERIFIED.to_string() } else { format!("{SANDBOX_EXEC} is missing") }),
            degraded: vec![
                "reads = \"scoped\" is not implemented on macOS: it refuses rather than runs".to_string(),
                NETWORK_UNVERIFIED.to_string(),
            ],
            not_enforced: NOT_ENFORCED.to_vec(),
            reads_scoped_supported: false,
            scoped_reads: vec![],
            scoped_protected: vec![],
            scoped_not_enforced: SCOPED_NOT_ENFORCED.to_vec(),
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

    pub fn run(policy: &Policy, grants: Option<&[(PathBuf, bool)]>, argv: &[String]) -> ! {
        if grants.is_some() || policy.reads == Reads::Scoped {
            // Not written, so not offered: a Seatbelt read allow-list needs the
            // system paths macOS itself reads, and nobody has run one here.
            refuse(
                "reads = \"scoped\" is implemented on Linux (Landlock) only; on macOS it refuses rather \
                 than run with reads unconfined. Set reads = \"all\" to run with the write and network \
                 sandbox only",
            );
        }
        if !Path::new(SANDBOX_EXEC).is_file() {
            refuse(&format!("{SANDBOX_EXEC} is missing, so nothing can enforce the sandbox"));
        }
        if !policy.network {
            refuse(NETWORK_UNVERIFIED);
        }
        // No supervisor to report: the command must not inherit the fd.
        if let Some(r) = policy.report_fd {
            // SAFETY: closed once.
            unsafe { libc::close(r) };
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
    //! Under `--reads all`, read and execute are not handled, so they stay
    //! allowed everywhere. Under `--reads scoped`, READ_FILE and READ_DIR are
    //! handled too and granted only on `read_grants` (and the writable
    //! directories). EXECUTE stays unhandled, but exec opens the file for
    //! reading, so a program outside the read scope cannot be run either.
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
    pub const FS_READ_DIR: u64 = 1 << 3;
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

    /// `struct landlock_ruleset_attr` as of ABI 6. The kernel takes a size, so
    /// an older kernel is handed only the fields it knows (see apply_landlock).
    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }

    /// ABI 6 (Linux 6.12): a process may not connect to an abstract unix
    /// socket, or signal a process, created outside its own Landlock domain.
    pub const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    pub const SCOPE_SIGNAL: u64 = 1 << 1;

    /// The scopes this ABI can enforce.
    pub fn scopes(abi: i32) -> u64 {
        if abi >= 6 {
            SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
        } else {
            0
        }
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    /// Device files every program expects to be able to write. `/dev/pts` --
    /// every terminal -- only under reads = "all", where reads are not confined
    /// anyway; under reads = "scoped" only the call's own pty (`own_ptys`).
    const WRITABLE_DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/ptmx"];

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
            libc::EPERM => "the Landlock syscalls are refused (EPERM): a seccomp profile blocks them, as a \
                container runtime's can. Allow landlock_create_ruleset, landlock_add_rule and \
                landlock_restrict_self there, or set [sandbox] exec = \"docker\""
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

    /// The seccomp filter. `network` false: the `--network off` filter (see
    /// the module comment). `network` true: only `connect(2)` goes to the
    /// supervisor -- so it can refuse a unix socket outside the sandbox (see
    /// `unix_allowed`) -- and io_uring, whose CONNECT op would bypass that,
    /// is ENOSYS; every other socket call is allowed.
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    pub fn network_filter(network: bool) -> Vec<libc::sock_filter> {
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
        // The kernel keyrings: a session keyring the command inherits can hold
        // another program's secrets (an SSO token, a kerberos ticket), and
        // keyctl reads them by id. Nothing a build or test needs. EPERM, in
        // both network modes (PR #156 second review, finding I).
        p.extend(key_syscalls());
        if network {
            p.extend([
                Jeq(libc::SYS_connect as u32, L("notify"), Next),
                Jeq(libc::SYS_io_uring_setup as u32, L("enosys"), Next),
                Jeq(libc::SYS_io_uring_enter as u32, L("enosys"), Next),
                Jeq(libc::SYS_io_uring_register as u32, L("enosys"), Next),
                Ret(RET_ALLOW),
                Label("notify"),
                Ret(RET_USER_NOTIF),
                Label("enosys"),
                Ret(RET_ERRNO | libc::ENOSYS as u32),
                Label("eperm"),
                Ret(RET_ERRNO | libc::EPERM as u32),
                Label("kill"),
                Ret(RET_KILL_PROCESS),
            ]);
            return assemble(&p);
        }
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
            Label("eperm"),
            Ret(RET_ERRNO | libc::EPERM as u32),
            Label("kill"),
            Ret(RET_KILL_PROCESS),
        ]);
        assemble(&p)
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    fn key_syscalls() -> [Ins; 3] {
        use T::*;
        [
            Ins::Jeq(libc::SYS_keyctl as u32, L("eperm"), Next),
            Ins::Jeq(libc::SYS_add_key as u32, L("eperm"), Next),
            Ins::Jeq(libc::SYS_request_key as u32, L("eperm"), Next),
        ]
    }

    /// The filter where the supervisor cannot run (network on, pidfd_getfd
    /// refused): the keyring calls alone, no notification.
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    pub fn keys_filter() -> Vec<libc::sock_filter> {
        use Ins::*;
        use T::*;
        let mut p = vec![Ld(OFF_ARCH), Jeq(AUDIT_ARCH, Next, L("kill")), Ld(OFF_NR)];
        p.extend(key_syscalls());
        p.extend([Ret(RET_ALLOW), Label("eperm"), Ret(RET_ERRNO | libc::EPERM as u32), Label("kill"), Ret(RET_KILL_PROCESS)]);
        assemble(&p)
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    pub fn network_filter(_network: bool) -> Vec<libc::sock_filter> {
        Vec::new()
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    pub fn keys_filter() -> Vec<libc::sock_filter> {
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
        // Not "does the syscall exist" but "does it work here": on this
        // process's own pidfd, which needs no ptrace right. A container's
        // seccomp profile can refuse it outright -- Docker's default allows
        // pidfd_getfd only with CAP_SYS_PTRACE -- and then the supervisor
        // could verify no connect, loopback included. Measured 2026-11-05 in
        // a `--network none` container on the default profile: EPERM, and
        // every connect refused while this probe still said "supported".
        // SAFETY: pidfd_open of this process; the fds are closed below.
        let me = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
        if me < 0 {
            let e = errno();
            return Some(if e == libc::ENOSYS {
                "this kernel has no pidfd_open (Linux 5.3+), which network = false needs".into()
            } else {
                format!("pidfd_open is refused here (errno {e}), which network = false needs")
            });
        }
        // SAFETY: duplicating this process's own stderr through its own pidfd.
        let got = unsafe { libc::syscall(libc::SYS_pidfd_getfd, me, 2, 0) } as i32;
        let e = errno();
        // SAFETY: closed once each.
        unsafe {
            if got >= 0 {
                libc::close(got);
            }
            libc::close(me);
        }
        if got < 0 {
            return Some(match e {
                libc::ENOSYS => "this kernel has no pidfd_getfd (Linux 5.6+), which network = false needs".into(),
                _ => format!(
                    "pidfd_getfd is refused here (errno {e}), so the supervisor could verify no connect, loopback \
                     included. Inside a container this is its seccomp profile: Docker's default allows \
                     pidfd_getfd only with CAP_SYS_PTRACE (`docker run --cap-add SYS_PTRACE`)"
                ),
            });
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
        if let Ok(a) = abi {
            if a < 6 {
                degraded.push(
                    "signals are not scoped: the command can signal any process your user owns, its own supervisor \
                     included (needs Landlock ABI 6, Linux 6.12)"
                        .to_string(),
                );
            }
        }
        if let Some(n) = &net {
            degraded.push(format!("network = false cannot be enforced: {n}"));
            degraded.push(format!(
                "unix sockets are not vetted, so a daemon outside the sandbox (the session bus via systemd-run, \
                 docker, tmux, an ssh agent) can be asked to act for the command: {n}"
            ));
        }
        let ok = abi.is_ok();
        let (scoped_reads, scoped_protected) = if ok { scoped_description() } else { (vec![], vec![]) };
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
            reads_scoped_supported: ok,
            scoped_reads,
            scoped_protected,
            scoped_not_enforced: SCOPED_NOT_ENFORCED.to_vec(),
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

    /// The read rights `--reads scoped` handles. Never part of `write_rights`.
    pub const READ_RIGHTS: u64 = FS_READ_FILE | FS_READ_DIR;

    /// Confine THIS process's filesystem writes -- and, with `grants`, its
    /// reads -- irrevocably, for it and every process it starts.
    fn apply_landlock(policy: &Policy, grants: Option<&[(PathBuf, bool)]>) -> Result<(), String> {
        let abi = landlock_abi().map_err(landlock_unavailable)?;
        let handled = write_rights(abi) | if grants.is_some() { READ_RIGHTS } else { 0 };
        let scoped = scopes(abi);
        let attr = RulesetAttr { handled_access_fs: handled, handled_access_net: 0, scoped };
        // Only the fields this kernel knows: before ABI 6 a larger struct with
        // a non-zero tail is E2BIG, so hand it the first field alone.
        let size = if scoped != 0 { std::mem::size_of::<RulesetAttr>() } else { std::mem::size_of::<u64>() };
        // SAFETY: attr outlives the call, and `size` never exceeds it.
        let ruleset = unsafe {
            libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, size, 0u32)
        } as i32;
        if ruleset < 0 {
            return Err(format!("landlock_create_ruleset: {}", io::Error::last_os_error()));
        }
        let result = (|| {
            for d in policy.writable_dirs() {
                add_rule(ruleset, d, handled)?;
            }
            let ptys: Vec<PathBuf> = if grants.is_some() { own_ptys() } else { vec![PathBuf::from("/dev/pts")] };
            for p in WRITABLE_DEVICES.iter().map(PathBuf::from).chain(ptys) {
                let Ok(meta) = std::fs::metadata(&p) else { continue };
                let access = if meta.is_dir() { FS_WRITE_FILE } else { (FS_WRITE_FILE | FS_TRUNCATE) & handled & FILE_RIGHTS };
                add_rule(ruleset, &p, access)?;
            }
            for (p, is_dir) in grants.unwrap_or(&[]) {
                add_rule(ruleset, p, if *is_dir { READ_RIGHTS } else { FS_READ_FILE })?;
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

    /// `sandbox-clean`: confine THIS process's writes to beneath the directory
    /// `fd` -- the descriptor, not a path that could be re-pointed -- reads
    /// unconfined. See `super::clean`.
    pub fn confine_writes_to_fd(fd: i32) -> Result<(), String> {
        let abi = landlock_abi().map_err(landlock_unavailable)?;
        let handled = write_rights(abi);
        let attr = RulesetAttr { handled_access_fs: handled, handled_access_net: 0, scoped: 0 };
        // SAFETY: attr outlives the call; only its first field is passed.
        let ruleset = unsafe {
            libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, std::mem::size_of::<u64>(), 0u32)
        } as i32;
        if ruleset < 0 {
            return Err(format!("landlock_create_ruleset: {}", io::Error::last_os_error()));
        }
        let result = (|| {
            let rule = PathBeneathAttr { allowed_access: handled, parent_fd: fd };
            // SAFETY: rule is a valid landlock_path_beneath_attr for the call.
            if unsafe {
                libc::syscall(libc::SYS_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &rule as *const PathBeneathAttr, 0)
            } < 0
            {
                return Err(format!("landlock_add_rule: {}", io::Error::last_os_error()));
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
    fn install_network_filter(network: bool) -> Result<i32, String> {
        let filter = network_filter(network);
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

    /// The keyring filter alone (see `keys_filter`), best effort: where seccomp
    /// itself is refused, the keyring is the one thing not denied, and the
    /// probe already says the supervisor cannot run here.
    fn install_keys_filter() {
        let filter = keys_filter();
        if filter.is_empty() {
            return;
        }
        let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr() as *mut libc::sock_filter };
        // SAFETY: prog points at `filter`, which outlives the call; no_new_privs
        // was set by apply_landlock.
        unsafe { libc::syscall(libc::SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog as *const libc::sock_fprog) };
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

    pub fn run(policy: &Policy, grants: Option<&[(PathBuf, bool)]>, argv: &[String]) -> ! {
        if policy.network {
            // The network is open, but a unix socket outside the sandbox is
            // not "the network": it is a daemon (the session bus, docker,
            // tmux, an ssh agent) that acts outside the sandbox for whoever
            // connects. Where the supervisor can run, it vets every connect
            // for that (connect-only filter, `unix_allowed`).
            if network_unavailable().is_none() && landlock_abi().is_ok() {
                supervised(policy, grants, argv)
            }
            // Where it cannot (a container whose seccomp profile refuses
            // pidfd_getfd), filesystem only -- and the probe says so in
            // `degraded`, so it is not a silent difference.
            if let Err(e) = apply_landlock(policy, grants) {
                refuse(&e);
            }
            install_keys_filter();
            // No supervisor to report: the command must not inherit the fd.
            if let Some(r) = policy.report_fd {
                // SAFETY: closed once.
                unsafe { libc::close(r) };
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
        supervised(policy, grants, argv)
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

    fn supervised(policy: &Policy, grants: Option<&[(PathBuf, bool)]>, argv: &[String]) -> ! {
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
                // SAFETY: closing fds this process owns. The report fd first:
                // a command that could write it could name any process as a
                // supervisor, and sandbox-kill would then signal its children.
                unsafe {
                    libc::close(status[0]);
                    if let Some(r) = policy.report_fd {
                        libc::close(r);
                    }
                }
                supervisor(policy, grants, argv, status[1], chan)
            }
            s_pid => {
                // G
                // SAFETY: closing fds this process owns.
                unsafe {
                    libc::close(status[1]);
                    libc::close(chan[0]);
                    libc::close(chan[1]);
                }
                if let Some(r) = policy.report_fd {
                    // The pid and its start time, read while S is this
                    // process's unreaped child -- so the pid cannot have been
                    // reused yet -- and checked against /proc again by
                    // whoever uses it later.
                    let start = super::proc_parent_and_start(s_pid).map(|(_, st)| st).unwrap_or(0);
                    write_all(r, format!("{s_pid} {start}\n").as_bytes());
                    // SAFETY: closed once.
                    unsafe { libc::close(r) };
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
                        // FAIL CLOSED. S is gone, so nothing vets the command's
                        // connects and nothing reaps it; the command itself
                        // dies with S (PR_SET_PDEATHSIG), and whatever it
                        // started in this process group goes now. Only when G
                        // leads its own group, as gnomon starts it: anywhere
                        // else the group is the caller's.
                        eprintln!(
                            "gnomon-exec: sandbox refused: the sandbox supervisor exited without reporting the command's \
                             status; the command and its process group are killed"
                        );
                        // SAFETY: plain calls with integer arguments.
                        unsafe {
                            if libc::getpgrp() == libc::getpid() {
                                libc::kill(0, libc::SIGKILL);
                            }
                        }
                        std::process::exit(SANDBOX_REFUSED);
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

    fn supervisor(policy: &Policy, grants: Option<&[(PathBuf, bool)]>, argv: &[String], status_w: i32, chan: [i32; 2]) -> ! {
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
            command(policy, grants, argv, chan[1]);
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

        // Directory descriptors for the allowed trees, opened now, before
        // the command runs: every unix-socket path is resolved relative to
        // one of these, so no later rename above them can redirect it.
        let allowed: Vec<PathBuf> = policy.writable_dirs().into_iter().map(Path::to_path_buf).collect();
        let dirfds = allowed.iter().map(|d| open_dir_path(d)).collect();
        let ctx = Arc::new(Vetting {
            allowed,
            dirfds,
            slash: open_dir_path(Path::new("/")),
            network: policy.network,
            loopback: policy.loopback,
        });
        serve(listener, child, pidfd, status_w, ctx)
    }

    /// What the supervisor vets a connect against.
    pub struct Vetting {
        /// Directories a pathname unix socket may live beneath: the root and
        /// the writable directories (canonical).
        pub allowed: Vec<PathBuf>,
        /// O_PATH descriptors of `allowed`, index for index (-1: could not open).
        pub dirfds: Vec<i32>,
        /// O_PATH descriptor of `/`, for SYSTEM_QUERY_SOCKETS.
        pub slash: i32,
        /// `--network on`: any inet destination. Off: loopback only.
        pub network: bool,
        /// Off with this false (`--network none`): not loopback either.
        pub loopback: bool,
    }

    /// C: confine, filter, hand the listener to S, become the command.
    fn command(policy: &Policy, grants: Option<&[(PathBuf, bool)]>, argv: &[String], chan: i32) -> ! {
        // Die with the supervisor. Without it a killed S left the command
        // running, unsupervised, with nobody waiting on it (fail-closed gap).
        // SAFETY: plain prctl / getppid.
        unsafe {
            let s = libc::getppid();
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
            if libc::getppid() != s {
                libc::_exit(SANDBOX_REFUSED);
            }
        }
        if let Err(e) = apply_landlock(policy, grants) {
            refuse(&e);
        }
        let listener = match install_network_filter(policy.network) {
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
    fn serve(listener: i32, child: i32, pidfd: i32, status_w: i32, ctx: Arc<Vetting>) -> ! {
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
                    let ctx = ctx.clone();
                    // A connect can block (a unix socket with a full backlog),
                    // and one stalled connect must not stall every other.
                    std::thread::spawn(move || answer_connect(listener, req, &notices, &ctx));
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

    fn answer_connect(listener: i32, req: libc::seccomp_notif, notices: &AtomicUsize, ctx: &Vetting) {
        let mut resp = libc::seccomp_notif_resp { id: req.id, val: 0, error: 0, flags: 0 };
        let error = connect_for(listener, &req, notices, ctx);
        match error {
            Ok(()) => {}
            Err(e) => resp.error = -e,
        }
        // SAFETY: resp is a correctly sized seccomp_notif_resp. ENOENT (the
        // caller is gone) needs no handling.
        unsafe { libc::ioctl(listener, libc::SECCOMP_IOCTL_NOTIF_SEND as _, &mut resp) };
    }

    /// Is a pathname unix socket at `p` (absolute) inside the sandbox -- beneath
    /// the root or a writable directory? `Ok` carries its canonical path, which
    /// is what gets connected to. A socket elsewhere (the session bus, docker,
    /// tmux, an ssh agent, systemd's private socket) is a daemon that would act
    /// OUTSIDE the sandbox on the command's behalf: `systemd-run --user --pipe`
    /// read keys under reads = scoped, wrote outside the root and reached the
    /// network under network = false, until this check.
    /// System sockets that answer lookups and act on nothing: glibc's name
    /// service cache, systemd-resolved (nss-resolve -- DNS fails without it on
    /// a host whose nsswitch.conf says `resolve`), systemd's user database
    /// (nss-systemd), and journald's log sockets. Each is matched exactly,
    /// after canonicalising, so nothing else under /run is reachable.
    pub const SYSTEM_QUERY_SOCKETS: &[&str] = &[
        "/run/nscd/socket",
        "/run/systemd/resolve/io.systemd.Resolve",
        "/run/systemd/userdb/io.systemd.Multiplexer",
        "/run/systemd/userdb/io.systemd.NameServiceSwitch",
        "/run/systemd/userdb/io.systemd.DynamicUser",
        "/run/systemd/journal/stdout",
        "/run/systemd/journal/socket",
        "/run/systemd/journal/dev-log",
    ];

    pub fn unix_allowed(p: &Path, allowed: &[PathBuf]) -> Result<PathBuf, i32> {
        let canon = match std::fs::canonicalize(p) {
            Ok(c) => c,
            Err(_) => {
                // Not there (yet): judge where it would be, and let the connect
                // say ENOENT if it is inside.
                let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { return Err(libc::EACCES) };
                match std::fs::canonicalize(parent) {
                    Ok(d) => d.join(name),
                    // Nothing there to reach: say so, as the connect would.
                    Err(_) => return Err(libc::ENOENT),
                }
            }
        };
        if allowed.iter().any(|a| canon.starts_with(a)) || SYSTEM_QUERY_SOCKETS.iter().any(|q| canon == Path::new(q)) {
            Ok(canon)
        } else {
            Err(libc::EACCES)
        }
    }

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;

    /// openat2(2): `rel` beneath `dirfd`, following no symlink at all -- not
    /// in the middle, not at the end -- and never leaving `dirfd` by `..`.
    pub fn openat2_strict(dirfd: i32, rel: &Path, flags: i32) -> Result<i32, i32> {
        let c = CString::new(rel.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
        let how = OpenHow {
            flags: (flags | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
        };
        // SAFETY: c and how outlive the call; the size is how's.
        let fd = unsafe {
            libc::syscall(libc::SYS_openat2, dirfd, c.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>())
        } as i32;
        if fd < 0 {
            Err(errno())
        } else {
            Ok(fd)
        }
    }

    fn open_dir_path(d: &Path) -> i32 {
        let c = cstr(d);
        // SAFETY: c is a valid path.
        unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) }
    }

    /// Normalise `.` and `..` lexically (no filesystem access).
    fn lexical(p: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                std::path::Component::ParentDir => {
                    out.pop();
                }
                std::path::Component::CurDir => {}
                other => out.push(other.as_os_str()),
            }
        }
        out
    }

    /// The socket at `abs`, opened O_PATH beneath an allowed tree (or as one
    /// of SYSTEM_QUERY_SOCKETS beneath `/`) with no symlink anywhere on the
    /// way, and checked to BE a socket. EACCES: not allowed; ENOENT: nothing
    /// there. The caller connects through the descriptor, so what was checked
    /// is what is reached.
    pub fn open_unix_target(abs: &Path, ctx: &Vetting) -> Result<i32, i32> {
        let lex = lexical(abs);
        // A path spelled through a symlink to the root (a symlinked cwd):
        // judge where it lands, then open THAT spelling, symlink-free, so a
        // swap after this point fails the open instead of redirecting it.
        let canon = unix_allowed(&lex, &ctx.allowed);
        // Nothing there to reach, inside or out: say so, as the connect would.
        let mut last = if canon == Err(libc::ENOENT) { libc::ENOENT } else { libc::EACCES };
        let candidates = [Some(lex.clone()), canon.ok()];
        for cand in candidates.iter().flatten() {
            let (base, rel): (i32, PathBuf) = if let Some((i, a)) = ctx.allowed.iter().enumerate().find(|(_, a)| cand.starts_with(a)) {
                let rel = cand.strip_prefix(a).unwrap_or(Path::new("")).to_path_buf();
                (ctx.dirfds.get(i).copied().unwrap_or(-1), rel)
            } else if SYSTEM_QUERY_SOCKETS.iter().any(|q| cand == Path::new(q)) {
                (ctx.slash, cand.strip_prefix("/").unwrap_or(cand).to_path_buf())
            } else {
                continue;
            };
            if base < 0 || rel.as_os_str().is_empty() {
                continue;
            }
            match openat2_strict(base, &rel, libc::O_PATH | libc::O_NOFOLLOW) {
                Ok(fd) => {
                    // SAFETY: a zeroed stat is valid output space.
                    let mut st: libc::stat = unsafe { std::mem::zeroed() };
                    // SAFETY: fd is ours.
                    let isock = unsafe { libc::fstat(fd, &mut st) } == 0 && (st.st_mode & libc::S_IFMT) == libc::S_IFSOCK;
                    if isock {
                        return Ok(fd);
                    }
                    // SAFETY: closed once.
                    unsafe { libc::close(fd) };
                    return Err(libc::ECONNREFUSED);
                }
                Err(libc::ENOENT) => last = libc::ENOENT,
                // ELOOP (a symlink on the way), EXDEV (`..` out of the tree),
                // ENOSYS (no openat2, Linux < 5.6): refused.
                Err(_) => last = libc::EACCES,
            }
        }
        Err(last)
    }

    /// A sockaddr_un for `path`, or None if it does not fit.
    fn sun_path(path: &Path) -> Option<Vec<u8>> {
        let bytes = path.as_os_str().as_bytes();
        if bytes.len() >= 108 {
            return None;
        }
        let mut a = (libc::AF_UNIX as u16).to_ne_bytes().to_vec();
        a.extend_from_slice(bytes);
        a.push(0);
        Some(a)
    }

    /// The peer a connected unix socket reached, as the server bound it.
    enum Peer {
        Path(PathBuf),
        Abstract,
        /// Unnamed, or bound by a relative name we cannot place.
        Unknown,
    }

    fn peer_of(fd: i32) -> Peer {
        // SAFETY: a zeroed sockaddr_un is valid output space of the given size.
        let mut sa: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: sa has `len` bytes.
        if unsafe { libc::getpeername(fd, (&mut sa as *mut libc::sockaddr_un).cast(), &mut len) } != 0 {
            return Peer::Unknown;
        }
        let n = (len as usize).saturating_sub(2).min(sa.sun_path.len());
        // c_char is i8 on x86_64 and u8 on aarch64: the cast is needed on one.
        #[allow(clippy::unnecessary_cast)]
        let raw: Vec<u8> = sa.sun_path[..n].iter().map(|c| *c as u8).collect();
        match raw.first() {
            None => Peer::Unknown,
            Some(0) => Peer::Abstract,
            Some(b'/') => {
                let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
                Peer::Path(PathBuf::from(std::ffi::OsStr::from_bytes(&raw[..end])))
            }
            Some(_) => Peer::Unknown,
        }
    }

    fn notice(notices: &AtomicUsize, what: std::fmt::Arguments) {
        if notices.fetch_add(1, Ordering::Relaxed) < 5 {
            eprintln!("gnomon-exec: {what}");
        }
    }

    /// Perform the caller's connect() on its behalf, if the destination is
    /// allowed: under `--network off` a loopback address, under either mode a
    /// unix socket inside the sandbox. Returns the errno the caller should see.
    fn connect_for(listener: i32, req: &libc::seccomp_notif, notices: &AtomicUsize, ctx: &Vetting) -> Result<(), i32> {
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
        if len < 2 {
            return Err(libc::EINVAL);
        }

        // 2. Decide.
        let mut target_fd: Option<i32> = None;
        let close_target = |t: Option<i32>| {
            if let Some(fd) = t {
                // SAFETY: closed once.
                unsafe { libc::close(fd) };
            }
        };
        let family = u16::from_ne_bytes([addr[0], addr[1]]) as i32;
        let unix_path = family == libc::AF_UNIX && len > 2;
        if unix_path {
            if addr[2] == 0 {
                // Abstract: no file, no directory to judge it by, and the
                // namespace is shared with every daemon on the machine (a D-Bus
                // bus, X11). Refused; a socket the command itself makes inside
                // the root works.
                notice(notices, format_args!("blocked connect to an abstract unix socket (only sockets beneath the root or the temp dir are allowed)"));
                return Err(libc::EACCES);
            }
            let end = addr[2..].iter().position(|b| *b == 0).map(|i| i + 2).unwrap_or(len);
            let named = Path::new(std::ffi::OsStr::from_bytes(&addr[2..end])).to_path_buf();
            // A relative path names a file relative to the CALLER's working
            // directory, not this process's.
            let abs = if named.is_absolute() {
                named
            } else {
                let Ok(cwd) = std::fs::read_link(format!("/proc/{}/cwd", req.pid)) else { return Err(libc::ENOENT) };
                cwd.join(named)
            };
            // Resolve the socket file ONCE, race-free, to a descriptor, and
            // connect through that descriptor (/proc/self/fd/N), never by
            // the path again. Canonicalising and then connecting by name
            // (the first fix) lost to a symlink swapped in between; the
            // check after the connect came too late, since a forked child
            // sharing the socket had already written (second review, C).
            match open_unix_target(&abs, ctx) {
                Ok(fd) => {
                    target_fd = Some(fd);
                    addr = sun_path(Path::new(&format!("/proc/self/fd/{fd}"))).ok_or(libc::ENAMETOOLONG)?;
                }
                Err(e) if e != libc::EACCES => return Err(e),
                Err(e) => {
                    notice(
                        notices,
                        format_args!(
                            "blocked connect to unix socket {} (outside the root and the temp dir, or reached through a symlink: a daemon there acts outside the sandbox)",
                            abs.display()
                        ),
                    );
                    return Err(e);
                }
            }
        } else if !ctx.network {
            match is_local(&addr) {
                None => return Err(libc::EINVAL),
                Some(false) => {
                    notice(notices, format_args!("network = false: blocked connect to {} (only loopback is allowed)", describe(&addr)));
                    return Err(libc::EACCES);
                }
                Some(true) if !ctx.loopback => {
                    notice(notices, format_args!("network = none: blocked connect to {} (loopback too)", describe(&addr)));
                    return Err(libc::EACCES);
                }
                Some(true) => {}
            }
        }

        // 3. Connect the caller's own socket, from here.
        let r = connect_caller(listener, req, notices, ctx, fd, &addr, unix_path);
        close_target(target_fd);
        r
    }

    fn connect_caller(
        listener: i32,
        req: &libc::seccomp_notif,
        notices: &AtomicUsize,
        ctx: &Vetting,
        fd: i32,
        addr: &[u8],
        unix_path: bool,
    ) -> Result<(), i32> {
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
            notice(notices, format_args!("could not verify a connect (pidfd_getfd: errno {getfd_err}); refused"));
            return Err(libc::EACCES);
        }

        // SAFETY: addr holds a sockaddr of addr.len() bytes.
        let r = unsafe { libc::connect(theirs, addr.as_ptr().cast(), addr.len() as libc::socklen_t) };
        let e = errno();
        let mut result = if r < 0 { Err(e) } else { Ok(()) };

        // 4. A unix connect that went through: check whom it reached. The
        //    path was checked before, but a directory under the root can be
        //    swapped for a symlink between that check and the connect; the
        //    server's own bound name cannot.
        if unix_path && result.is_ok() {
            let outside = match peer_of(theirs) {
                Peer::Abstract => Some("an abstract socket".to_string()),
                Peer::Path(p) => unix_allowed(&p, &ctx.allowed).err().map(|_| p.display().to_string()),
                // A server bound by a relative name, or one getpeername cannot
                // name: nothing to judge it by, so refused (second review, C).
                Peer::Unknown => Some("a socket whose server cannot be named (bind it by an absolute path)".to_string()),
            };
            if let Some(what) = outside {
                // SAFETY: shutting down the caller's socket through our duplicate.
                unsafe { libc::shutdown(theirs, libc::SHUT_RDWR) };
                notice(notices, format_args!("blocked connect to unix socket {what} (reached outside the sandbox; shut down)"));
                result = Err(libc::EACCES);
            }
        }
        // SAFETY: closed once.
        unsafe { libc::close(theirs) };
        result
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
            let f = network_filter(false);
            let on = network_filter(true);
            if NETWORK_ARCH_SUPPORTED {
                assert!(f.len() > 20 && f.len() < 100, "{} instructions", f.len());
                assert_eq!(f.last().unwrap().k, RET_KILL_PROCESS);
                assert!(on.len() > 5 && on.len() < 24, "{} instructions", on.len());
                assert_eq!(on.last().unwrap().k, RET_KILL_PROCESS);
                let k = keys_filter();
                assert!(k.len() > 5 && k.len() < 12, "{} instructions", k.len());
            }
        }

        #[test]
        fn read_rights_are_separate_from_write_rights() {
            for abi in 1..=7 {
                assert_eq!(write_rights(abi) & READ_RIGHTS, 0, "write_rights must not handle reads (reads = all)");
            }
            assert_eq!(READ_RIGHTS & FS_EXECUTE, 0, "EXECUTE stays unhandled; exec needs READ_FILE anyway");
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

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[test]
    fn a_grant_exposes_a_credential_beneath_it_or_around_it() {
        let protected = vec![PathBuf::from("/home/u/.ssh"), PathBuf::from("/home/u/.cargo/credentials.toml")];
        assert_eq!(exposes(Path::new("/home/u"), &protected), Some(&protected[0]), "a grant of HOME covers ~/.ssh");
        assert_eq!(exposes(Path::new("/"), &protected), Some(&protected[0]));
        assert_eq!(exposes(Path::new("/home/u/.ssh/keys"), &protected), Some(&protected[0]), "inside one");
        assert_eq!(exposes(Path::new("/home/u/.cargo"), &protected), Some(&protected[1]), "~/.cargo holds credentials.toml");
        assert_eq!(exposes(Path::new("/home/u/.cargo/registry"), &protected), None);
        assert_eq!(exposes(Path::new("/home/u/project"), &protected), None);
        // Component-wise, not string prefixes: ~/.sshd is not ~/.ssh.
        assert_eq!(exposes(Path::new("/home/u/.sshd"), &protected), None);
    }

    #[test]
    fn no_default_read_grant_covers_a_protected_location() {
        let home = Path::new("/h");
        let protected: Vec<PathBuf> = PROTECTED_HOME.iter().map(|r| home.join(r)).collect();
        for rel in HOME_TOOLCHAIN_READ {
            assert_eq!(exposes(&home.join(rel), &protected), None, "~/{rel} would expose a credential");
        }
        for s in SYSTEM_READ {
            assert_eq!(exposes(Path::new(s), &protected), None, "{s}");
        }
    }

    /// Third review, finding 11: git's config files are granted, and they
    /// often hold tokens. Granting them is published as a limit, not hidden.
    #[test]
    fn the_git_config_grant_is_published_as_a_limit() {
        for f in [".gitconfig", ".config/git/config"] {
            assert!(HOME_TOOLCHAIN_READ.contains(&f), "{f} is granted");
            let named = format!("~/{f}");
            assert!(
                SCOPED_NOT_ENFORCED.iter().any(|l| l.contains(&named) && l.contains("token")),
                "{named} is granted, and a token in it readable, but SCOPED_NOT_ENFORCED does not say so"
            );
        }
    }

    #[test]
    fn the_protected_list_names_the_usual_credential_stores() {
        for must in [".ssh", ".aws", ".config/gh", ".netrc", ".docker", ".gnupg", ".local/share/gnomon/credentials.json", ".mozilla", ".config/google-chrome"] {
            assert!(PROTECTED_HOME.contains(&must), "{must}");
        }
    }
}
