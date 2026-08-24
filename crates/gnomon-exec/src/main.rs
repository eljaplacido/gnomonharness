//! gnomon-exec: spawn, timeout, sandbox, outcome capture.
//!
//! This crate drives deterministic agent sessions:
//!   - Spawns commands with configurable timeouts
//!   - Maps exit codes to outcome buckets (result/refusal/apparatus_failure)
//!   - Records ordered session steps with manifest + step outcomes
//!   - Validates sessions against conformance fixtures

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;
use thiserror::Error;

// ─────────────────────────────────────────────
// Data model
// ─────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    Result,
    Refusal,
    ApparatusFailure,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExitCodeMap {
    #[serde(flatten)]
    pub codes: HashMap<String, Bucket>,
}

impl ExitCodeMap {
    pub fn bucket(&self, code: u32) -> Option<&Bucket> {
        self.codes.get(&code.to_string())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionStep {
    pub seq: u32,
    pub native_code: i32,
    pub bucket: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Default for SessionStep {
    fn default() -> Self {
        SessionStep {
            seq: 0,
            native_code: -1,
            bucket: String::new(),
            duration_ms: 0,
            action: None,
            tool: None,
            result: None,
            reason: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionManifest {
    pub build: String,
    pub surface_hash: String,
    pub sources: Vec<SourceEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SourceEntry {
    pub path: String,
    pub sha256: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionRecord {
    pub version: String,
    pub session: Session,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub manifest: SessionManifest,
    pub steps: Vec<SessionStep>,
}

#[derive(Debug)]
pub struct StepResult {
    pub native_code: i32,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
}

// ─────────────────────────────────────────────
// Exit code mapping
// ─────────────────────────────────────────────

pub fn default_exit_code_map() -> ExitCodeMap {
    let mut codes = HashMap::new();
    codes.insert("0".to_string(), Bucket::Result);
    codes.insert("1".to_string(), Bucket::Result);
    codes.insert("2".to_string(), Bucket::Refusal);
    codes.insert("3".to_string(), Bucket::Refusal);
    codes.insert("4".to_string(), Bucket::Refusal);
    codes.insert("10".to_string(), Bucket::ApparatusFailure);
    codes.insert("11".to_string(), Bucket::ApparatusFailure);
    codes.insert("12".to_string(), Bucket::ApparatusFailure);
    codes.insert("13".to_string(), Bucket::ApparatusFailure);
    ExitCodeMap { codes }
}

impl ExitCodeMap {
    pub fn from_file(path: &Path) -> Result<ExitCodeMap, ExecError> {
        let contents = fs::read_to_string(path).map_err(|e| ExecError::Io {
            context: "reading exit code map".into(),
            source: e,
        })?;
        serde_json::from_str(&contents).map_err(|e| ExecError::Deserialize {
            context: "exit code map".into(),
            source: e,
        })
    }

    pub fn validate(&self) -> Result<(), ExecError> {
        if self.codes.is_empty() {
            return Err(ExecError::Validation("exit code map has no entries".into()));
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum ExecError {
    #[error("IO error: {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Deserialization error in {context}: {source}")]
    Deserialize {
        context: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Step failed: {0}")]
    StepFailure(String),
    #[error("Fixture mismatch: {0}")]
    FixtureMismatch(String),
}

// ─────────────────────────────────────────────
// Step execution
// ─────────────────────────────────────────────

pub fn spawn_step(cmd: &str, timeout_ms: u64, _exit_map: &ExitCodeMap) -> Result<StepResult, ExecError> {
    let start = Instant::now();

    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err(ExecError::StepFailure("empty command".into()));
    }

    let mut child = Command::new(parts[0])
        .args(&parts[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ExecError::Io {
            context: format!("spawning '{}'", cmd),
            source: e,
        })?;

    // Enforce timeout: wait in a separate thread, kill if exceeded
    let child_handle = child.id();
    let timeout_thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(timeout_ms));
        // Try to kill the process tree
        let _ = Command::new("pkill")
            .args(["-P", &child_handle.to_string()])
            .spawn();
    });

    let status = match child.wait() {
        Ok(s) => s,
        Err(_) => return Err(ExecError::StepFailure("child wait failed".into())),
    };

    // Join the timeout thread (it may or may not have fired)
    let _ = timeout_thread.join();

    let duration_ms = start.elapsed().as_millis() as u64;

    let stdout = child.stdout.take().map(|handle| {
        let mut buf = Vec::new();
        let _ = handle.take(1024 * 1024).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    }).unwrap_or_default();

    let stderr = child.stderr.take().map(|handle| {
        let mut buf = Vec::new();
        let _ = handle.take(1024 * 1024).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    }).unwrap_or_default();

    Ok(StepResult {
        native_code: status.code().unwrap_or(-1),
        duration_ms,
        stdout,
        stderr,
    })
}

// ─────────────────────────────────────────────
// Session building
// ─────────────────────────────────────────────

pub fn build_session(manifest: SessionManifest, steps: Vec<SessionStep>) -> SessionRecord {
    SessionRecord {
        version: "0.1.0".into(),
        session: Session { manifest, steps },
    }
}

pub fn session_to_json(record: &SessionRecord) -> Result<String, ExecError> {
    serde_json::to_string_pretty(record).map_err(|e| ExecError::Deserialize {
        context: "session serialization".into(),
        source: e,
    })
}

pub fn load_session(path: &Path) -> Result<SessionRecord, ExecError> {
    let contents = fs::read_to_string(path).map_err(|e| ExecError::Io {
        context: format!("reading session from {}", path.display()),
        source: e,
    })?;
    serde_json::from_str(&contents).map_err(|e| ExecError::Deserialize {
        context: format!("session from {}", path.display()),
        source: e,
    })
}

// ─────────────────────────────────────────────
// Session validation
// ─────────────────────────────────────────────

pub fn validate_session(record: &SessionRecord, fixture_path: Option<&Path>) -> Result<(), ExecError> {
    if record.version != "0.1.0" {
        return Err(ExecError::Validation(format!(
            "expected version 0.1.0, got {}", record.version
        )));
    }

    if record.session.manifest.build.is_empty() {
        return Err(ExecError::Validation("manifest.build is empty".into()));
    }
    if record.session.manifest.surface_hash.is_empty() {
        return Err(ExecError::Validation("manifest.surface_hash is empty".into()));
    }
    if record.session.steps.is_empty() {
        return Err(ExecError::Validation("steps array is empty".into()));
    }

    for step in &record.session.steps {
        if step.bucket.is_empty() {
            return Err(ExecError::Validation(format!("step {} has empty bucket", step.seq)));
        }
        match step.bucket.as_str() {
            "result" | "refusal" | "apparatus_failure" => {}
            _ => {
                return Err(ExecError::Validation(format!(
                    "step {} has invalid bucket: {}", step.seq, step.bucket
                )));
            }
        }
    }

    if let Some(fixture_path) = fixture_path {
        let fixture_content = fs::read_to_string(fixture_path).map_err(|e| ExecError::Io {
            context: format!("reading fixture {}", fixture_path.display()),
            source: e,
        })?;
        let fixture: SessionRecord = serde_json::from_str(&fixture_content).map_err(|e| ExecError::Deserialize {
            context: format!("parsing fixture {}", fixture_path.display()),
            source: e,
        })?;

        if record.session.steps.len() != fixture.session.steps.len() {
            return Err(ExecError::FixtureMismatch(format!(
                "step count mismatch: got {}, fixture {}",
                record.session.steps.len(), fixture.session.steps.len()
            )));
        }

        for (i, (actual, expected)) in record.session.steps.iter().zip(fixture.session.steps.iter()).enumerate() {
            if actual.bucket != expected.bucket {
                return Err(ExecError::FixtureMismatch(format!(
                    "step {} bucket mismatch: got {}, fixture {}",
                    i, actual.bucket, expected.bucket
                )));
            }
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────
// SHA256 utilities
// ─────────────────────────────────────────────

pub fn sha256_str(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn session_steps_hash(steps: &[SessionStep]) -> String {
    let mut hasher = Sha256::new();
    for step in steps {
        hasher.update(format!("{}:{}:{}:{}", step.seq, step.native_code, step.bucket, step.duration_ms));
    }
    format!("{:x}", hasher.finalize())
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

fn print_usage() {
    println!("gnomon-exec: spawn, timeout, sandbox, outcome capture");
    println!();
    println!("Usage:");
    println!("  gnomon-exec step     --cmd <command> [--timeout-ms <ms>]");
    println!("  gnomon-exec validate   --session <file> [--fixture <golden.json>]");
    println!("  gnomon-exec hash       --session <file>");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let command = args[1].as_str();

    match command {
        "step" => {
            let mut cmd = String::new();
            let mut timeout_ms = 30_000u64;

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--cmd" => {
                        i += 1;
                        if i < args.len() { cmd = args[i].clone(); }
                    }
                    "--timeout-ms" => {
                        i += 1;
                        if i < args.len() {
                            timeout_ms = args[i].parse().unwrap_or(30_000);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }

            if cmd.is_empty() {
                eprintln!("Error: --cmd is required");
                std::process::exit(1);
            }

            let exit_map = default_exit_code_map();
            let result = match spawn_step(&cmd, timeout_ms, &exit_map) {
                Ok(r) => r,
                Err(e) => { eprintln!("{}", e); std::process::exit(1); }
            };

            let bucket = match result.native_code {
                0 => "result",
                1 => "result",
                2..=4 => "refusal",
                10..=13 => "apparatus_failure",
                _ => "result",
            };

            let output = serde_json::json!({
                "native_code": result.native_code,
                "bucket": bucket,
                "duration_ms": result.duration_ms,
                "stdout": result.stdout.trim(),
                "stderr": result.stderr.trim(),
            });

            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        }

        "validate" => {
            let mut session_path = String::new();
            let mut fixture_path = String::new();

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--session" => {
                        i += 1;
                        if i < args.len() { session_path = args[i].clone(); }
                    }
                    "--fixture" => {
                        i += 1;
                        if i < args.len() { fixture_path = args[i].clone(); }
                    }
                    _ => {}
                }
                i += 1;
            }

            if session_path.is_empty() {
                eprintln!("Error: --session is required");
                std::process::exit(1);
            }

            let record = load_session(Path::new(&session_path)).unwrap_or_else(|e| {
                eprintln!("Error loading session: {}", e);
                std::process::exit(1);
            });

            let fixture = if !fixture_path.is_empty() {
                Some(Path::new(&fixture_path))
            } else {
                None
            };

            match validate_session(&record, fixture) {
                Ok(()) => {
                    println!("OK session valid");
                    if fixture.is_some() { println!("OK matches fixture structure"); }
                }
                Err(e) => { eprintln!("FAIL: {}", e); std::process::exit(1); }
            }
        }

        "hash" => {
            let mut session_path = String::new();
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--session" {
                    i += 1;
                    if i < args.len() { session_path = args[i].clone(); }
                }
                i += 1;
            }

            if session_path.is_empty() {
                eprintln!("Error: --session is required");
                std::process::exit(1);
            }

            let record = load_session(Path::new(&session_path)).unwrap_or_else(|e| {
                eprintln!("Error loading session: {}", e);
                std::process::exit(1);
            });

            println!("{}", session_steps_hash(&record.session.steps));
        }

        "--help" | "-h" => print_usage(),
        _ => { eprintln!("Unknown command: {}", command); print_usage(); std::process::exit(1); }
    }
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dummy_manifest() -> SessionManifest {
        SessionManifest {
            build: "0.1.0+test".into(),
            surface_hash: "abc123".into(),
            sources: vec![
                SourceEntry { path: ".gnomon/config.toml".into(), sha256: Some("sha256:config".into()) },
                SourceEntry { path: ".gnomon/system.md".into(), sha256: Some("sha256:system".into()) },
            ],
        }
    }

    // ── Exit code mapping ──

    #[test]
    fn test_exit_code_map_default() {
        let map = default_exit_code_map();
        assert_eq!(map.bucket(0), Some(&Bucket::Result));
        assert_eq!(map.bucket(1), Some(&Bucket::Result));
        assert_eq!(map.bucket(2), Some(&Bucket::Refusal));
        assert_eq!(map.bucket(3), Some(&Bucket::Refusal));
        assert_eq!(map.bucket(4), Some(&Bucket::Refusal));
        assert_eq!(map.bucket(10), Some(&Bucket::ApparatusFailure));
        assert_eq!(map.bucket(11), Some(&Bucket::ApparatusFailure));
        assert_eq!(map.bucket(12), Some(&Bucket::ApparatusFailure));
        assert_eq!(map.bucket(13), Some(&Bucket::ApparatusFailure));
        assert_eq!(map.bucket(99), None);
    }

    #[test]
    fn test_exit_code_map_validate() {
        assert!(default_exit_code_map().validate().is_ok());
        let empty_map = ExitCodeMap { codes: HashMap::new() };
        assert!(empty_map.validate().is_err());
    }

    #[test]
    fn test_exit_code_map_from_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("exit_codes.json");
        // JSON keys are always strings
        fs::write(&path, r#"{"0":"result","1":"result","2":"refusal"}"#).unwrap();
        let map = ExitCodeMap::from_file(&path).unwrap();
        assert_eq!(map.bucket(0), Some(&Bucket::Result));
        assert_eq!(map.bucket(2), Some(&Bucket::Refusal));
    }

    #[test]
    fn test_exit_code_map_from_missing_file() {
        assert!(ExitCodeMap::from_file(Path::new("/nonexistent/path.json")).is_err());
    }

    // ── Step execution ──

    #[test]
    fn test_spawn_step_echo() {
        let map = default_exit_code_map();
        let result = spawn_step("echo hello", 5000, &map).unwrap();
        assert_eq!(result.native_code, 0);
        
        assert!(result.stdout.contains("hello"));
    }

    #[test]
    fn test_spawn_step_nonzero_exit() {
        let map = default_exit_code_map();
        let result = spawn_step("false", 5000, &map).unwrap();
        assert_eq!(result.native_code, 1);
    }

    #[test]
    fn test_spawn_step_empty_command() {
        let map = default_exit_code_map();
        assert!(spawn_step("", 5000, &map).is_err());
    }

    #[test]
    fn test_spawn_step_output_capture() {
        let map = default_exit_code_map();
        let result = spawn_step("echo -e 'line1\\nline2'", 5000, &map).unwrap();
        assert_eq!(result.native_code, 0);
        assert!(result.stdout.contains("line1"));
        assert!(result.stdout.contains("line2"));
    }

    // ── Session building ──

    #[test]
    fn test_build_session() {
        let manifest = dummy_manifest();
        let steps = vec![
            SessionStep { seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 150, action: Some("read".into()), tool: Some("read".into()), result: Some("read file".into()), reason: None },
            SessionStep { seq: 2, native_code: 2, bucket: "refusal".into(), duration_ms: 20, action: Some("reject".into()), tool: None, result: None, reason: Some("model declined".into()) },
        ];
        let record = build_session(manifest, steps);
        assert_eq!(record.version, "0.1.0");
        assert_eq!(record.session.steps.len(), 2);
        assert_eq!(record.session.steps[0].bucket, "result");
        assert_eq!(record.session.steps[1].bucket, "refusal");

        let json = session_to_json(&record).unwrap();
        let parsed: SessionRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.session.steps.len(), 2);
    }

    #[test]
    fn test_session_jsonl_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("session.json");

        let manifest = dummy_manifest();
        let steps = vec![SessionStep {
            seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 100,
            action: Some("test".into()), ..Default::default()
        }];

        let record = build_session(manifest, steps);
        let json = session_to_json(&record).unwrap();
        fs::write(&path, &json).unwrap();

        let loaded = load_session(&path).unwrap();
        assert_eq!(loaded.version, "0.1.0");
        assert_eq!(loaded.session.steps.len(), 1);
        assert_eq!(loaded.session.steps[0].native_code, 0);
    }

    // ── Session validation ──

    #[test]
    fn test_validate_session_good() {
        let manifest = dummy_manifest();
        let steps = vec![SessionStep {
            seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 100,
            ..Default::default()
        }];
        let record = build_session(manifest, steps);
        assert!(validate_session(&record, None).is_ok());
    }

    #[test]
    fn test_validate_session_bad_version() {
        let record = SessionRecord {
            version: "9.9.9".into(),
            session: Session { manifest: dummy_manifest(), steps: vec![] },
        };
        assert!(validate_session(&record, None).is_err());
    }

    #[test]
    fn test_validate_session_bad_bucket() {
        let record = SessionRecord {
            version: "0.1.0".into(),
            session: Session {
                manifest: dummy_manifest(),
                steps: vec![SessionStep {
                    seq: 1, native_code: 0, bucket: "invalid_bucket".into(),
                    duration_ms: 100, ..Default::default()
                }],
            },
        };
        assert!(validate_session(&record, None).is_err());
    }

    #[test]
    fn test_validate_session_empty_steps() {
        let record = SessionRecord {
            version: "0.1.0".into(),
            session: Session { manifest: dummy_manifest(), steps: vec![] },
        };
        assert!(validate_session(&record, None).is_err());
    }

    #[test]
    fn test_validate_session_against_fixture() {
        let dir = TempDir::new().unwrap();
        let session_path = dir.path().join("session.json");
        let fixture_path = dir.path().join("fixture.json");

        // Write a fixture matching the golden session format
        let fixture_json = r#"
        {
            "version": "0.1.0",
            "session": {
                "manifest": {"build": "test", "surface_hash": "abc", "sources": []},
                "steps": [
                    {"seq": 1, "native_code": 0, "bucket": "result", "duration_ms": 150, "action": "read", "tool": "read", "result": "read file"},
                    {"seq": 2, "native_code": 2, "bucket": "refusal", "duration_ms": 20, "action": "reject", "reason": "model declined"}
                ]
            }
        }"#;
        fs::write(&fixture_path, fixture_json).unwrap();

        // Build matching session
        let manifest = SessionManifest {
            build: "test".into(),
            surface_hash: "abc".into(),
            sources: vec![],
        };
        let steps = vec![
            SessionStep { seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 150, action: Some("read".into()), tool: Some("read".into()), result: Some("read file".into()), reason: None },
            SessionStep { seq: 2, native_code: 2, bucket: "refusal".into(), duration_ms: 20, action: Some("reject".into()), tool: None, result: None, reason: Some("model declined".into()) },
        ];
        let record = build_session(manifest, steps);
        let json = session_to_json(&record).unwrap();
        fs::write(&session_path, &json).unwrap();

        assert!(validate_session(&record, Some(&fixture_path)).is_ok());
    }

    #[test]
    fn test_validate_session_fixture_match() {
        let dir = TempDir::new().unwrap();
        let session_path = dir.path().join("session.json");
        let fixture_path = dir.path().join("fixture.json");

        fs::write(&fixture_path, r#"{"version":"0.1.0","session":{"manifest":{"build":"t","surface_hash":"s","sources":[]},"steps":[{"seq":1,"native_code":0,"bucket":"result","duration_ms":100}]}}"#).unwrap();

        let manifest = SessionManifest { build: "t".into(), surface_hash: "s".into(), sources: vec![] };
        let steps = vec![
            SessionStep { seq: 1, native_code: 1, bucket: "result".into(), duration_ms: 100, ..Default::default() },
        ];
        let record = build_session(manifest, steps);
        let json = session_to_json(&record).unwrap();
        fs::write(&session_path, &json).unwrap();

        // Same step count, same bucket — should pass
        assert!(validate_session(&record, Some(&fixture_path)).is_ok());
    }

    // ── SHA256 utilities ──

    #[test]
    fn test_sha256_str_deterministic() {
        let h1 = sha256_str("hello world");
        let h2 = sha256_str("hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert_ne!(h1, sha256_str("hello worlds"));
    }

    #[test]
    fn test_session_steps_hash_deterministic() {
        let steps = vec![
            SessionStep { seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 100, ..Default::default() },
        ];
        let h1 = session_steps_hash(&steps);
        let h2 = session_steps_hash(&steps);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);

        // Different steps → different hash
        let steps2 = vec![
            SessionStep { seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 200, ..Default::default() },
        ];
        assert_ne!(h1, session_steps_hash(&steps2));
    }

    #[test]
    fn test_session_steps_hash_order_matters() {
        let steps1 = vec![
            SessionStep { seq: 1, native_code: 0, bucket: "result".into(), duration_ms: 100, ..Default::default() },
            SessionStep { seq: 2, native_code: 2, bucket: "refusal".into(), duration_ms: 20, ..Default::default() },
        ];
        let steps2 = vec![
            SessionStep { seq: 1, native_code: 2, bucket: "refusal".into(), duration_ms: 20, ..Default::default() },
            SessionStep { seq: 2, native_code: 0, bucket: "result".into(), duration_ms: 100, ..Default::default() },
        ];
        assert_ne!(session_steps_hash(&steps1), session_steps_hash(&steps2));
    }

    // ── Exit code bucket consistency ──

    #[test]
    fn test_exit_code_bucket_consistency() {
        let map = default_exit_code_map();
        for (code, bucket) in &map.codes {
            match code.as_str() {
                "0" | "1" => assert_eq!(bucket, &Bucket::Result),
                "2" | "3" | "4" => assert_eq!(bucket, &Bucket::Refusal),
                "10" | "11" | "12" | "13" => assert_eq!(bucket, &Bucket::ApparatusFailure),
                _ => panic!("unexpected code: {}", code),
            }
        }
    }

    #[test]
    fn test_no_refusal_as_failure() {
        // Contract: refusal is never recorded as failure
        let map = default_exit_code_map();
        for code in [2, 3, 4] {
            assert_eq!(map.bucket(code), Some(&Bucket::Refusal));
            assert_ne!(map.bucket(code), Some(&Bucket::Result));
        }
    }

    // ── Integration: spawn + validate round trip ──

    #[test]
    fn test_spawn_then_build_session() {
        let map = default_exit_code_map();

        let result = spawn_step("echo hello world", 5000, &map).unwrap();
        assert_eq!(result.native_code, 0);

        let step = SessionStep {
            seq: 1,
            native_code: result.native_code,
            bucket: "result".into(),
            duration_ms: result.duration_ms,
            action: Some("echo".into()),
            result: Some(result.stdout.trim().to_string()),
            ..Default::default()
        };

        let manifest = dummy_manifest();
        let record = build_session(manifest, vec![step]);
        assert!(validate_session(&record, None).is_ok());
    }

    #[test]
    fn test_session_fixture_roundtrip() {
        // Verify that the session golden fixture is valid
        let fixture_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("conformance/session_golden.json");
        let fixture_content = fs::read_to_string(&fixture_path)
            .unwrap_or_else(|_| panic!("Golden session fixture must exist at {}", fixture_path.display()));

        // Parse as generic JSON to check structure
        let parsed: serde_json::Value = serde_json::from_str(&fixture_content)
            .unwrap_or_else(|_| panic!("Session golden must be valid JSON"));

        // Must have session object
        let session = parsed.get("session").expect("Session must have 'session' key");
        assert!(session.get("manifest").is_some(), "Session must have manifest");
        assert!(session.get("steps").is_some(), "Session must have steps");

        let steps = session.get("steps").unwrap().as_array().unwrap();
        for (i, step) in steps.iter().enumerate() {
            assert!(step.get("native_code").is_some(), "Step {} must have native_code", i);
            assert!(step.get("bucket").is_some(), "Step {} must have bucket", i);
            assert!(step.get("duration_ms").is_some(), "Step {} must have duration_ms", i);
            // Bucket must be valid
            let bucket = step.get("bucket").unwrap().as_str().unwrap();
            assert!(matches!(bucket, "result" | "refusal" | "apparatus_failure"),
                "Step {} bucket '{}' must be valid", i, bucket);
        }
    }
}
