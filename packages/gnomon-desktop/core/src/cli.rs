//! Finding the gnomon CLI this machine already has, and asking it what it can do.
//!
//! The desktop app does not bundle gnomon. It runs the one the user installed
//! (`npm i -g gnomon-harness` or the installer script), which is the same
//! gnomon that wrote the records the dashboard reads: one engine, no second
//! copy at another version. README "Desktop app" explains the choice.
//!
//! A GUI app does not get a login shell's PATH (macOS starts it with
//! `/usr/bin:/bin:/usr/sbin:/sbin`), so beyond PATH this looks where npm,
//! the installer, nvm, Volta, pnpm and Homebrew put global binaries. And
//! because npm's `gnomon` is a `#!/usr/bin/env node` script, the child gets a
//! PATH that starts with gnomon's own directory, where node usually is too.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::spawn::{capture, prepare, Captured};

/// What a probe learned from `gnomon --help`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliProbe {
    pub program: PathBuf,
    /// The build line, e.g. `gnomon/0.4.0+abc1234`.
    pub version: String,
    pub commands: BTreeSet<String>,
}

impl CliProbe {
    pub fn has(&self, command: &str) -> bool {
        self.commands.contains(command)
    }
}

/// File names a gnomon executable can have here.
pub fn executable_names() -> &'static [&'static str] {
    if cfg!(windows) {
        // npm writes gnomon.cmd (and a .ps1 and an sh script, neither of
        // which CreateProcess can run); an .exe would be a future standalone.
        &["gnomon.exe", "gnomon.cmd", "gnomon.bat"]
    } else {
        &["gnomon"]
    }
}

/// Is this a file name a gnomon executable may have on this OS? For a
/// program the user locates by hand.
pub fn acceptable_program(path: &Path) -> bool {
    if cfg!(windows) {
        matches!(
            path.extension()
                .and_then(OsStr::to_str)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("exe" | "cmd" | "bat")
        )
    } else {
        true
    }
}

fn push_unique(out: &mut Vec<PathBuf>, p: PathBuf) {
    if !p.as_os_str().is_empty() && !out.iter().any(|q| q == &p) {
        out.push(p);
    }
}

/// `v22.22.2` -> (22, 22, 2), for newest-first ordering of nvm's versions.
fn node_version_key(name: &str) -> (u64, u64, u64) {
    let mut it = name
        .trim_start_matches('v')
        .split('.')
        .map(|x| x.parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// Every `<dir>/<version>/bin` under nvm's versions dir, newest first.
fn nvm_bins(versions: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(versions) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort_by_key(|n| std::cmp::Reverse(node_version_key(n)));
    names
        .into_iter()
        .map(|n| versions.join(n).join("bin"))
        .collect()
}

/// Where to look for gnomon, in order: PATH, then the places package
/// managers and gnomon's installer put global binaries.
///
/// `env` reads an environment variable; `home` is the user's home directory.
/// Both are parameters so the order can be tested without touching the real
/// environment.
pub fn candidate_dirs(env: &dyn Fn(&str) -> Option<OsString>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = env("PATH") {
        for p in std::env::split_paths(&path) {
            push_unique(&mut out, p);
        }
    }
    // Where `pnpm link --global` puts gnomon (a source checkout's
    // `pnpm run setup`), when the shell that set it is not this app's.
    if let Some(p) = env("PNPM_HOME") {
        push_unique(&mut out, PathBuf::from(p));
    }
    if cfg!(windows) {
        // npm's default global prefix, pnpm's, nvm-windows' symlink, Volta.
        if let Some(appdata) = env("APPDATA") {
            push_unique(&mut out, PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = env("LOCALAPPDATA") {
            push_unique(&mut out, PathBuf::from(&local).join("pnpm"));
            push_unique(&mut out, PathBuf::from(&local).join("Volta").join("bin"));
        }
        if let Some(link) = env("NVM_SYMLINK") {
            push_unique(&mut out, PathBuf::from(link));
        }
        if let Some(pf) = env("ProgramFiles") {
            push_unique(&mut out, PathBuf::from(pf).join("nodejs"));
        }
    } else {
        if let Some(bin) = env("NVM_BIN") {
            push_unique(&mut out, PathBuf::from(bin));
        }
        if let Some(h) = home {
            // gnomon's installer falls back to ~/.local when npm's prefix is
            // not writable; ~/.npm-global is npm's documented no-sudo prefix.
            push_unique(&mut out, h.join(".local").join("bin"));
            push_unique(&mut out, h.join(".npm-global").join("bin"));
            push_unique(&mut out, h.join(".volta").join("bin"));
            push_unique(&mut out, h.join("Library").join("pnpm"));
            push_unique(&mut out, h.join(".local").join("share").join("pnpm"));
            for b in nvm_bins(&h.join(".nvm").join("versions").join("node")) {
                push_unique(&mut out, b);
            }
            push_unique(
                &mut out,
                h.join(".local")
                    .join("share")
                    .join("fnm")
                    .join("aliases")
                    .join("default")
                    .join("bin"),
            );
        }
        push_unique(&mut out, PathBuf::from("/opt/homebrew/bin"));
        push_unique(&mut out, PathBuf::from("/usr/local/bin"));
        push_unique(&mut out, PathBuf::from("/usr/bin"));
    }
    out
}

#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(p: &Path) -> bool {
    p.is_file()
}

/// The first `dir/name` that is an executable file, trying every name in a
/// directory before moving to the next directory.
pub fn find_in(dirs: &[PathBuf], names: &[&str]) -> Option<PathBuf> {
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| is_executable_file(p))
}

/// The PATH the gnomon child runs with: gnomon's own directory first (where
/// npm put node, for `#!/usr/bin/env node`), then every candidate directory.
pub fn child_path(program: &Path, dirs: &[PathBuf]) -> OsString {
    let mut all = Vec::new();
    if let Some(parent) = program.parent() {
        push_unique(&mut all, parent.to_path_buf());
    }
    for d in dirs {
        push_unique(&mut all, d.clone());
    }
    std::env::join_paths(all).unwrap_or_default()
}

/// The commands a `gnomon --help` lists. The same reading as the dashboard
/// server's own `listedCommands` (dashboard_server.ts): the text after
/// `Commands:`, a two-space indent, a lower-case name.
pub fn listed_commands(help: &str) -> BTreeSet<String> {
    let Some(at) = help.find("Commands:") else {
        return BTreeSet::new();
    };
    let mut out = BTreeSet::new();
    for line in help[at..].lines().skip(1) {
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_lowercase() || *c == '-')
            .collect();
        if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_lowercase()) {
            continue;
        }
        // The name must end the line or be followed by a space or `[`.
        match rest[name.len()..].chars().next() {
            None | Some(' ') | Some('[') => {
                out.insert(name);
            }
            _ => {}
        }
    }
    out
}

/// The build line `gnomon --help` starts with (`gnomon/0.4.0+abc — ...`).
/// `None` when the output is not gnomon's.
pub fn version_line(help: &str) -> Option<String> {
    let first = help.lines().map(str::trim).find(|l| !l.is_empty())?;
    let build = first.split(" — ").next().unwrap_or(first).trim();
    if build.starts_with("gnomon/") && !build.contains(char::is_whitespace) {
        Some(build.to_string())
    } else {
        None
    }
}

/// Why a probe failed, in words for the launcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    NotFound,
    Failed(String),
    NotGnomon(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::NotFound => {
                write!(f, "no gnomon on PATH or in the usual install locations")
            }
            ProbeError::Failed(why) => write!(f, "gnomon --help did not run: {why}"),
            ProbeError::NotGnomon(p) => write!(f, "{p} does not answer --help the way gnomon does"),
        }
    }
}

/// Run `<program> --help` and read it. The probe runs in the system temp
/// directory, so it never reads a project.
pub fn probe(program: &Path, path_env: &OsStr, timeout: Duration) -> Result<CliProbe, ProbeError> {
    let mut cmd = Command::new(program);
    cmd.arg("--help")
        .current_dir(std::env::temp_dir())
        .env("PATH", path_env)
        .env("NO_COLOR", "1")
        .env("GNOMON_NO_UPDATE_CHECK", "1");
    prepare(&mut cmd);
    let Captured {
        status,
        stdout,
        stderr,
        timed_out,
    } = capture(cmd, timeout).map_err(|e| ProbeError::Failed(e.to_string()))?;
    if timed_out {
        return Err(ProbeError::Failed(format!(
            "no answer in {} s",
            timeout.as_secs()
        )));
    }
    let Some(version) = version_line(&stdout) else {
        if status != Some(0) {
            let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
            let how =
                status.map_or_else(|| "ended by a signal".to_string(), |c| format!("exit {c}"));
            return Err(ProbeError::Failed(format!("{how}: {tail}")));
        }
        return Err(ProbeError::NotGnomon(program.display().to_string()));
    };
    Ok(CliProbe {
        program: program.to_path_buf(),
        version,
        commands: listed_commands(&stdout),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELP: &str = "gnomon/0.4.0+a7d549b8 — deterministic coding agent harness

Commands:
  launch [--dir <path>] [--from <path>]
    Start working here. Creates .gnomon/ if it is missing, then opens the
    interactive loop. This is the one command to remember.

  init [--dir <path>]
    Write a .gnomon/ surface into a project.

  surface [manifest|hash|paths] [--dir <path>]
  enumerations
    Show the enumerations contract

  dashboard [--port <n>] [--no-open] [--dir <path>]
    A read-only command center.

  skill-trial
  Not-a-command here
";

    #[test]
    fn reads_commands_the_way_the_dashboard_server_does() {
        let c = listed_commands(HELP);
        for name in [
            "launch",
            "init",
            "surface",
            "enumerations",
            "dashboard",
            "skill-trial",
        ] {
            assert!(c.contains(name), "{name} in {c:?}");
        }
        // Description lines are indented four spaces and are not commands.
        assert!(!c.contains("start"));
        assert!(!c.contains("write"));
        assert!(!c.contains("Not"));
        assert!(!c.contains("setup"));
    }

    #[test]
    fn nothing_before_commands_counts() {
        assert!(listed_commands("  dashboard [--port]\n").is_empty());
    }

    #[test]
    fn version_is_the_build_line() {
        assert_eq!(version_line(HELP).as_deref(), Some("gnomon/0.4.0+a7d549b8"));
        assert_eq!(
            version_line("\n\ngnomon/0.3.2+npm — x").as_deref(),
            Some("gnomon/0.3.2+npm")
        );
        assert_eq!(
            version_line("gnomon/0.4.0+abc\n").as_deref(),
            Some("gnomon/0.4.0+abc")
        );
        assert_eq!(version_line("Usage: gnomon [options]"), None);
        assert_eq!(version_line("gnomon is a logging utility"), None);
        assert_eq!(version_line(""), None);
    }

    #[test]
    fn nvm_versions_newest_first() {
        let t = tempfile::tempdir().unwrap();
        for v in ["v18.20.1", "v22.22.2", "v22.3.0", "v20.11.0"] {
            std::fs::create_dir_all(t.path().join(v).join("bin")).unwrap();
        }
        let got: Vec<String> = nvm_bins(t.path())
            .iter()
            .map(|p| {
                p.parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(got, ["v22.22.2", "v22.3.0", "v20.11.0", "v18.20.1"]);
    }

    #[test]
    fn path_comes_first_and_nothing_repeats() {
        let home = PathBuf::from(if cfg!(windows) {
            r"C:\Users\u"
        } else {
            "/home/u"
        });
        let first = if cfg!(windows) {
            r"C:\tools"
        } else {
            "/opt/tools"
        };
        let path = std::env::join_paths([PathBuf::from(first), PathBuf::from(first)]).unwrap();
        let env = move |k: &str| -> Option<OsString> {
            match k {
                "PATH" => Some(path.clone()),
                "APPDATA" => Some(r"C:\Users\u\AppData\Roaming".into()),
                _ => None,
            }
        };
        let dirs = candidate_dirs(&env, Some(&home));
        assert_eq!(dirs[0], PathBuf::from(first));
        assert_eq!(
            dirs.iter()
                .filter(|d| d.as_path() == Path::new(first))
                .count(),
            1
        );
        if cfg!(windows) {
            assert!(dirs.contains(&PathBuf::from(r"C:\Users\u\AppData\Roaming\npm")));
        } else {
            assert!(dirs.contains(&home.join(".local/bin")));
            assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn finds_only_executable_files() {
        let _serial = crate::test_serial();
        use std::os::unix::fs::PermissionsExt;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        // In a: a gnomon that is not executable, and a directory named gnomon.
        std::fs::write(a.path().join("gnomon"), "#!/bin/sh\n").unwrap();
        let c = tempfile::tempdir().unwrap();
        std::fs::create_dir(c.path().join("gnomon")).unwrap();
        // In b: the real one.
        let real = b.path().join("gnomon");
        std::fs::write(&real, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dirs = vec![
            a.path().to_path_buf(),
            c.path().to_path_buf(),
            b.path().to_path_buf(),
        ];
        assert_eq!(find_in(&dirs, executable_names()), Some(real));
        assert_eq!(find_in(&dirs[..2], executable_names()), None);
    }

    #[test]
    fn child_path_puts_gnomons_dir_first() {
        let prog = if cfg!(windows) {
            PathBuf::from(r"C:\n\gnomon.cmd")
        } else {
            PathBuf::from("/n/gnomon")
        };
        let other = if cfg!(windows) {
            PathBuf::from(r"C:\x")
        } else {
            PathBuf::from("/x")
        };
        let p = child_path(
            &prog,
            &[other.clone(), prog.parent().unwrap().to_path_buf()],
        );
        let parts: Vec<PathBuf> = std::env::split_paths(&p).collect();
        assert_eq!(parts, vec![prog.parent().unwrap().to_path_buf(), other]);
    }

    #[test]
    fn program_names_by_os() {
        if cfg!(windows) {
            assert!(acceptable_program(Path::new(r"C:\a\gnomon.CMD")));
            assert!(acceptable_program(Path::new(r"C:\a\gnomon.exe")));
            assert!(!acceptable_program(Path::new(r"C:\a\gnomon.ps1")));
            assert!(!acceptable_program(Path::new(r"C:\a\gnomon")));
        } else {
            assert!(acceptable_program(Path::new("/a/gnomon")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_reads_a_gnomon_and_refuses_something_else() {
        let _serial = crate::test_serial();
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let g = t.path().join("gnomon");
        std::fs::write(&g, format!("#!/bin/sh\ncat <<'EOF'\n{HELP}EOF\n")).unwrap();
        std::fs::set_permissions(&g, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = child_path(&g, &[PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
        let p = probe(&g, &path, Duration::from_secs(10)).expect("probe");
        assert_eq!(p.version, "gnomon/0.4.0+a7d549b8");
        assert!(p.has("dashboard"));
        assert!(!p.has("setup"));

        let other = t.path().join("other");
        std::fs::write(&other, "#!/bin/sh\necho 'logging utility'\n").unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            probe(&other, &path, Duration::from_secs(10)),
            Err(ProbeError::NotGnomon(_))
        ));

        let failing = t.path().join("failing");
        std::fs::write(
            &failing,
            "#!/bin/sh\necho 'node: not found' >&2\nexit 127\n",
        )
        .unwrap();
        std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
        match probe(&failing, &path, Duration::from_secs(10)) {
            Err(ProbeError::Failed(why)) => assert!(why.contains("node: not found"), "{why}"),
            other => panic!("{other:?}"),
        }
    }
}
