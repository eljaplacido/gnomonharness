//! The `gnomon dashboard` child: start it, read its sign-in link from its
//! stdout, stop it.
//!
//! The app runs `gnomon dashboard --no-open --port 0 --dir <project>`: the OS
//! picks a free port (never a fixed one another server might hold), the CLI
//! opens no browser, and the project the user picked is the dashboard's
//! "here". The link comes back over the child's stdout pipe, which only this
//! process holds. Exit codes are CONTRACTS.md §17's.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::link::{parse_sign_in_line, SignIn};
use crate::spawn::{for_each_line, prepare, stop_tree, wait_for, Job, Tail};

/// `gnomon dashboard`'s exit codes (CONTRACTS.md §17, conformance/dashboard.json).
pub mod exit {
    pub const STOPPED: i32 = 0;
    pub const USAGE: i32 = 1;
    pub const PORT_UNAVAILABLE: i32 = 4;
    pub const LAUNCH_FAILED: i32 = 10;
}

/// The arguments, before `--dir <project>`. `--port 0`: the OS picks.
pub const DASHBOARD_ARGS: [&str; 4] = ["dashboard", "--no-open", "--port", "0"];

/// What a stopped or failed dashboard's exit code means, in words.
pub fn describe_exit(code: Option<i32>) -> String {
    match code {
        Some(exit::STOPPED) => "gnomon dashboard stopped (exit 0)".into(),
        Some(exit::USAGE) => {
            "gnomon dashboard refused its arguments (exit 1, usage): this gnomon may predate \
             `gnomon dashboard --no-open --port 0 --dir`"
                .into()
        }
        Some(exit::PORT_UNAVAILABLE) => {
            "gnomon dashboard could not get a port on 127.0.0.1 (exit 4, preconditions_unmet)"
                .into()
        }
        Some(exit::LAUNCH_FAILED) => {
            "gnomon dashboard could not start (exit 10, launch_failed)".into()
        }
        Some(n) => format!("gnomon dashboard exited with code {n}"),
        None => "gnomon dashboard was ended by a signal".into(),
    }
}

/// How to start it.
#[derive(Debug, Clone)]
pub struct StartOptions {
    pub program: PathBuf,
    pub project: PathBuf,
    /// PATH for the child (cli::child_path).
    pub path_env: std::ffi::OsString,
    /// How long to wait for the sign-in link.
    pub timeout: Duration,
}

/// Why it did not start.
#[derive(Debug)]
pub enum StartError {
    Spawn(String),
    Exited { code: Option<i32>, stderr: String },
    NoLink { waited: Duration, stderr: String },
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let with = |f: &mut std::fmt::Formatter<'_>, head: String, stderr: &str| {
            if stderr.trim().is_empty() {
                write!(f, "{head}.")
            } else {
                write!(f, "{head}:\n{}", stderr.trim())
            }
        };
        match self {
            StartError::Spawn(why) => write!(f, "could not run gnomon: {why}"),
            StartError::Exited { code, stderr } => with(f, describe_exit(*code), stderr),
            StartError::NoLink { waited, stderr } => with(
                f,
                format!(
                    "gnomon dashboard printed no sign-in link within {} s",
                    waited.as_secs()
                ),
                stderr,
            ),
        }
    }
}

/// A running `gnomon dashboard`. Dropping it stops it.
pub struct DashboardProcess {
    child: Child,
    job: Option<Job>,
    port: u16,
    stderr: Arc<Mutex<Tail>>,
    stopped: bool,
}

impl DashboardProcess {
    /// Start the dashboard and wait for its sign-in link.
    ///
    /// `on_exit` runs on a background thread when the child's stdout closes,
    /// which is when the server has gone, for any reason: stopped by this app,
    /// crashed, or killed. It also runs when a start fails. The caller decides
    /// whether the exit was expected.
    pub fn start(
        opts: &StartOptions,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(DashboardProcess, SignIn), StartError> {
        let mut cmd = Command::new(&opts.program);
        cmd.args(DASHBOARD_ARGS)
            .arg("--dir")
            .arg(&opts.project)
            .current_dir(&opts.project)
            .env("PATH", &opts.path_env)
            .env("NO_COLOR", "1")
            .env("GNOMON_NO_UPDATE_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| StartError::Spawn(e.to_string()))?;
        let job = Job::for_child(&child).ok();

        let stderr = Arc::new(Mutex::new(Tail::new(40)));
        let (err_done_tx, err_done) = mpsc::channel::<()>();
        {
            let pipe = child.stderr.take().expect("piped");
            let tail = Arc::clone(&stderr);
            thread::spawn(move || {
                for_each_line(pipe, |l| tail.lock().map(|mut t| t.push(l)).unwrap_or(()));
                let _ = err_done_tx.send(());
            });
        }

        let (link_tx, link_rx) = mpsc::channel::<SignIn>();
        {
            let pipe = child.stdout.take().expect("piped");
            thread::spawn(move || {
                let mut sent = false;
                // Keep draining after the link, or a full pipe would block the
                // server. Nothing else it prints is kept: the link is a secret.
                for_each_line(pipe, |l| {
                    if !sent {
                        if let Some(s) = parse_sign_in_line(&l) {
                            sent = link_tx.send(s).is_ok();
                        }
                    }
                });
                drop(link_tx);
                on_exit();
            });
        }

        let stderr_text = |err_done: &mpsc::Receiver<()>, stderr: &Arc<Mutex<Tail>>| {
            let _ = err_done.recv_timeout(Duration::from_secs(1));
            stderr.lock().map(|t| t.text()).unwrap_or_default()
        };

        match link_rx.recv_timeout(opts.timeout) {
            Ok(sign_in) => {
                let port = sign_in.port();
                Ok((
                    DashboardProcess {
                        child,
                        job,
                        port,
                        stderr,
                        stopped: false,
                    },
                    sign_in,
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Its stdout closed before a link: it exited (or is exiting).
                let code = wait_for(&mut child, Duration::from_secs(5)).and_then(|s| s.code());
                stop_tree(&mut child, job.as_ref(), Duration::from_millis(500));
                Err(StartError::Exited {
                    code,
                    stderr: stderr_text(&err_done, &stderr),
                })
            }
            Err(RecvTimeoutError::Timeout) => {
                stop_tree(&mut child, job.as_ref(), Duration::from_secs(2));
                Err(StartError::NoLink {
                    waited: opts.timeout,
                    stderr: stderr_text(&err_done, &stderr),
                })
            }
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// `Some(code)` once it has exited (`None` inside for a signal).
    pub fn exited(&mut self) -> Option<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(st)) => Some(st.code()),
            _ => None,
        }
    }

    /// Wait up to `limit` for it to exit on its own.
    pub fn exit_within(&mut self, limit: Duration) -> Option<Option<i32>> {
        wait_for(&mut self.child, limit).map(|s| s.code())
    }

    /// The last lines it printed on stderr.
    pub fn stderr_tail(&self) -> String {
        self.stderr.lock().map(|t| t.text()).unwrap_or_default()
    }

    /// Stop it and everything it started. Idempotent.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        stop_tree(&mut self.child, self.job.as_ref(), Duration::from_secs(3));
    }
}

impl Drop for DashboardProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_are_the_contracts() {
        // conformance/dashboard.json, "exit_codes".
        let fixture = include_str!("../../../../conformance/dashboard.json");
        let doc: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let codes = &doc["exit_codes"];
        assert_eq!(codes["stopped"], exit::STOPPED);
        assert_eq!(codes["usage"], exit::USAGE);
        assert_eq!(codes["port_unavailable"], exit::PORT_UNAVAILABLE);
        assert_eq!(codes["launch_failed"], exit::LAUNCH_FAILED);
        assert!(describe_exit(Some(4)).contains("preconditions_unmet"));
        assert!(describe_exit(Some(10)).contains("launch_failed"));
        assert!(describe_exit(Some(1)).contains("usage"));
    }

    #[test]
    fn errors_read_as_sentences() {
        let e = StartError::Exited {
            code: Some(4),
            stderr: "EADDRINUSE".into(),
        };
        assert_eq!(
            e.to_string(),
            format!("{}:\nEADDRINUSE", describe_exit(Some(4)))
        );
        let e = StartError::NoLink {
            waited: Duration::from_secs(20),
            stderr: String::new(),
        };
        assert_eq!(
            e.to_string(),
            "gnomon dashboard printed no sign-in link within 20 s."
        );
    }
}
