//! gnomon-surface: resolve .gnomon/ tree, compute surface hash, emit manifests.
//!
//! This is the static aarch64 binary that makes the surface hash verifiable
//! without any JavaScript runtime. Every turn recomputes and asserts it.
//!
//! Usage:
//!   gnomon-surface manifest [--dir <path>]
//!   gnomon-surface hash [--dir <path>]
//!   gnomon-surface paths [--dir <path>]
//!   gnomon-surface --help
//!
//! `--dir` accepts either a project root (a directory that contains .gnomon/)
//! or the .gnomon/ directory itself; both name the same surface and produce
//! the same hash. See surface_dir_of for the measurement that forced that.
//!
//! The manifest subcommand outputs JSON with: build, surface_hash, sources.
//! Sources are sorted by path. Absent paths get sha256: null.
//! Hashes only — never file contents (credentials by name, never by value).

use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Version string from Cargo.toml (set at compile time).
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The standard set of paths that comprise the surface.
/// These are the paths the manifest always lists (present or absent).
const SURFACE_PATHS: &[&str] = &[
    ".gnomon/config.toml",
    ".gnomon/system.md",
    ".gnomon/roles.toml",
    ".gnomon/tools.toml",
    ".gnomon/policy.toml",
];

/// Sources listed in the manifest. Each path appears present or absent.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Source {
    path: String,
    sha256: Option<String>,
}

/// The manifest emitted by `gnomon-surface manifest`.
#[derive(Serialize, Deserialize, Debug)]
struct Manifest {
    build: String,
    surface_hash: String,
    sources: Vec<Source>,
}

/// Compute SHA256 hash of a file's contents.
/// Lowercase hex of a digest.
///
/// sha2 0.11 returns `hybrid_array::Array` where 0.10 returned
/// `generic_array::GenericArray`, and the new type does not implement
/// `LowerHex` -- so `format!("{:x}", hasher.finalize())` stopped compiling. The
/// bytes are unchanged and so is this string: SHA-256 is SHA-256, and the
/// conformance goldens are what prove it, not this comment.
fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;
    let b = bytes.as_ref();
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        let _ = write!(s, "{byte:02x}");
    }
    s
}

fn file_sha256(path: &Path) -> Option<String> {
    let contents = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&contents);
    Some(hex_digest(hasher.finalize()))
}

/// Walk the .gnomon/ directory and collect all files with their hashes.
/// Only hashes — never contents. Only walks the .gnomon/ directory itself
/// (and its subdirectories: profiles/, skills/, extensions/), not the entire repo.
fn collect_surface(dir: &Path) -> Vec<Source> {
    let mut sources: Vec<Source> = Vec::new();

    // dir is expected to be the .gnomon/ directory itself.
    // Walk all files under it (including profiles/, skills/, extensions/).
    if dir.exists() {
        for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                // Strip the .gnomon/ prefix to get relative paths like
                // "config.toml", "profiles/local_first.toml", etc.
                let relative = path.strip_prefix(dir).unwrap_or(path);
                // POSIX separators always: the path is hashed, and WalkDir yields the
    // platform separator. MAIN_SEPARATOR is '/' on unix so this is a no-op
    // there, and a filename cannot contain the separator on either platform.
    let rel_str = format!(
        ".gnomon/{}",
        relative.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")
    );

                // skills/proposed/ is staging, not surface, and must be
                // excluded here exactly as it is in the TypeScript walk --
                // two implementations of one hash that disagree would be
                // worse than either being wrong. A proposal is not loaded
                // and cannot change behaviour, so hashing it let an agent
                // move the surface hash its own audit record is stamped
                // with. Accepting a proposal moves the file into skills/,
                // which IS hashed: the moment it can affect behaviour is
                // the moment it starts counting.
                if rel_str.starts_with(".gnomon/skills/proposed/") {
                    continue;
                }

                // `extensions/` for the same reason, and it must match the
                // TypeScript walk exactly -- two implementations of one hash
                // that disagree would be worse than either being wrong.
                // Every file here is hashed by both implementations and
                // loaded by neither, so an extension dropped in moves the
                // hash while changing no behaviour. Removed rather than
                // disclosed (see the TS walk for the full reasoning, and for
                // why the remaining false-negative risk is measured rather
                // than assumed).
                if rel_str.starts_with(".gnomon/extensions/") {
                    continue;
                }


                let hash = file_sha256(path);
                sources.push(Source {
                    path: rel_str,
                    sha256: hash,
                });
            }
        }
    }

    sources
}

/// Compute the surface hash from a sorted, deterministic list of sources.
/// Sort order matters: sources are sorted by path for determinism.
fn compute_surface_hash(sources: &[Source]) -> String {
    let mut hasher = Sha256::new();
    for source in sources {
        // Hash the path + hash pair deterministically
        hasher.update(source.path.as_bytes());
        hasher.update(b":");
        if let Some(ref hash) = source.sha256 {
            hasher.update(hash.as_bytes());
        } else {
            hasher.update(b"null");
        }
        hasher.update(b"\n");
    }
    hex_digest(hasher.finalize())
}

/// Build the full source list: existing .gnomon/ files + declared paths (present or absent).
fn build_sources(dir: &Path) -> Vec<Source> {
    let existing = collect_surface(dir);

    // Build a map of existing paths for lookup
    let existing_map: std::collections::HashMap<&str, Source> = existing
        .iter()
        .map(|s| (s.path.as_str(), s.clone()))
        .collect();

    let mut sources: Vec<Source> = Vec::new();

    // First: all paths from SURFACE_PATHS (guaranteed present or absent)
    for &path in SURFACE_PATHS {
        if let Some(existing) = existing_map.get(path) {
            sources.push(existing.clone());
        } else {
            sources.push(Source {
                path: path.to_string(),
                sha256: None,
            });
        }
    }

    // Then: any additional files under .gnomon/ not in SURFACE_PATHS
    // (profiles/*.toml, skills/*/SKILL.md, extensions/*.ts, etc.)
    for existing in &existing {
        let is_in_standard = SURFACE_PATHS.contains(&existing.path.as_str());
        if !is_in_standard {
            // Avoid duplicates
            if !sources.iter().any(|s| s.path == existing.path) {
                sources.push(existing.clone());
            }
        }
    }

    // Sort by path for determinism — this is critical.
    // Do NOT iterate a hash map.
    sources.sort_by(|a, b| a.path.cmp(&b.path));

    sources
}

/// `-c` overrides on every git this binary runs: the subset of
/// packages/gnomon-core/src/git_safe.ts GIT_HARDENING a rev-parse and a status
/// can reach.
const GIT_HARDENING: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "diff.ignoreSubmodules=all",
    "-c",
    "status.submoduleSummary=false",
    "-c",
    "core.askPass=",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.sshCommand=",
    "-c",
    "core.gitProxy=",
    "-c",
    "core.alternateRefsCommand=",
];

/// Variables that would steer git somewhere else or name a program for it.
const GIT_ENV_DROP: &[&str] = &[
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG",
];

/// The repository git would use for `dir`, found without running git: the
/// nearest `.git` at or above it (a directory, or a `gitdir:` file), its
/// `commondir` followed. Every path is a real path.
///
/// Fourth review, finding 2: git's own discovery skips a `.git` whose HEAD is
/// invalid and takes the directory holding it as a git dir when it has a
/// HEAD, objects and refs -- with the config beside them. Everything it
/// weighs is inside the project root a sandboxed command can write. So git
/// discovers nothing here: the repository is named on every call (GIT_DIR,
/// GIT_WORK_TREE, GIT_COMMON_DIR, a ceiling, safe.bareRepository=explicit),
/// and anything ambiguous is an Err -- "could not answer".
#[derive(Debug, Clone, PartialEq)]
struct GitRepo {
    work_tree: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

fn looks_like_git_dir(d: &Path) -> bool {
    fs::symlink_metadata(d.join("HEAD")).map(|m| m.is_file()).unwrap_or(false)
        && d.join("objects").is_dir()
        && d.join("refs").is_dir()
}

fn find_repository(dir: &Path) -> Result<Option<GitRepo>, String> {
    let mut d = fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    loop {
        let dot = d.join(".git");
        if let Ok(meta) = fs::symlink_metadata(&dot) {
            if looks_like_git_dir(&d) {
                return Err(format!("{} holds .git and is a git directory itself", d.display()));
            }
            let git_dir = if meta.is_dir() {
                dot.clone()
            } else if meta.file_type().is_symlink() {
                fs::canonicalize(&dot).map_err(|e| format!("{}: {e}", dot.display()))?
            } else if meta.is_file() {
                let text = fs::read_to_string(&dot).map_err(|e| format!("{}: {e}", dot.display()))?;
                let target = text
                    .lines()
                    .find_map(|l| l.strip_prefix("gitdir:"))
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| format!("{} names no git dir", dot.display()))?;
                fs::canonicalize(d.join(target)).map_err(|e| format!("{}: {e}", dot.display()))?
            } else {
                return Err(format!("{} is neither a directory nor a gitdir file", dot.display()));
            };
            if !git_dir.is_dir() {
                return Err(format!("{} points at no directory", dot.display()));
            }
            let common_dir = match fs::read_to_string(git_dir.join("commondir")) {
                Ok(t) => {
                    let t = t.trim();
                    if t.is_empty() {
                        return Err("an empty commondir".into());
                    }
                    fs::canonicalize(git_dir.join(t)).map_err(|e| format!("commondir: {e}"))?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => git_dir.clone(),
                Err(e) => return Err(format!("commondir: {e}")),
            };
            return Ok(Some(GitRepo { work_tree: d, git_dir, common_dir }));
        }
        if looks_like_git_dir(&d) {
            return Err(format!("{} is a git directory with no .git above it", d.display()));
        }
        match d.parent() {
            Some(up) => d = up.to_path_buf(),
            None => return Ok(None),
        }
    }
}

fn hardened_git_command(dir: &Path, repo: Option<&GitRepo>) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir)
        .args(["-c", "safe.bareRepository=explicit"])
        .args(GIT_HARDENING)
        .env("GIT_TERMINAL_PROMPT", "0");
    for k in GIT_ENV_DROP {
        cmd.env_remove(k);
    }
    for (k, _) in std::env::vars_os() {
        if let Some(k) = k.to_str() {
            if k.starts_with("GIT_CONFIG_KEY_") || k.starts_with("GIT_CONFIG_VALUE_") {
                cmd.env_remove(k);
            }
        }
    }
    if !cfg!(windows) {
        cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    }
    if let Some(r) = repo {
        cmd.env("GIT_DIR", &r.git_dir)
            .env("GIT_WORK_TREE", &r.work_tree)
            .env("GIT_COMMON_DIR", &r.common_dir);
        if let Some(up) = r.work_tree.parent() {
            cmd.env("GIT_CEILING_DIRECTORIES", up);
        }
    }
    cmd
}

/// Every filter, diff and merge driver the configuration names, to blank
/// through GIT_CONFIG_COUNT (a driver's name is the repository's choice, so
/// no one `-c` key switches them all off). `git config --list` runs nothing.
/// None when the listing failed: then no git runs at all (fourth review,
/// finding 3) -- an unlisted driver is an unblanked one.
fn driver_keys(dir: &Path, repo: Option<&GitRepo>) -> Option<Vec<String>> {
    let out = match hardened_git_command(dir, repo)
        .args(["config", "-z", "--list"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return None,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut keys: Vec<String> = Vec::new();
    let mut add = |k: String| {
        if !keys.contains(&k) {
            keys.push(k);
        }
    };
    for entry in text.split('\0') {
        let key = entry.split('\n').next().unwrap_or("");
        let lower = key.to_ascii_lowercase();
        let name_of = |prefix: &str, suffixes: &[&str]| -> Option<String> {
            if !lower.starts_with(prefix) {
                return None;
            }
            suffixes
                .iter()
                .find(|s| lower.ends_with(*s) && key.len() > prefix.len() + s.len())
                .map(|s| key[prefix.len()..key.len() - s.len()].to_string())
        };
        if let Some(n) = name_of("filter.", &[".clean", ".smudge", ".process", ".required"]) {
            add(format!("filter.{n}.clean"));
            add(format!("filter.{n}.smudge"));
            add(format!("filter.{n}.process"));
        } else if let Some(n) = name_of("diff.", &[".textconv", ".command"]) {
            add(format!("diff.{n}.textconv"));
            add(format!("diff.{n}.command"));
        } else if let Some(n) = name_of("merge.", &[".driver"]) {
            add(format!("merge.{n}.driver"));
        }
    }
    Some(keys)
}

/// git in `dir` with gnomon's hardening: the repository named explicitly, no
/// fsmonitor, hooks, pager, external diff, system config, or any
/// filter/diff/merge driver the repository names. `.gnomon/` sits inside a
/// project root that a sandboxed bash (exec = "docker") may write,
/// `.git/config` included, and this runs on the host: `gnomon session` and
/// `gnomon surface manifest` call it (third review, finding 7). None -- "could
/// not answer" -- when the repository is ambiguous or its configuration
/// cannot be listed.
fn safe_git(dir: &Path, args: &[&str]) -> Option<String> {
    // The operator's own GIT_DIR / GIT_WORK_TREE (a git hook started this):
    // git discovers nothing then either.
    let explicit = std::env::var_os("GIT_DIR").is_some() || std::env::var_os("GIT_WORK_TREE").is_some();
    let repo = if explicit {
        None
    } else {
        Some(find_repository(dir).ok()??)
    };
    let mut cmd = hardened_git_command(dir, repo.as_ref());
    let keys = driver_keys(dir, repo.as_ref())?;
    let mut n = 0usize;
    for k in &keys {
        cmd.env(format!("GIT_CONFIG_KEY_{n}"), k)
            .env(format!("GIT_CONFIG_VALUE_{n}"), "");
        n += 1;
    }
    for k in keys.iter().filter(|k| k.ends_with(".clean")) {
        let req = format!("{}.required", &k[..k.len() - ".clean".len()]);
        cmd.env(format!("GIT_CONFIG_KEY_{n}"), req)
            .env(format!("GIT_CONFIG_VALUE_{n}"), "false");
        n += 1;
    }
    cmd.env("GIT_CONFIG_COUNT", n.to_string());
    let mut argv: Vec<&str> = args.to_vec();
    if argv.first() == Some(&"status") {
        argv.insert(1, "--ignore-submodules=all");
    }
    let out = cmd.args(&argv).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The revision this manifest was produced at. See cmd_manifest for why.
fn resolve_revision(dir: &Path) -> String {
    if let Ok(stamped) = std::env::var("GNOMON_BUILD") {
        let stamped = stamped.trim().to_string();
        if !stamped.is_empty() {
            return stamped;
        }
    }
    git_revision(dir)
}

/// The short HEAD of the repository holding `dir`, `-dirty` when its tree is.
fn git_revision(dir: &Path) -> String {
    let git = |args: &[&str]| -> Option<String> { safe_git(dir, args) };
    match git(&["rev-parse", "--short", "HEAD"]) {
        Some(sha) if !sha.is_empty() => {
            let dirty = git(&["status", "--porcelain"])
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if dirty {
                format!("{sha}-dirty")
            } else {
                sha
            }
        }
        // No repository to ask, or git absent. Said plainly rather than guessed.
        _ => "local".to_string(),
    }
}

fn cmd_manifest(dir: &Path) {
    let sources = build_sources(dir);
    let surface_hash = compute_surface_hash(&sources);
    // Which BUILD produced this manifest, not just which version.
    //
    // This was `format!("{}+{}", VERSION, "local")` -- a hardcoded literal with
    // no code path by which a revision could ever reach it -- and CONTRACTS.md
    // then wrote the drift up as the design: "it is not a git revision, and a
    // consumer must not read provenance from it." So the one field named
    // `build` in the one artifact meant to identify a run identified nothing,
    // and the document told readers not to look.
    //
    // Resolution order, most trustworthy first, matching the harness field on
    // the TypeScript side so the two agree:
    //   1. GNOMON_BUILD, stamped by a release. The only form that survives a
    //      binary shipped without its repository.
    //   2. `git rev-parse --short HEAD` in the directory being hashed, with a
    //      `-dirty` suffix when that tree has uncommitted changes -- a build
    //      from an edited tree must not claim to be the commit it sits on.
    //   3. `local`, said plainly. A wrong provenance string is worse than an
    //      absent one, because it is the kind of thing a reader believes.
    let build = format!("{}+{}", VERSION, resolve_revision(dir));

    let manifest = Manifest {
        build,
        surface_hash,
        sources,
    };

    let json = serde_json::to_string_pretty(&manifest).unwrap();
    println!("{}", json);

    // Write manifest to a temp file for caching (NOT in .gnomon/ to keep it
    // out of the surface hash). Prefer $XDG_CACHE_HOME/gnomon/ or /tmp/gnomon/.
    let cache_dir = std::env::var("XDG_CACHE_HOME")
        .unwrap_or_else(|_| "/tmp".to_string());
    let manifest_path = Path::new(&cache_dir)
        .join("gnomon")
        .join(".manifest.json");
    if let Some(parent) = manifest_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = fs::File::create(&manifest_path) {
        let _ = f.write_all(json.as_bytes());
    }
}

fn cmd_hash(dir: &Path) {
    let sources = build_sources(dir);
    let surface_hash = compute_surface_hash(&sources);
    println!("{}", surface_hash);
}

fn cmd_paths(dir: &Path) {
    let sources = build_sources(dir);
    for source in &sources {
        let status = if source.sha256.is_some() { "✓" } else { "✗" };
        println!("{} {}", status, source.path);
    }
}

// ─────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────

const USAGE: &str = "\
gnomon-surface — resolve the .gnomon/ surface, hash it, emit a manifest

Usage:
  gnomon-surface [manifest|hash|paths] [--dir <path>]
  gnomon-surface --help

Subcommands:
  manifest   JSON: build, surface_hash, and every source with its sha256 (default)
  hash       the surface hash alone, on one line
  paths      one line per source: ✓ present, ✗ declared but absent

Options:
  --dir <path>   Either a project root (a directory containing .gnomon/) or the
                 .gnomon/ directory itself. Both name the same surface and hash
                 identically. Default: the current directory.
  -h, --help     Print this message.

Exit codes:
  0   the subcommand ran
  2   usage error, or no .gnomon/ directory under --dir
";

#[derive(PartialEq, Eq, Debug, Clone, Copy)]
enum Subcommand {
    Manifest,
    Hash,
    Paths,
}

/// What `main` got out of argv, or the reason it could not.
#[derive(PartialEq, Eq, Debug)]
enum Parsed {
    Help,
    Run {
        subcommand: Subcommand,
        dir: PathBuf,
    },
}

/// Resolve what `--dir` named into the .gnomon/ directory to hash.
///
/// Measured, before this function existed: `--dir` was used verbatim and
/// defaulted to `.`, so pointing the binary at a project root walked the whole
/// repository and prefixed every path a second time.
///
///   $ gnomon-surface paths --dir conformance/fixture_tree
///   ✓ .gnomon/.gnomon/config.toml     <- the real file, doubled prefix
///   ✗ .gnomon/config.toml             <- all five declared paths, sha256: null
///   $ gnomon-surface hash --dir conformance/fixture_tree
///   7877192efe5453fe61d1e0793e797c7e1cd6a10eb262a1de465f564dfb078e35
///   $ gnomon-surface hash --dir conformance/fixture_tree/.gnomon
///   84d764b6ff94d6952b1f2d7c27e45c41cd303b8a80e3a130bbd195a3c043476a
///
/// and the TypeScript implementation (`recomputeManifest`, which normalises
/// with `surfaceDirOf`) returned 84d764b6ff94… for that same project root.
/// Exit code 0 every time. This binary exists so a third party can check a
/// surface hash without a JS runtime; a confident wrong answer defeats its
/// only purpose, and pointing at a project root is the obvious thing to try.
///
/// Mirrors config.ts `surfaceDirOf` exactly, so the two implementations agree
/// on what a directory argument means: basename `.gnomon` = the caller already
/// pointed at the surface, anything else = a project root.
fn surface_dir_of(dir: &Path) -> PathBuf {
    // Lexical, not canonicalize(): a path that does not exist must still
    // resolve, so the caller can report it by name rather than fail here.
    let abs = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    if abs.file_name() == Some(std::ffi::OsStr::new(".gnomon")) {
        abs
    } else {
        abs.join(".gnomon")
    }
}

/// Parse argv[1..].
///
/// Measured, before this returned a Result: the loop’s catch-all was
/// `_ => {}`, so every token it did not recognise was dropped in silence.
///
///   $ gnomon-surface hsah --dir conformance/fixture_tree/.gnomon
///   {  "build": ..., "surface_hash": ... }      exit 0
///   $ gnomon-surface hash --dir <d> --exclude nope
///   84d764b6ff94…                             exit 0
///   $ gnomon-surface --help
///   {  "build": ..., "surface_hash": ... }      exit 0
///
/// A typo’d subcommand answered a question nobody asked; `--exclude` looked
/// honoured and was not; `--help` was not a flag, it was noise. An
/// unrecognised token now stops the run. This binary is trusted about exactly
/// one 64-character string, and it cannot be trusted while it answers requests
/// it did not understand.
fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut dir: Option<PathBuf> = None;
    let mut subcommand: Option<Subcommand> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => return Ok(Parsed::Help),
            "--dir" => {
                i += 1;
                // A flag whose value fell off the end used to leave `dir` at
                // its default, so `--dir` with nothing after it hashed the
                // current directory and said nothing: the wrong surface,
                // reported with exactly the same confidence as the right one.
                let Some(value) = args.get(i) else {
                    return Err("--dir requires a path".to_string());
                };
                if dir.is_some() {
                    return Err("--dir given more than once".to_string());
                }
                dir = Some(PathBuf::from(value));
            }
            "manifest" | "hash" | "paths" => {
                let next = match arg {
                    "manifest" => Subcommand::Manifest,
                    "hash" => Subcommand::Hash,
                    _ => Subcommand::Paths,
                };
                // Two subcommands used to mean "the last one wins", silently.
                if let Some(first) = subcommand {
                    return Err(format!(
                        "two subcommands given: {} and {}",
                        subcommand_name(first),
                        arg
                    ));
                }
                subcommand = Some(next);
            }
            other => return Err(format!("unrecognised argument: {other}")),
        }
        i += 1;
    }

    Ok(Parsed::Run {
        subcommand: subcommand.unwrap_or(Subcommand::Manifest),
        dir: dir.unwrap_or_else(|| PathBuf::from(".")),
    })
}

fn subcommand_name(s: Subcommand) -> &'static str {
    match s {
        Subcommand::Manifest => "manifest",
        Subcommand::Hash => "hash",
        Subcommand::Paths => "paths",
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let parsed = match parse_args(&args) {
        Ok(parsed) => parsed,
        Err(reason) => {
            eprintln!("gnomon-surface: {reason}");
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };

    let (subcommand, dir) = match parsed {
        Parsed::Help => {
            print!("{USAGE}");
            return;
        }
        Parsed::Run { subcommand, dir } => (subcommand, dir),
    };

    let surface = surface_dir_of(&dir);
    if !surface.is_dir() {
        // Not a warning. collect_surface over an absent directory returns
        // nothing, so the run would print a well-formed 64-hex hash of five
        // nulls and exit 0 -- a hash of a surface that is not there, which
        // reads exactly like a hash of a surface that is.
        eprintln!(
            "gnomon-surface: no .gnomon/ directory at {} (resolved from --dir {})",
            surface.display(),
            dir.display()
        );
        std::process::exit(2);
    }

    match subcommand {
        Subcommand::Manifest => cmd_manifest(&surface),
        Subcommand::Hash => cmd_hash(&surface),
        Subcommand::Paths => cmd_paths(&surface),
    }
}

#[cfg(test)]
mod tests {

    /// The hex encoding every gnomon hash is printed through, pinned by data.
    ///
    /// sha2 0.11 removed `LowerHex` from the digest type, so the `format!("{:x}",
    /// ..)` that produced these strings had to be replaced by a hand-written
    /// encoder -- in this crate and two others, three separate copies. The digest
    /// cannot change; the ENCODING can, and an encoder that drops a leading zero
    /// or emits uppercase turns a correct digest into a wrong hash string. Every
    /// surface hash, manifest entry, audit chain link and patch image is that
    /// string.
    ///
    /// Vectors come from conformance/digest_vectors.json, computed by Python's
    /// hashlib rather than by the code they pin.
    #[test]
    fn hex_digest_matches_the_conformance_vectors() {
        let raw = include_str!("../../../conformance/digest_vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("digest_vectors.json parses");
        let vectors = doc["vectors"].as_array().expect("vectors array");
        assert!(!vectors.is_empty(), "fixture has no vectors");
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let input = v["input"].as_str().unwrap();
            let want = v["sha256"].as_str().unwrap();

            let mut hasher = Sha256::new();
            hasher.update(input.as_bytes());
            let got = hex_digest(hasher.finalize());

            assert_eq!(got, want, "vector {name}: input {input:?}");
            assert_eq!(got.len(), 64, "vector {name}: not 64 chars");
            assert_eq!(got, got.to_lowercase(), "vector {name}: not lowercase");
        }
    }
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Third review, finding 7: `gnomon session` and `gnomon surface manifest`
    /// run this on the host, in the project's .gnomon/, and the repository's
    /// config is writable from a docker-mode container.
    #[cfg(unix)]
    #[test]
    fn resolve_revision_runs_nothing_the_repository_names() {
        use std::io::Write;
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let out = tmp.path().join("out");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&out).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        fs::create_dir_all(repo.join(".gnomon")).unwrap();
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        fs::write(repo.join(".gnomon/config.toml"), "").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        let fsm = out.join("fsmonitor-ran");
        let flt = out.join("filter-ran");
        let mut cfg = fs::OpenOptions::new()
            .append(true)
            .open(repo.join(".git/config"))
            .unwrap();
        write!(
            cfg,
            "[core]\n\tfsmonitor = \"touch '{}'; false\"\n[filter \"evil\"]\n\tclean = \"touch '{}'; cat\"\n",
            fsm.display(),
            flt.display()
        )
        .unwrap();
        drop(cfg);
        fs::write(repo.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        fs::write(repo.join("a.txt"), "two\n").unwrap();
        let rev = git_revision(&repo.join(".gnomon"));
        assert!(rev.ends_with("-dirty"), "a changed tree reads dirty: {rev}");
        assert!(!fsm.exists(), "core.fsmonitor ran from resolve_revision");
        assert!(!flt.exists(), "a filter driver ran from resolve_revision");
        // CONTROL: plain git in the same repository runs both.
        std::process::Command::new("git")
            .arg("status")
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            fsm.exists() && flt.exists(),
            "control: the planted config is not live"
        );
    }


    /// Fourth review, finding 2: a container corrupts .git/HEAD in place and
    /// makes the project root a git dir of its own. git's discovery then
    /// takes the root; gnomon must not -- it names the repository it found
    /// (`<root>/.git`), and a repository that cannot answer is "local".
    #[cfg(unix)]
    #[test]
    fn a_root_made_a_git_dir_is_not_the_repository_asked() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let out = tmp.path().join("out");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&out).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        fs::create_dir_all(repo.join(".gnomon")).unwrap();
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        fs::write(repo.join(".gnomon/config.toml"), "").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        let good = git_revision(&repo.join(".gnomon"));
        assert_ne!(good, "local");
        // The root becomes a git dir: its own HEAD, refs, objects, index, config.
        let cp = std::process::Command::new("cp")
            .args(["-a", ".git/objects", ".git/refs", ".git/index", ".git/HEAD", "."])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(cp.success());
        let marker = out.join("filter-ran");
        fs::write(
            repo.join("config"),
            format!(
                "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = {}\n[filter \"x\"]\n\tclean = \"touch '{}'; cat\"\n",
                repo.display(),
                marker.display()
            ),
        )
        .unwrap();
        let head = repo.join(".git/HEAD");
        let len = fs::metadata(&head).unwrap().len() as usize;
        fs::write(&head, "z".repeat(len)).unwrap();
        fs::write(repo.join(".gitattributes"), "*.txt filter=x\n").unwrap();
        fs::write(repo.join("a.txt"), "two\n").unwrap();
        let rev = git_revision(&repo.join(".gnomon"));
        assert_eq!(rev, "local", "answered from a git dir the root was turned into: {rev}");
        assert!(!marker.exists(), "a filter of the root git dir ran");
        // CONTROL: plain git takes the root.
        std::process::Command::new("git")
            .arg("status")
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(marker.exists(), "control: the planted root git dir is not live");
    }

    fn setup_test_dir() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let gnomon_dir = tmp.path().join(".gnomon");
        fs::create_dir(&gnomon_dir).unwrap();

        // Write the standard surface files
        fs::write(
            gnomon_dir.join("config.toml"),
            "# test config\nedit_format = \"hashline\"\n",
        )
        .unwrap();
        fs::write(
            gnomon_dir.join("system.md"),
            "# test system\nYou are an agent.\n",
        )
        .unwrap();
        fs::write(
            gnomon_dir.join("roles.toml"),
            "# test roles\n[roles.plan]\n",
        )
        .unwrap();
        fs::write(
            gnomon_dir.join("tools.toml"),
            "# test tools\n",
        )
        .unwrap();
        fs::write(
            gnomon_dir.join("policy.toml"),
            "# test policy\n",
        )
        .unwrap();

        // Add a profile
        fs::create_dir(gnomon_dir.join("profiles")).unwrap();
        fs::write(
            gnomon_dir.join("profiles").join("local_first.toml"),
            "# local_first profile\n",
        )
        .unwrap();

        tmp
    }

    #[test]
    fn test_trials_are_hashed() {
        // A trial spec decides what `require_trial` accepts, so it is part of
        // the surface: editing one must move the hash, as in the TS walk.
        let tmp = setup_test_dir();
        let dir = tmp.path().join(".gnomon");
        let before = compute_surface_hash(&build_sources(&dir));
        fs::create_dir_all(dir.join("trials")).unwrap();
        fs::write(dir.join("trials").join("default.toml"), "[[task]]\nid = \"t\"\n").unwrap();
        let sources = build_sources(&dir);
        assert!(sources.iter().any(|s| s.path == ".gnomon/trials/default.toml"));
        assert_ne!(before, compute_surface_hash(&sources), "trials/ must move the hash");
    }

    #[test]
    fn test_deterministic_hash() {
        let tmp = setup_test_dir();
        let dir = tmp.path().join(".gnomon");

        let sources1 = build_sources(&dir);
        let hash1 = compute_surface_hash(&sources1);

        // Run again — should be identical
        let sources2 = build_sources(&dir);
        let hash2 = compute_surface_hash(&sources2);

        assert_eq!(hash1, hash2, "Hash must be deterministic for same tree");
        assert_eq!(sources1.len(), sources2.len(), "Source count must match");
    }

    #[test]
    fn test_different_content_different_hash() {
        let tmp = setup_test_dir();
        let dir = tmp.path().join(".gnomon");

        let sources1 = build_sources(&dir);
        let hash1 = compute_surface_hash(&sources1);

        // Modify a file
        fs::write(
            dir.join("system.md"),
            "# modified system\nChanged content.\n",
        )
        .unwrap();

        let sources2 = build_sources(&dir);
        let hash2 = compute_surface_hash(&sources2);

        assert_ne!(
            hash1, hash2,
            "Hash must differ when file content changes"
        );
    }

    #[test]
    fn test_absent_path_has_null_hash() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".gnomon");
        fs::create_dir(&dir).unwrap();
        // Don't write any files — all SURFACE_PATHS should be absent

        let sources = build_sources(&dir);

        for path in SURFACE_PATHS {
            let source = sources.iter().find(|s| s.path == *path).unwrap();
            assert!(
                source.sha256.is_none(),
                "Path '{}' should be absent (sha256 = null)",
                path
            );
        }
    }

    #[test]
    fn test_sources_sorted_by_path() {
        let tmp = setup_test_dir();
        let dir = tmp.path().join(".gnomon");

        let sources = build_sources(&dir);
        let mut paths: Vec<&str> = sources.iter().map(|s| s.path.as_str()).collect();
        paths.sort();

        assert_eq!(paths, sources.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            "Sources must be sorted by path for determinism");
    }

    #[test]
    fn test_manifest_structure() {
        let tmp = setup_test_dir();
        let dir = tmp.path().join(".gnomon");

        let sources = build_sources(&dir);
        let surface_hash = compute_surface_hash(&sources);

        let manifest = Manifest {
            build: format!("{}+local", VERSION),
            surface_hash: surface_hash.clone(),
            sources: sources.clone(),
        };

        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: Manifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.surface_hash, surface_hash);
        assert_eq!(parsed.sources.len(), sources.len());
        assert!(parsed.build.starts_with(VERSION));
    }

    #[test]
    fn test_an_extension_does_not_move_the_hash_because_nothing_loads_it() {
        // This test asserted the OPPOSITE until 2026-09-04: that adding a file
        // under `extensions/` changes the surface hash. It did, and that was
        // the defect. Nothing in either implementation loads an extension, so
        // the hash was announcing a behaviour change that never happened --
        // the one thing this project asks people to trust, lying in the
        // harmless direction. Commit 9f38bfd disclosed it; this removes it.
        //
        // TRIPWIRE: if an extension host is ever built, this test is the thing
        // that must change back, together with the `.gnomon/extensions/` skip
        // in `collect_surface` and its twin in the TypeScript walk. Leaving it
        // excluded once extensions LOAD would turn today's harmless false
        // positive into a false negative -- behaviour changing while the hash
        // holds still -- which is the failure this whole design exists to make
        // impossible. `benchmarks/surface-fidelity/` measures that direction
        // on every run and will catch it.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".gnomon");
        let ext_dir = dir.join("extensions");

        fs::create_dir(&dir).unwrap();
        fs::create_dir(&ext_dir).unwrap();

        let sources = build_sources(&dir);
        let ext_sources: Vec<_> = sources
            .iter()
            .filter(|s| s.path.contains("extensions/"))
            .collect();
        assert_eq!(ext_sources.len(), 0, "an empty extensions dir contributes nothing");

        let hash_empty_dir = compute_surface_hash(&sources);

        // A real extension file, not an empty one: if anything were going to
        // move the hash it would be this.
        fs::write(ext_dir.join("hook.ts"), "export const hook = () => {};\n").unwrap();
        let sources2 = build_sources(&dir);
        let hash_with_extension = compute_surface_hash(&sources2);

        assert!(
            sources2.iter().all(|s| !s.path.contains("extensions/")),
            "an extension file must not appear in the manifest while nothing loads it"
        );
        assert_eq!(
            hash_empty_dir, hash_with_extension,
            "an extension changes no behaviour, so it must not change the surface hash"
        );
    }

    // ── Directory normalisation (finding 13) ──
    //
    // These tests exist because the bug they pin was invisible: every symptom
    // of it came back on exit 0 with a well-formed 64-hex hash.

    #[test]
    fn test_surface_dir_of_accepts_a_project_root_or_the_surface_itself() {
        let tmp = setup_test_dir();
        let root = tmp.path();
        let surface = root.join(".gnomon");

        assert_eq!(
            surface_dir_of(root),
            std::path::absolute(&surface).unwrap(),
            "a project root must resolve to the .gnomon/ inside it"
        );
        assert_eq!(
            surface_dir_of(&surface),
            std::path::absolute(&surface).unwrap(),
            "the .gnomon/ directory itself must resolve to itself, not to .gnomon/.gnomon"
        );
        // A trailing separator is the same directory.
        let with_slash = PathBuf::from(format!("{}/", surface.display()));
        assert_eq!(surface_dir_of(&with_slash), std::path::absolute(&surface).unwrap());
    }

    #[test]
    fn test_project_root_and_surface_dir_hash_identically() {
        let tmp = setup_test_dir();
        let root = tmp.path();
        let surface = root.join(".gnomon");

        let from_root = compute_surface_hash(&build_sources(&surface_dir_of(root)));
        let from_surface = compute_surface_hash(&build_sources(&surface_dir_of(&surface)));

        assert_eq!(
            from_root, from_surface,
            "a project root and its .gnomon/ name the same surface, so they must hash the same"
        );

        // Negative control: the pre-fix code path, spelled out. If
        // surface_dir_of were ever reduced to the identity function, the
        // assertion above would still pass and this one would fail -- so a
        // regression cannot hide behind two agreeing wrong answers.
        let unnormalised = compute_surface_hash(&build_sources(root));
        assert_ne!(
            unnormalised, from_surface,
            "control: hashing the project root WITHOUT normalising must differ -- \
             if it does not, this test is not measuring the normalisation"
        );
    }

    #[test]
    fn test_project_root_does_not_produce_a_doubled_prefix() {
        let tmp = setup_test_dir();
        let root = tmp.path();

        let sources = build_sources(&surface_dir_of(root));
        assert!(
            !sources.iter().any(|s| s.path.starts_with(".gnomon/.gnomon/")),
            "no source may be recorded under a doubled .gnomon/ prefix: {:?}",
            sources.iter().map(|s| s.path.as_str()).collect::<Vec<_>>()
        );
        for path in SURFACE_PATHS {
            let source = sources.iter().find(|s| s.path == *path).unwrap();
            assert!(
                source.sha256.is_some(),
                "'{path}' is present on disk and must not be reported absent from a project root"
            );
        }

        // Control: without normalisation, every declared path IS reported
        // absent while the real files appear doubled. This is the measured
        // failure, kept executable so the fix cannot silently come undone.
        let unnormalised = build_sources(root);
        assert!(
            unnormalised.iter().any(|s| s.path.starts_with(".gnomon/.gnomon/")),
            "control: the un-normalised walk is what produced the doubled prefix"
        );
        for path in SURFACE_PATHS {
            let source = unnormalised.iter().find(|s| s.path == *path).unwrap();
            assert!(source.sha256.is_none(), "control: '{path}' was reported absent");
        }
    }

    // ── Argument parsing (finding 13) ──

    #[test]
    fn test_parse_args_defaults() {
        let parsed = parse_args(&[]).unwrap();
        assert_eq!(
            parsed,
            Parsed::Run { subcommand: Subcommand::Manifest, dir: PathBuf::from(".") }
        );
    }

    #[test]
    fn test_parse_args_subcommand_and_dir() {
        let args: Vec<String> = ["hash", "--dir", "/x/.gnomon"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            parse_args(&args).unwrap(),
            Parsed::Run { subcommand: Subcommand::Hash, dir: PathBuf::from("/x/.gnomon") }
        );
    }

    #[test]
    fn test_parse_args_help_is_recognised() {
        for flag in ["--help", "-h"] {
            assert_eq!(
                parse_args(&[flag.to_string()]).unwrap(),
                Parsed::Help,
                "{flag} must be help, not a token to ignore"
            );
        }
        // Help wins even when it trails a subcommand, so `hash --help` cannot
        // print a hash and call it documentation.
        let args: Vec<String> = ["hash", "--help"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_args(&args).unwrap(), Parsed::Help);
    }

    #[test]
    fn test_parse_args_rejects_what_it_does_not_understand() {
        // Each of these exited 0 with a manifest or a hash before the fix.
        let cases: [&[&str]; 4] = [
            &["hsah"],                          // typo'd subcommand
            &["hash", "--exclude", "nope"],     // flag that does not exist
            &["--dir"],                         // value fell off the end
            &["hash", "manifest"],              // two subcommands
        ];
        for case in cases {
            let args: Vec<String> = case.iter().map(|s| s.to_string()).collect();
            let err = parse_args(&args).unwrap_err();
            assert!(!err.is_empty(), "{case:?} must be rejected with a reason");
        }
    }

    #[test]
    fn test_manifest_against_golden_fixture() {
        // Fixture tree relative to workspace root
        let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap()
            .join("conformance/fixture_tree/.gnomon");
        assert!(
            fixture_dir.exists(),
            "Fixture tree must exist at conformance/fixture_tree/.gnomon/"
        );

        let sources = build_sources(&fixture_dir);
        let surface_hash = compute_surface_hash(&sources);
        let manifest = Manifest {
            build: format!("{}+local", VERSION),
            surface_hash,
            sources,
        };

        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();

        // Compare against golden fixture
        let golden_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap()
            .join("conformance/manifest_golden.json");
        let golden_json = fs::read_to_string(&golden_path)
            .unwrap_or_else(|_| panic!("Golden fixture must exist at {}", golden_path.display()));

        // Normalize both to compare (parse and re-serialize to ensure same formatting)
        let parsed_manifest: Manifest = serde_json::from_str(&manifest_json).unwrap();
        let parsed_golden: Manifest = serde_json::from_str(&golden_json).unwrap();

        assert_eq!(
            parsed_manifest.surface_hash, parsed_golden.surface_hash,
            "Surface hash must match golden fixture"
        );
        assert_eq!(
            parsed_manifest.sources.len(), parsed_golden.sources.len(),
            "Source count must match golden fixture"
        );
        for (actual, expected) in parsed_manifest.sources.iter().zip(parsed_golden.sources.iter()) {
            assert_eq!(actual.path, expected.path, "Path mismatch for {}", actual.path);
            assert_eq!(actual.sha256, expected.sha256, "Hash mismatch for {}", actual.path);
        }
    }
}
