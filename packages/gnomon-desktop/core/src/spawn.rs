//! Starting gnomon children so that they can be stopped whole.
//!
//! A `gnomon` is rarely one process: npm's Windows shim is `cmd.exe` running
//! `node`, and a source checkout's launcher may start `tsx`, which starts node
//! again. Killing the direct child alone would leave the server running. So:
//!
//! - **Unix**: each child leads its own process group (`setpgid(0, 0)`), and
//!   stopping signals the group: SIGTERM, which `gnomon dashboard` handles as
//!   a clean stop, then SIGKILL if it is still there.
//! - **Windows**: each child is put in a Job Object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the whole tree ends when the job
//!   is terminated, and also when this app exits by any route, a crash
//!   included, because the OS closes the job's last handle.
//!
//! No console window is opened for a child on Windows.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Make `cmd` start a child that can be stopped as a tree, and that opens no
/// console window.
pub fn prepare(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Wait for `child` up to `limit`. `Some(status)` once it has exited.
pub fn wait_for(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let until = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Some(st),
            Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

/// Signal a child's process group (Unix). Ignores a group that is gone.
#[cfg(unix)]
pub fn signal_group(child: &Child, signal: i32) {
    let pgid = child.id() as libc::pid_t;
    if pgid > 0 {
        // SAFETY: killpg only sends a signal; a stale group is ESRCH.
        unsafe {
            libc::killpg(pgid, signal);
        }
    }
}

/// Stop a child started with [`prepare`] and everything it started. Returns
/// once the child has been reaped.
pub fn stop_tree(child: &mut Child, job: Option<&Job>, grace: Duration) {
    #[cfg(unix)]
    {
        let _ = job;
        signal_group(child, libc::SIGTERM);
        if wait_for(child, grace).is_none() {
            signal_group(child, libc::SIGKILL);
            let _ = child.wait();
        } else {
            // The leader is gone; anything it left in the group goes too.
            signal_group(child, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        // No SIGTERM on Windows. `gnomon dashboard` writes nothing, so ending
        // it hard loses nothing.
        let _ = grace;
        match job {
            Some(j) => j.terminate(),
            None => {
                let _ = child.kill();
            }
        }
        let _ = child.wait();
    }
}

/// A Windows Job Object that ends every process in it when it is terminated
/// or dropped. Elsewhere, an empty stand-in.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: a job handle is a kernel handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

impl Job {
    /// Put `child` in a new kill-on-close job.
    ///
    /// The child is assigned right after it starts. `cmd.exe` takes several
    /// milliseconds to read npm's shim before it starts node, so node is
    /// created inside the job; a process started in that window would escape
    /// it, which is why stopping also falls back to killing the child itself.
    #[cfg(windows)]
    pub fn for_child(child: &Child) -> std::io::Result<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls on a handle this function owns; the
        // struct is zero-initialised as the API expects.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job { handle };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    #[cfg(not(windows))]
    pub fn for_child(_child: &Child) -> std::io::Result<Job> {
        Ok(Job {})
    }

    /// End every process in the job now.
    pub fn terminate(&self) {
        #[cfg(windows)]
        // SAFETY: the handle is live until drop.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: closing the last handle ends the job's processes
        // (KILL_ON_JOB_CLOSE), which is the point.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

/// The last lines a stream printed, for an error message.
#[derive(Debug, Default)]
pub struct Tail {
    lines: std::collections::VecDeque<String>,
    cap: usize,
}

impl Tail {
    pub fn new(cap: usize) -> Self {
        Tail {
            lines: Default::default(),
            cap,
        }
    }
    pub fn push(&mut self, line: String) {
        if self.lines.len() == self.cap {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
    pub fn text(&self) -> String {
        self.lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Read `r` line by line, lossily as UTF-8, without the line ending, until it
/// closes. Every line goes to `each`.
pub fn for_each_line(r: impl Read, mut each: impl FnMut(String)) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let s = String::from_utf8_lossy(&buf);
                each(s.trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
}

/// What a short-lived child printed.
#[derive(Debug)]
pub struct Captured {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

const CAPTURE_CAP: usize = 1 << 20;

fn read_capped(r: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut out = String::new();
        for_each_line(r, |l| {
            if out.len() < CAPTURE_CAP {
                out.push_str(&l);
                out.push('\n');
            }
        });
        let _ = tx.send(out);
    });
    rx
}

/// Run a short command to completion (or `timeout`), capturing its output.
/// `cmd` should already be [`prepare`]d.
pub fn capture(mut cmd: Command, timeout: Duration) -> std::io::Result<Captured> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let job = Job::for_child(&child).ok();
    let out = read_capped(child.stdout.take().expect("piped"));
    let err = read_capped(child.stderr.take().expect("piped"));
    let status = wait_for(&mut child, timeout);
    let timed_out = status.is_none();
    if timed_out {
        stop_tree(&mut child, job.as_ref(), Duration::from_millis(500));
    }
    // A grandchild that kept the pipes open must not hang the caller.
    let grace = Duration::from_secs(2);
    Ok(Captured {
        status: status.and_then(|s| s.code()),
        stdout: out.recv_timeout(grace).unwrap_or_default(),
        stderr: err.recv_timeout(grace).unwrap_or_default(),
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_lines() {
        let mut t = Tail::new(2);
        for l in ["a", "b", "c"] {
            t.push(l.into());
        }
        assert_eq!(t.text(), "b\nc");
    }

    #[test]
    fn lines_lose_their_endings_and_survive_bad_utf8() {
        let mut got = Vec::new();
        for_each_line(&b"one\r\ntwo\n\xff\xfe three"[..], |l| got.push(l));
        assert_eq!(got[0], "one");
        assert_eq!(got[1], "two");
        assert!(got[2].ends_with(" three"));
    }

    #[cfg(unix)]
    #[test]
    fn capture_times_out_and_stops_the_whole_group() {
        let _serial = crate::test_serial();
        let t = tempfile::tempdir().unwrap();
        let marker = t.path().join("grandchild.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", marker.display()));
        prepare(&mut cmd);
        let started = Instant::now();
        let c = capture(cmd, Duration::from_millis(300)).unwrap();
        assert!(c.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // The grandchild got the group's SIGTERM.
        let mut gone = false;
        for _ in 0..100 {
            // SAFETY: signal 0 only probes for existence.
            if unsafe { libc::kill(pid, 0) } != 0 {
                gone = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "grandchild {pid} outlived the stop");
    }

    #[cfg(windows)]
    #[test]
    fn capture_times_out_and_stops_the_whole_job() {
        let _serial = crate::test_serial();
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
        prepare(&mut cmd);
        let started = Instant::now();
        let c = capture(cmd, Duration::from_millis(500)).unwrap();
        assert!(c.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn capture_reads_both_streams() {
        let _serial = crate::test_serial();
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c", "echo out& echo err 1>&2& exit /b 3"]);
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "echo out; echo err >&2; exit 3"]);
            c
        };
        prepare(&mut cmd);
        let c = capture(cmd, Duration::from_secs(10)).unwrap();
        assert!(!c.timed_out);
        assert_eq!(c.status, Some(3));
        assert_eq!(c.stdout.trim(), "out");
        assert_eq!(c.stderr.trim(), "err");
    }
}
