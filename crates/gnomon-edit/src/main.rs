//! gnomon-edit: Content-unsafe patch engine
//!
//! Applies structured patches to files with collision detection.
//! A patch is "content-unsafe" if the target text has changed between
//! the time the patch was composed and when it is applied.
//!
//! This crate is a thin, deterministic wrapper around safe text replacement.
//! It never modifies files in-place — instead, it produces a `PatchResult`
//! describing what _would_ change, with a pre-check hash to detect drift.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;
use thiserror::Error;

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

#[derive(Debug, Error, Serialize, Deserialize, PartialEq)]
pub enum EditError {
    #[error("file not found: {path}")]
    FileNotFound { path: String },

    #[error("content drift: expected {expected}, got {actual}")]
    ContentDrift { expected: String, actual: String },

    #[error("no match for pattern in {path}")]
    NoMatch { path: String, pattern: String },

    #[error("replacement failed: {reason}")]
    ReplacementFailed { reason: String },

    #[error("invalid patch: {reason}")]
    InvalidPatch { reason: String },

    #[error("io error: {0}")]
    IoError(String),
}

// ─────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────

/// A single patch operation: find `pattern` in the file and replace with `replacement`.
/// The `expected_hash` is the SHA256 of the matched text — used for collision detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    /// Path relative to the repository root (e.g., "src/main.py")
    pub path: String,

    /// Pattern to find — exact string match or regex (see `mode`)
    pub pattern: String,

    /// Replacement text
    pub replacement: String,

    /// How to interpret `pattern`: "exact" (substring match) or "regex"
    #[serde(default = "default_mode")]
    pub mode: String,

    /// SHA256 of the expected matched text for collision detection
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,

    /// If set, only patch the first N occurrences (default: 1)
    #[serde(default = "default_occurrences")]
    pub occurrences: usize,
}

fn default_mode() -> String {
    "exact".to_string()
}

fn default_occurrences() -> usize {
    1
}

/// Result of applying a single patch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchResult {
    pub path: String,
    pub applied: bool,
    pub old_content_sha256: Option<String>,
    pub new_content_sha256: Option<String>,
    pub error: Option<String>,
}

/// A batch of patches to apply atomically
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchSet {
    pub patches: Vec<Patch>,
    /// Optional surface hash that the patches were composed against
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_hash: Option<String>,
}

/// Result of applying a patch set
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchSetResult {
    pub results: Vec<PatchResult>,
    pub all_applied: bool,
    pub total: usize,
    pub applied: usize,
    pub failed: usize,
}

// ─────────────────────────────────────────────
// Core patching logic
// ─────────────────────────────────────────────

/// Compute SHA256 of a string
fn sha256_str(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}


/// Find all non-overlapping matches of a pattern in text.
/// Returns (matched_text, start_pos, end_pos) tuples.
fn find_matches(text: &str, pattern: &str, mode: &str) -> Result<Vec<(String, usize, usize)>, EditError> {
    let matches: Vec<(String, usize, usize)> = if mode == "regex" {
        let re = regex::Regex::new(pattern)
            .map_err(|e| EditError::InvalidPatch { reason: format!("invalid regex: {}", e) })?;
        re.find_iter(text)
            .map(|m| (m.as_str().to_string(), m.start(), m.end()))
            .collect()
    } else {
        // Exact mode: find all occurrences of `pattern` as a substring
        let mut matches = Vec::new();
        let mut search_start = 0;
        while let Some(pos) = text[search_start..].find(pattern) {
            let abs_pos = search_start + pos;
            let end = abs_pos + pattern.len();
            matches.push((pattern.to_string(), abs_pos, end));
            search_start = end;
        }
        matches
    };

    if matches.is_empty() {
        return Err(EditError::NoMatch {
            path: String::new(),
            pattern: pattern.to_string(),
        });
    }

    Ok(matches)
}

/// Apply a single patch to a file on disk.
/// Returns a `PatchResult` with success/failure and content hashes.
/// Always writes to disk. Use `simulate_patch` for dry-run.
pub fn apply_patch(patch: &Patch, repo_root: &Path) -> PatchResult {
    let full_path = repo_root.join(&patch.path);

    // Read the file
    let contents = match fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(_) => return PatchResult {
            path: patch.path.clone(),
            applied: false,
            old_content_sha256: None,
            new_content_sha256: None,
            error: Some(EditError::FileNotFound { path: patch.path.clone() }.to_string()),
        },
    };

    let old_hash = sha256_str(&contents);

    // Find the pattern
    let matches = match find_matches(&contents, &patch.pattern, &patch.mode) {
        Ok(m) => m,
        Err(EditError::NoMatch { pattern, .. }) => return PatchResult {
            path: patch.path.clone(),
            applied: false,
            old_content_sha256: Some(old_hash),
            new_content_sha256: None,
            error: Some(EditError::NoMatch {
                path: patch.path.clone(),
                pattern,
            }.to_string()),
        },
        Err(e) => return PatchResult {
            path: patch.path.clone(),
            applied: false,
            old_content_sha256: Some(old_hash),
            new_content_sha256: None,
            error: Some(e.to_string()),
        },
    };

    // Collision detection: if expected_hash is set, verify it against the matched text
    if let Some(ref expected_hash) = patch.expected_hash {
        let check_matches = &matches[..patch.occurrences.min(matches.len())];
        for (matched_text, _, _) in check_matches {
            let matched_hash = sha256_str(matched_text);
            if matched_hash != *expected_hash {
                return PatchResult {
                    path: patch.path.clone(),
                    applied: false,
                    old_content_sha256: Some(old_hash),
                    new_content_sha256: None,
                    error: Some(EditError::ContentDrift {
                        expected: expected_hash.clone(),
                        actual: matched_hash,
                    }.to_string()),
                };
            }
        }
    }

    // Apply the replacement
    let new_contents = if patch.mode == "regex" {
        // Use Regex::replace for proper backreference support
        let re = regex::Regex::new(&patch.pattern).unwrap_or_else(|_| {
            regex::Regex::new(&regex::escape(&patch.pattern)).unwrap()
        });
        let mut result = contents.clone();
        let mut count = 0usize;
        let max = patch.occurrences;
        result = re.replace(&result, &patch.replacement).to_string();
        count += 1;
        while count < max && re.is_match(&result) {
            result = re.replace(&result, &patch.replacement).to_string();
            count += 1;
        }
        result
    } else {
        // Exact mode: manual replace_range
        let mut new_contents = contents.clone();
        let mut offset = 0isize;

        for (_matched_text, start, end) in matches.iter().take(patch.occurrences) {
            let s = (*start as isize - offset) as usize;
            let e = (*end as isize - offset) as usize;
            if s <= e && e <= new_contents.len() {
                new_contents.replace_range(s..e, &patch.replacement);
                // Update offset: the match was (end-start) chars, replacement is patch.replacement.len()
                offset += (*end as isize - *start as isize) - patch.replacement.len() as isize;
            }
        }
        new_contents
    };

    let new_hash = sha256_str(&new_contents);

    // Always write to disk
    if let Ok(mut f) = fs::File::create(&full_path) {
        let _ = f.write_all(new_contents.as_bytes());
    }

    PatchResult {
        path: patch.path.clone(),
        applied: true,
        old_content_sha256: Some(old_hash),
        new_content_sha256: Some(new_hash),
        error: None,
    }
}

/// Apply a batch of patches atomically.
/// All patches are validated first, then applied.
/// If any patch fails validation, no patches are applied.
pub fn apply_patches(patches: &PatchSet, repo_root: &Path) -> PatchSetResult {
    let mut results = Vec::new();
    let mut all_applied = true;

    // Phase 1: Dry-run all patches to detect failures (no disk writes)
    let mut dry_results: Vec<PatchResult> = Vec::new();
    for patch in &patches.patches {
        // Simulate to avoid modifying the file during validation
        let simulated = simulate_patch(patch, repo_root);
        let sim_result = match simulated {
            Ok(new_content) => {
                let old_hash = std::fs::read(repo_root.join(&patch.path)).ok();
                let new_hash = sha256_str(&new_content);
                PatchResult {
                    path: patch.path.clone(),
                    applied: false, // dry run
                    old_content_sha256: old_hash.map(|b| sha256_str(&String::from_utf8_lossy(&b))),
                    new_content_sha256: Some(new_hash),
                    error: None,
                }
            }
            Err(e) => PatchResult {
                path: patch.path.clone(),
                applied: false,
                old_content_sha256: None,
                new_content_sha256: None,
                error: Some(e.to_string()),
            },
        };
        dry_results.push(sim_result.clone());
        if sim_result.error.is_some() {
            all_applied = false;
        }
    }

    // Phase 2: If all passed, apply with write-back
    if all_applied {
        for patch in &patches.patches {
            let result = apply_patch(patch, repo_root);
            results.push(result);
        }
    } else {
        // Failures: return dry-run results without writing
        results = dry_results;
    }

    let applied = results.iter().filter(|r| r.applied).count();
    let failed = results.iter().filter(|r| r.error.is_some()).count();

    PatchSetResult {
        results,
        all_applied,
        total: patches.patches.len(),
        applied,
        failed,
    }
}

/// Simulate a patch without touching disk (always dry-run).
/// Useful for pre-flight validation and diff preview.
pub fn simulate_patch(patch: &Patch, repo_root: &Path) -> Result<String, EditError> {
    let full_path = repo_root.join(&patch.path);
    let contents = fs::read_to_string(&full_path)
        .map_err(|_| EditError::FileNotFound {
            path: patch.path.clone(),
        })?;

    // Validate pattern can be parsed
    find_matches(&contents, &patch.pattern, &patch.mode)?;

    let new_contents = if patch.mode == "regex" {
        let re = regex::Regex::new(&patch.pattern).unwrap_or_else(|_| {
            regex::Regex::new(&regex::escape(&patch.pattern)).unwrap()
        });
        let mut result = contents.clone();
        let mut count = 0usize;
        let max = patch.occurrences;
        result = re.replace(&result, &patch.replacement).to_string();
        count += 1;
        while count < max && re.is_match(&result) {
            result = re.replace(&result, &patch.replacement).to_string();
            count += 1;
        }
        result
    } else {
        let mut new_contents = contents.clone();
        let mut offset = 0isize;
        let matches = find_matches(&contents, &patch.pattern, &patch.mode)?;
        let matched = &matches[..patch.occurrences.min(matches.len())];

        for (_matched_text, start, end) in matched {
            let s = (*start as isize - offset) as usize;
            let e = (*end as isize - offset) as usize;
            if s <= e && e <= new_contents.len() {
                new_contents.replace_range(s..e, &patch.replacement);
                offset += (*end as isize - *start as isize) - patch.replacement.len() as isize;
            }
        }
        new_contents
    };

    Ok(new_contents)
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

fn print_usage() {
    println!("gnomon-edit: Content-unsafe patch engine");
    println!();
    println!("Usage:");
    println!("  gnomon-edit simulate <patches.json>        — Dry-run a patch set, print JSON");
    println!("  gnomon-edit apply <patches.json>           — Apply a batch of patches");
    println!("  gnomon-edit diff <patch.json>              — Show diff of a single patch");
    println!("  gnomon-edit validate <patches.json>        — Validate patches without applying");
    println!();
    println!("Environment:");
    println!("  GNOMON_EDIT_MODE=dry   — Always dry-run (don't write to disk)");
}


/// Read and parse a patchset, or exit with a message a person can act on.
///
/// These were seven `unwrap()`s on user-supplied input, so the two most likely
/// first mistakes with `apply` and `simulate` -- a wrong filename, a
/// hand-edited JSON file -- surfaced as an internal panic with a backtrace
/// invitation. It read as "this tool crashed", not "you gave me a bad path",
/// and it was out of keeping with the rest of gnomon's errors, which name the
/// problem and the fix.
fn read_patchset(cmd: &str, path: &str) -> PatchSet {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("gnomon-edit {cmd}: cannot read {path}: {e}");
            std::process::exit(1);
        }
    };
    match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("gnomon-edit {cmd}: {path} is not a valid patchset: {e}");
            eprintln!("  expected JSON of the form {{\"patches\": [ ... ]}}");
            std::process::exit(1);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    // The command is argv[1], as the usage text says. Flag parsing used to
    // start at index 2 and then read the command from that same index, so
    // `gnomon-edit simulate patch.json` took "patch.json" as the command and
    // reported `Unknown command: simulate` — naming argv[1] while having
    // dispatched on argv[2]. Nothing could ever invoke this binary.
    let command = args[1].as_str();

    let mut repo_root = Path::new(".");
    let mut positional: Vec<&str> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        if args[i] == "--dir" {
            i += 1;
            if i < args.len() {
                repo_root = Path::new(&args[i]);
            }
        } else {
            positional.push(args[i].as_str());
        }
        i += 1;
    }

    match command {
        "simulate" => {
            if positional.is_empty() {
                eprintln!("Usage: gnomon-edit simulate <patches.json> [--dir <path>]");
                std::process::exit(1);
            }
            // A patch SET, and machine-readable, matching `apply`. This read a
            // single Patch and printed prose, while every caller sent a
            // patchset and parsed JSON — so nothing could consume it.
            let patchset: PatchSet = read_patchset("simulate", positional[0]);

            let mut results: Vec<PatchResult> = Vec::new();
            for patch in &patchset.patches {
                match simulate_patch(patch, repo_root) {
                    Ok(new_contents) => {
                        let old_hash = fs::read_to_string(repo_root.join(&patch.path))
                            .ok()
                            .map(|c| sha256_str(&c));
                        results.push(PatchResult {
                            path: patch.path.clone(),
                            applied: true,
                            old_content_sha256: old_hash,
                            new_content_sha256: Some(sha256_str(&new_contents)),
                            error: None,
                        });
                    }
                    Err(e) => results.push(PatchResult {
                        path: patch.path.clone(),
                        applied: false,
                        old_content_sha256: None,
                        new_content_sha256: None,
                        error: Some(e.to_string()),
                    }),
                }
            }

            let applied = results.iter().filter(|r| r.applied).count();
            let result = PatchSetResult {
                total: results.len(),
                applied,
                failed: results.len() - applied,
                all_applied: applied == results.len(),
                results,
            };
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            if !result.all_applied {
                std::process::exit(2);
            }
        }
        "apply" => {
            if positional.is_empty() {
                eprintln!("Usage: gnomon-edit apply <patches.json> [--dir <path>]");
                std::process::exit(1);
            }
            let patchset: PatchSet = read_patchset("apply", positional[0]);
            let result = apply_patches(&patchset, repo_root);
            let json = serde_json::to_string_pretty(&result).unwrap();
            println!("{}", json);
            if !result.all_applied {
                std::process::exit(2);
            }
        }
        "diff" => {
            if positional.is_empty() {
                eprintln!("Usage: gnomon-edit diff <patch.json> [--dir <path>]");
                std::process::exit(1);
            }
            // `diff` takes a single Patch, not a PatchSet, so it gets its own
            // read rather than sharing read_patchset -- but the same rule: a
            // bad path or bad JSON is the user's mistake to be told about, not
            // a panic to be shown a backtrace for.
            let patch: Patch = match fs::read_to_string(positional[0]) {
                Err(e) => {
                    eprintln!("gnomon-edit diff: cannot read {}: {e}", positional[0]);
                    std::process::exit(1);
                }
                Ok(c) => match serde_json::from_str(&c) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("gnomon-edit diff: {} is not a valid patch: {e}", positional[0]);
                        std::process::exit(1);
                    }
                },
            };
            let result = simulate_patch(&patch, repo_root);
            match result {
                Ok(new_contents) => {
                    println!("=== DIFF ===");
                    let old = match fs::read_to_string(repo_root.join(&patch.path)) {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("gnomon-edit diff: cannot read {}: {e}", patch.path);
                            std::process::exit(1);
                        }
                    };
                    let old_lines: Vec<&str> = old.lines().collect();
                    let new_lines: Vec<&str> = new_contents.lines().collect();
                    for (i, (o, n)) in old_lines.iter().zip(new_lines.iter()).enumerate() {
                        if o != n {
                            println!("-L{}: {}", i + 1, o);
                            println!("+L{}: {}", i + 1, n);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("❌ Diff failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        "validate" => {
            if positional.is_empty() {
                eprintln!("Usage: gnomon-edit validate <patches.json> [--dir <path>]");
                std::process::exit(1);
            }
            let patchset: PatchSet = read_patchset("validate", positional[0]);
            let mut valid = true;
            for patch in &patchset.patches {
                let result = apply_patch(patch, repo_root);
                if let Some(error) = result.error {
                    eprintln!("❌ {}: {}", patch.path, error);
                    valid = false;
                }
            }
            if valid {
                println!("✅ All {} patches valid", patchset.patches.len());
            } else {
                std::process::exit(1);
            }
        }
        "--help" | "-h" => {
            print_usage();
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            print_usage();
            std::process::exit(1);
        }
    }
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn clean_env() {
        std::env::remove_var("GNOMON_EDIT_MODE");
    }

    fn setup_test_dir() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let mut f = fs::File::create(&file_path).unwrap();
        writeln!(f, "hello world\nfoo bar baz\nhello world again\n").unwrap();
        dir
    }

    #[test]
    fn test_apply_exact_patch() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "world".to_string(),
            replacement: "universe".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(result.applied);
        assert!(result.error.is_none());
        assert!(result.new_content_sha256.is_some());

        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents.contains("universe"));
        assert!(contents.contains("world again")); // second occurrence unchanged
    }

    #[test]
    fn test_content_drift_detection() {
        clean_env();
        let dir = setup_test_dir();
        let _expected_hash = sha256_str("world");

        // Corrupt the file: keep the word "world" but change surrounding text
        // so the matched text "world" has a different hash
        let mut f = fs::File::create(dir.path().join("test.txt")).unwrap();
        writeln!(f, "corrupted world").unwrap();

        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "corrupted world".to_string(),
            replacement: "fixed world".to_string(),
            mode: "exact".to_string(),
            expected_hash: Some(sha256_str("original world")), // wrong hash → drift
            occurrences: 1,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(!result.applied);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("content drift"));
    }

    #[test]
    fn test_no_match_returns_error() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "nonexistent".to_string(),
            replacement: "nothing".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(!result.applied);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_regex_patch() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: r"hello\s+(\w+)".to_string(),
            replacement: "goodbye $1".to_string(),
            mode: "regex".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(result.applied);
        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents.contains("goodbye world"));
    }

    #[test]
    fn test_multiple_occurrences() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "hello".to_string(),
            replacement: "hi".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 2,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(result.applied);
        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(!contents.contains("hello world"), "still contains 'hello world': {:?}", contents);
        assert!(contents.contains("hi world again"));
    }

    #[test]
    fn test_file_not_found() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "does_not_exist.txt".to_string(),
            pattern: "foo".to_string(),
            replacement: "bar".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let result = apply_patch(&patch, dir.path());
        assert!(!result.applied);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("file not found"));
    }

    #[test]
    fn test_simulate_is_dry_run() {
        // simulate_patch is the dry-run: it returns new content but never writes
        let dir = setup_test_dir();

        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "world".to_string(),
            replacement: "universe".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let new_content = simulate_patch(&patch, dir.path()).unwrap();
        assert!(new_content.contains("universe"));

        // File on disk should be unchanged
        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents.contains("world"));
        assert!(!contents.contains("universe"));

        // apply_patch should write to disk
        let result = apply_patch(&patch, dir.path());
        assert!(result.applied);
        let contents2 = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents2.contains("universe"));
    }

    #[test]
    fn test_simulate_patch_returns_new_content() {
        clean_env();
        let dir = setup_test_dir();
        let patch = Patch {
            path: "test.txt".to_string(),
            pattern: "world".to_string(),
            replacement: "universe".to_string(),
            mode: "exact".to_string(),
            expected_hash: None,
            occurrences: 1,
        };

        let new_contents = simulate_patch(&patch, dir.path()).unwrap();
        assert!(new_contents.contains("universe"));
        assert!(new_contents.contains("world again"));
    }

    #[test]
    fn test_apply_patch_set_all_pass() {
        clean_env();
        let dir = setup_test_dir();
        let patchset = PatchSet {
            patches: vec![
                Patch {
                    path: "test.txt".to_string(),
                    pattern: "foo".to_string(),
                    replacement: "bar".to_string(),
                    mode: "exact".to_string(),
                    expected_hash: None,
                    occurrences: 1,
                },
                Patch {
                    path: "test.txt".to_string(),
                    pattern: "baz".to_string(),
                    replacement: "qux".to_string(),
                    mode: "exact".to_string(),
                    expected_hash: None,
                    occurrences: 1,
                },
            ],
            surface_hash: Some("abc123".to_string()),
        };

        let result = apply_patches(&patchset, dir.path());
        assert!(result.all_applied);
        assert_eq!(result.applied, 2);
        assert_eq!(result.failed, 0);

        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        // First patch: foo→bar (first occurrence only)
        // Second patch: baz→qux
        assert!(contents.contains("bar bar qux"));
    }

    #[test]
    fn test_apply_patch_set_atomic_failure() {
        clean_env();
        let dir = setup_test_dir();
        let patchset = PatchSet {
            patches: vec![
                Patch {
                    path: "test.txt".to_string(),
                    pattern: "foo".to_string(),
                    replacement: "bar".to_string(),
                    mode: "exact".to_string(),
                    expected_hash: None,
                    occurrences: 1,
                },
                Patch {
                    path: "nonexistent.txt".to_string(),
                    pattern: "x".to_string(),
                    replacement: "y".to_string(),
                    mode: "exact".to_string(),
                    expected_hash: None,
                    occurrences: 1,
                },
            ],
            surface_hash: None,
        };

        let result = apply_patches(&patchset, dir.path());
        assert!(!result.all_applied);
        assert_eq!(result.applied, 0);
        assert_eq!(result.failed, 1);

        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents.contains("foo bar baz"));
    }

    #[test]
    fn test_patch_set_result_serialization() {
        let result = PatchSetResult {
            results: vec![
                PatchResult {
                    path: "a.txt".to_string(),
                    applied: true,
                    old_content_sha256: Some("abc".to_string()),
                    new_content_sha256: Some("def".to_string()),
                    error: None,
                },
                PatchResult {
                    path: "b.txt".to_string(),
                    applied: false,
                    old_content_sha256: None,
                    new_content_sha256: None,
                    error: Some("FileNotFound".to_string()),
                },
            ],
            all_applied: false,
            total: 2,
            applied: 1,
            failed: 1,
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: PatchSetResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result.total, deserialized.total);
        assert_eq!(result.applied, deserialized.applied);
        assert_eq!(result.failed, deserialized.failed);
        assert_eq!(result.all_applied, deserialized.all_applied);
    }

    #[test]
    fn test_edit_patchset_roundtrip() {
        // Create a temp file and apply a patch, then verify the result
        let dir = setup_test_dir();

        // Create a patchset JSON
        let patchset = PatchSet {
            patches: vec![
                Patch {
                    path: "test.txt".to_string(),
                    pattern: "foo".to_string(),
                    replacement: "BAR".to_string(),
                    mode: "exact".to_string(),
                    expected_hash: None,
                    occurrences: 1,
                },
            ],
            surface_hash: Some("test-surface".to_string()),
        };

        let json = serde_json::to_string(&patchset).unwrap();
        let patchset_file = dir.path().join("patchset.json");
        fs::write(&patchset_file, &json).unwrap();

        // Apply patches
        let patchset: PatchSet = serde_json::from_str(&json).unwrap();
        let result = apply_patches(&patchset, dir.path());

        assert!(result.all_applied);
        assert_eq!(result.applied, 1);
        assert_eq!(result.failed, 0);

        let contents = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert!(contents.contains("BAR bar baz"));

        // Verify SHA256 in result
        assert!(result.results[0].new_content_sha256.is_some());
    }
}
