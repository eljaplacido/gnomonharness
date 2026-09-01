//! gnomon-surface: resolve .gnomon/ tree, compute surface hash, emit manifests.
//!
//! This is the static aarch64 binary that makes the surface hash verifiable
//! without any JavaScript runtime. Every turn recomputes and asserts it.
//!
//! Usage:
//!   gnomon-surface manifest [--dir <path>]
//!   gnomon-surface hash [--dir <path>]
//!   gnomon-surface paths [--dir <path>]
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
fn file_sha256(path: &Path) -> Option<String> {
    let contents = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&contents);
    Some(format!("{:x}", hasher.finalize()))
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
    format!("{:x}", hasher.finalize())
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

fn cmd_manifest(dir: &Path) {
    let sources = build_sources(dir);
    let surface_hash = compute_surface_hash(&sources);
    let build = format!("{}+{}", VERSION, "local"); // no git revision in non-repo context

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

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let mut dir = PathBuf::from(".");
    let mut subcommand = "manifest";

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                if i < args.len() {
                    dir = PathBuf::from(&args[i]);
                }
            }
            "manifest" | "hash" | "paths" => {
                subcommand = args[i].as_str();
            }
            _ => {}
        }
        i += 1;
    }

    match subcommand {
        "manifest" => cmd_manifest(&dir),
        "hash" => cmd_hash(&dir),
        "paths" => cmd_paths(&dir),
        _ => {
            eprintln!("Usage: gnomon-surface [manifest|hash|paths] [--dir <path>]");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

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
    fn test_missing_extension_vs_empty_extension() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".gnomon");
        let ext_dir = dir.join("extensions");

        fs::create_dir(&dir).unwrap();
        fs::create_dir(&ext_dir).unwrap();
        // Don't create any .ts files

        let sources = build_sources(&dir);
        // Check that extensions dir appears in walk but no .ts files
        let ext_sources: Vec<_> = sources
            .iter()
            .filter(|s| s.path.starts_with("extensions/"))
            .collect();
        assert_eq!(ext_sources.len(), 0, "No .ts files means no extension sources");

        let hash_empty_dir = compute_surface_hash(&sources);

        // Now create an empty file
        fs::write(ext_dir.join("empty.ts"), "").unwrap();
        let sources2 = build_sources(&dir);
        let hash_with_empty = compute_surface_hash(&sources2);

        assert_ne!(
            hash_empty_dir, hash_with_empty,
            "A missing extension and an empty one are NOT the same surface"
        );
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
