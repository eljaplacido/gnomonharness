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
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
    /// Wall time from spawn to the child's exit. See spawn_step for what this
    /// used to measure instead.
    pub duration_ms: u64,
    /// The timeout expired and the child was killed. `native_code` is -1 in
    /// that case (killed by a signal, so there is no exit code), which the
    /// bucket map already reads as apparatus_failure -- but a caller cannot
    /// tell a timeout from any other undeclared code without being told.
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    /// Bytes the child actually wrote to the stream. May exceed
    /// `stdout.len()`: see OUTPUT_CAP_BYTES.
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    /// The captured text is not all of it -- the cap was hit, or the drain was
    /// abandoned after DRAIN_GRACE. Published rather than implied, because a
    /// silently short capture reads exactly like a short command.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
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

/// Bytes retained per stream.
///
/// The drain threads keep READING past this and throw the excess away. They
/// never stop reading: a reader that stops is precisely what fills the pipe.
/// `stdout_bytes`/`stderr_bytes` report what the child actually wrote, so a
/// capped capture says so instead of looking like a short one.
const OUTPUT_CAP_BYTES: usize = 1024 * 1024;

/// How long to wait, after the child has exited or been killed, for the drain
/// threads to reach EOF.
///
/// Bounded, and the bound is a limit worth publishing: `Child::kill` signals
/// the child, not its descendants. A grandchild that inherited the pipe holds
/// the write end open, so EOF may never arrive. After this grace the capture
/// is reported with `*_truncated: true` and the run continues, rather than
/// trading one hang for another.
///
/// NOT VERIFIED: no test here spawns a grandchild that outlives its parent;
/// the grace is reasoning about how pipes and process groups work, not a
/// measurement.
const DRAIN_GRACE: Duration = Duration::from_millis(2_000);

/// Longest gap between `try_wait` polls. The first polls are 1ms apart so a
/// fast command's `duration_ms` is its own duration and not the sampling
/// interval; the backoff keeps a 900s timeout from burning a core.
const MAX_POLL: Duration = Duration::from_millis(20);

/// What one drain thread has read so far.
struct Capture {
    /// The first OUTPUT_CAP_BYTES bytes.
    kept: Vec<u8>,
    /// Every byte seen, capped or not.
    total: u64,
}

/// A drain thread and the buffer it is filling.
struct Drain {
    handle: std::thread::JoinHandle<()>,
    capture: Arc<Mutex<Capture>>,
}

/// Read a child pipe to EOF on its own thread, keeping the first
/// OUTPUT_CAP_BYTES and counting the rest.
fn drain_stream<R: std::io::Read + Send + 'static>(mut src: R) -> Drain {
    let capture = Arc::new(Mutex::new(Capture { kept: Vec::new(), total: 0 }));
    let sink = Arc::clone(&capture);
    let handle = std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match src.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    // Poisoning would mean the collector panicked; nothing is
                    // listening any more, so stop reading.
                    let Ok(mut cap) = sink.lock() else { break };
                    cap.total += n as u64;
                    if cap.kept.len() < OUTPUT_CAP_BYTES {
                        let room = OUTPUT_CAP_BYTES - cap.kept.len();
                        cap.kept.extend_from_slice(&chunk[..room.min(n)]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    Drain { handle, capture }
}

/// Wait up to `deadline` for a drain thread, then take whatever it has.
/// Returns (text, bytes_seen, truncated).
fn collect_drain(drain: Option<Drain>, deadline: Instant) -> (String, u64, bool) {
    let Some(drain) = drain else {
        return (String::new(), 0, false);
    };
    while !drain.handle.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    // Deliberately not `join()`: an abandoned thread is left detached rather
    // than blocking this one forever. See DRAIN_GRACE.
    let abandoned = !drain.handle.is_finished();
    let cap = drain.capture.lock().unwrap_or_else(|e| e.into_inner());
    // from_utf8_lossy, not from_utf8: the cap can land mid-codepoint, and a
    // replacement character is a better answer than an error about encoding
    // for output that was truncated on purpose.
    let text = String::from_utf8_lossy(&cap.kept).to_string();
    let truncated = abandoned || cap.total > cap.kept.len() as u64;
    (text, cap.total, truncated)
}

/// Run `cmd`, bound it by `timeout_ms`, and report what happened.
///
/// `cmd` is split on whitespace and executed directly -- there is no shell, so
/// no pipes, redirections, globs or quoting.
///
/// TWO MEASURED FAILURES produced the shape of this function.
///
/// 1. Deadlock above one pipe buffer. stdout and stderr were piped but only
///    read AFTER `child.wait()` returned. A child that writes more than the
///    kernel's pipe buffer (64 KiB on Linux) blocks in write() until someone
///    drains it, while the parent blocks in wait() until the child exits.
///    Neither ever moves. Measured:
///    $ gnomon-exec step --cmd "head -c 61440 /dev/zero" --timeout-ms 3000
///    wall=3.01s   exit=0                       (60 KiB: under the buffer)
///    $ gnomon-exec step --cmd "head -c 102400 /dev/zero" --timeout-ms 3000
///    wall=25.00s  exit=124                     (100 KiB: hung until an
///    outer `timeout 25` killed it)
///    Both pipes are now drained on their own threads from the moment the
///    child exists, so nothing waits on anything that is waiting on it.
///
/// 2. `duration_ms` was the timeout, not the command. The timeout was a thread
///    that slept for the whole `timeout_ms` and then fired, and the parent
///    `join()`ed it before stopping the clock -- so every step took the full
///    timeout in wall-clock and reported that as the command's duration.
///    Measured:
///    $ gnomon-exec step --cmd "echo hi" --timeout-ms 8000
///    "duration_ms": 8001    wall=8.00s
///    $ gnomon-exec step --cmd "echo hi" --timeout-ms 2000
///    "duration_ms": 2000    wall=2.00s
///    The number moved with the timeout and never with the command. It is
///    hashed into `session_steps_hash` and serialised into every session
///    record, so every recorded duration in this crate's history is the
///    timeout it was run under.
///
/// The old timeout also did not work. It ran `pkill -P <child>`, which kills
/// the child's CHILDREN and not the child, so a timed-out `head`, `sleep` or
/// `cat` was never signalled -- the wait simply blocked until the command
/// finished on its own. `try_wait` + `Child::kill` replaces it.
///
/// LIMIT, published rather than implied: `Child::kill` signals the direct
/// child only. A process group or a daemonised grandchild survives it. This
/// is a timeout, not a sandbox.
pub fn spawn_step(cmd: &str, timeout_ms: u64, _exit_map: &ExitCodeMap) -> Result<StepResult, ExecError> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err(ExecError::StepFailure("empty command".into()));
    }

    let start = Instant::now();

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

    // Before the wait, never after it. This is fix (1).
    let out_drain = child.stdout.take().map(drain_stream);
    let err_drain = child.stderr.take().map(drain_stream);

    // timeout_ms == 0 means no time at all: the child is killed on the first
    // poll. Said plainly here because "0 disables the timeout" is the other
    // plausible reading and it is not what this does.
    let deadline = start + Duration::from_millis(timeout_ms);
    let mut poll = Duration::from_millis(1);

    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) => {}
            Err(_) => return Err(ExecError::StepFailure("child wait failed".into())),
        }

        let now = Instant::now();
        if now >= deadline {
            let _ = child.kill();
            // Reap it, so the exit status is real and no zombie is left. kill()
            // has already been sent, so this returns promptly.
            break (child.wait().ok(), true);
        }

        std::thread::sleep(poll.min(deadline.saturating_duration_since(now)));
        poll = (poll * 2).min(MAX_POLL);
    };

    // Stopped here, at the child's exit -- not after draining, and not after
    // joining a thread that slept for the timeout. This is fix (2).
    let duration_ms = start.elapsed().as_millis() as u64;

    let drain_deadline = Instant::now() + DRAIN_GRACE;
    let (stdout, stdout_bytes, stdout_truncated) = collect_drain(out_drain, drain_deadline);
    let (stderr, stderr_bytes, stderr_truncated) = collect_drain(err_drain, drain_deadline);

    Ok(StepResult {
        // No exit code means killed by a signal, including by the timeout
        // above. -1 is undeclared, and the bucket map reads undeclared as
        // apparatus_failure -- which is what a killed step is.
        native_code: status.and_then(|s| s.code()).unwrap_or(-1),
        duration_ms,
        timed_out,
        stdout,
        stderr,
        stdout_bytes,
        stderr_bytes,
        stdout_truncated,
        stderr_truncated,
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
                // An integer nobody declared is an APPARATUS failure, not a
                // result. The catch-all used to be "result", so a code this
                // harness has never heard of -- a wrapper's own error, a shell
                // returning 126/127, a process killed by a signal -- was
                // counted as work completed, and would have entered a
                // denominator as a success. Rule 4 exists to stop exactly that
                // conflation, and the catch-all was quietly undoing it.
                //
                // Failing closed here costs nothing when the contract is
                // complete and is the only safe direction when it is not.
                _ => "apparatus_failure",
            };

            let output = serde_json::json!({
                "native_code": result.native_code,
                "bucket": bucket,
                "duration_ms": result.duration_ms,
                // Reported, not inferred. A caller that sees native_code -1
                // cannot otherwise tell "the timeout killed it" from "it died
                // of something else", and those are different problems.
                "timed_out": result.timed_out,
                "stdout": result.stdout.trim(),
                "stderr": result.stderr.trim(),
                // The capture is capped at 1 MiB per stream. Saying so beats
                // handing back a short string that looks complete.
                "stdout_bytes": result.stdout_bytes,
                "stderr_bytes": result.stderr_bytes,
                "stdout_truncated": result.stdout_truncated,
                "stderr_truncated": result.stderr_truncated,
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

    /// Run `spawn_step` on its own thread and give up after `budget`.
    ///
    /// Every test below covers a defect whose symptom was a HANG. A hanging
    /// test reports nothing -- it is the same "reports success while doing
    /// nothing" shape one level up, since a suite that never finishes never
    /// says it failed either. This turns each hang into a named failure.
    fn spawn_step_bounded(cmd: &'static str, timeout_ms: u64, budget: Duration) -> StepResult {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let map = default_exit_code_map();
            let _ = tx.send(spawn_step(cmd, timeout_ms, &map));
        });
        match rx.recv_timeout(budget) {
            Ok(result) => result.unwrap_or_else(|e| panic!("spawn_step('{cmd}') errored: {e}")),
            Err(_) => panic!(
                "spawn_step('{cmd}') did not return within {budget:?} -- it is deadlocked"
            ),
        }
    }

    #[test]
    fn test_spawn_step_survives_more_than_one_pipe_buffer() {
        // 256 KiB, four times the 64 KiB Linux pipe buffer. Before the drain
        // threads existed this blocked forever: the child in write(), the
        // parent in wait(). Measured at 100 KiB: wall=25.00s, killed by an
        // outer `timeout 25`, against --timeout-ms 3000.
        let result = spawn_step_bounded(
            "head -c 262144 /dev/zero",
            10_000,
            Duration::from_secs(20),
        );
        assert_eq!(result.native_code, 0, "the child exits 0; it is not killed");
        assert!(!result.timed_out, "256 KiB in under 10s is not a timeout");
        assert_eq!(
            result.stdout_bytes, 262_144,
            "every byte the child wrote must be accounted for"
        );
        assert!(!result.stdout_truncated, "256 KiB is well under the 1 MiB cap");
    }

    #[test]
    fn test_spawn_step_duration_is_the_command_not_the_timeout() {
        // Measured before the fix: `echo hi --timeout-ms 8000` reported
        // duration_ms 8001, and `--timeout-ms 2000` reported 2000. The number
        // tracked the timeout and never the command.
        let slept = spawn_step_bounded("sleep 0.4", 9_000, Duration::from_secs(20));
        assert_eq!(slept.native_code, 0);
        assert!(!slept.timed_out);
        assert!(
            slept.duration_ms >= 350,
            "a 0.4s command cannot take {}ms -- the clock is not running",
            slept.duration_ms
        );
        assert!(
            slept.duration_ms < 4_000,
            "a 0.4s command under a 9s timeout reported {}ms; that is the timeout, not the command",
            slept.duration_ms
        );

        // Same command, a different timeout. The old code returned ~the
        // timeout for both, so these two numbers moved together; they must not.
        let a = spawn_step_bounded("sleep 0.4", 3_000, Duration::from_secs(20));
        let b = spawn_step_bounded("sleep 0.4", 9_000, Duration::from_secs(20));
        let spread = a.duration_ms.abs_diff(b.duration_ms);
        assert!(
            spread < 1_000,
            "the same command under a 3s and a 9s timeout reported {}ms and {}ms; \
             duration_ms is still following the timeout",
            a.duration_ms,
            b.duration_ms
        );
    }

    #[test]
    fn test_spawn_step_timeout_kills_the_child() {
        // The old timeout ran `pkill -P <child>`, which kills the child's
        // CHILDREN. `sleep` has none, so it was never signalled and the wait
        // blocked for the full 30s. The budget here is 8s, so that failure
        // now reports as a failure.
        let start = Instant::now();
        let result = spawn_step_bounded("sleep 30", 400, Duration::from_secs(8));
        let observed = start.elapsed();

        assert!(result.timed_out, "a 30s command under a 400ms timeout must time out");
        assert_eq!(
            result.native_code, -1,
            "killed by a signal, so there is no exit code"
        );
        assert!(
            observed < Duration::from_secs(6),
            "the timeout returned after {observed:?}; it did not kill the child"
        );

        // And the bucket the CLI would assign: -1 is undeclared, and
        // undeclared is apparatus_failure, never a result.
        assert_eq!(default_exit_code_map().bucket(0), Some(&Bucket::Result));
        assert!(
            !matches!(result.native_code, 0 | 1),
            "a killed step must not land in the result bucket"
        );
    }

    #[test]
    fn test_spawn_step_publishes_its_output_cap() {
        // 1.2 MB, over the 1 MiB cap. The cap is not the bug -- silence about
        // it would be: a capped capture reads exactly like a short command.
        let over = OUTPUT_CAP_BYTES as u64 + 200_000;
        let result = spawn_step_bounded(
            "head -c 1248576 /dev/zero",
            15_000,
            Duration::from_secs(25),
        );
        assert_eq!(over, 1_248_576, "the command above must write over the cap");
        assert_eq!(result.native_code, 0, "capping must not kill the child");
        assert_eq!(
            result.stdout_bytes, 1_248_576,
            "the byte count reports what was written, not what was kept"
        );
        assert!(result.stdout_truncated, "over the cap must be reported as truncated");
        assert_eq!(
            result.stdout.len(),
            OUTPUT_CAP_BYTES,
            "exactly the cap is kept"
        );
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
