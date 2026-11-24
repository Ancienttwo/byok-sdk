//! One-shot Host command runner (S1 recovery & custody child subprocesses) and shared spawn primitives.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::env::filtered_host_env;

/// Specification describing how to invoke the Host executable (dev `node host.cjs` or packaged SEA binary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCommandSpec {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
    pub extra_env: Vec<(String, String)>,
}

impl HostCommandSpec {
    /// Targets the dev CJS Host bundle (`examples/desktop-bot-app/dist/host/host.cjs`) under `node`.
    pub fn dev_node_host(bundle_path: impl Into<PathBuf>) -> Self {
        Self {
            program: PathBuf::from("node"),
            prefix_args: vec![bundle_path.into().to_string_lossy().into_owned()],
            extra_env: Vec::new(),
        }
    }

    /// Targets a compiled standalone packaged SEA Host executable (`resources/host/host[.exe]`).
    pub fn packaged_host(executable: impl Into<PathBuf>) -> Self {
        Self {
            program: executable.into(),
            prefix_args: Vec::new(),
            extra_env: Vec::new(),
        }
    }

    /// Appends or overrides one environment variable for child invocations.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }

    /// Builds a sanitized `std::process::Command` with piped stdin/stdout and `CREATE_NO_WINDOW` on Windows.
    pub fn build_command(&self, args: &[&str]) -> Command {
        let mut env_pairs = filtered_host_env();
        for (extra_key, extra_val) in &self.extra_env {
            env_pairs.retain(|(existing, _)| !existing.eq_ignore_ascii_case(extra_key));
            env_pairs.push((extra_key.clone(), extra_val.clone()));
        }

        let mut cmd = Command::new(&self.program);
        cmd.args(&self.prefix_args);
        cmd.args(args);
        cmd.env_clear();
        for (key, value) in env_pairs {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::inherit());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd
    }
}

/// Spawns a sanitized Host child process with piped stdin/stdout.
pub fn spawn_host_child(spec: &HostCommandSpec, args: &[&str]) -> std::io::Result<Child> {
    spec.build_command(args).spawn()
}

/// Cross-platform handle allowing safe out-of-band termination while a reaper thread owns `Child::wait()`.
pub(crate) struct ProcessKillHandle {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    handle: isize,
}

#[cfg(windows)]
unsafe impl Send for ProcessKillHandle {}
#[cfg(windows)]
unsafe impl Sync for ProcessKillHandle {}

impl ProcessKillHandle {
    pub fn from_child(child: &Child) -> Option<Self> {
        #[cfg(unix)]
        {
            Some(Self { pid: child.id() })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle};
            use windows_sys::Win32::System::Threading::GetCurrentProcess;
            let mut duplicated = std::ptr::null_mut();
            // SAFETY: Duplicating the valid Child handle in our own process avoids PID reuse races on Windows.
            let ok = unsafe {
                let current = GetCurrentProcess();
                DuplicateHandle(
                    current,
                    child.as_raw_handle() as _,
                    current,
                    &mut duplicated,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if ok == 0 || duplicated.is_null() {
                return None;
            }
            Some(Self {
                handle: duplicated as isize,
            })
        }
    }

    #[cfg(unix)]
    pub fn send_sigterm(&self) {
        // SAFETY: self.pid belongs to an un-reaped Child until WaitState marks exited.
        unsafe {
            let _ = libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
        }
    }

    pub fn kill_force(&self) {
        #[cfg(unix)]
        // SAFETY: self.pid belongs to an un-reaped Child until WaitState marks exited.
        unsafe {
            let _ = libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        // SAFETY: self.handle is a duplicated kernel process handle closed only on Drop.
        unsafe {
            let _ = windows_sys::Win32::System::Threading::TerminateProcess(
                self.handle as _,
                1,
            );
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessKillHandle {
    fn drop(&mut self) {
        // SAFETY: self.handle was created via DuplicateHandle and is closed once here.
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

/// Shared process wait slot driven by one dedicated OS reaper thread.
pub(crate) struct ProcessExitLatch {
    state: Mutex<Option<ExitStatus>>,
    cv: Condvar,
    kill: Option<ProcessKillHandle>,
}

impl ProcessExitLatch {
    pub fn spawn(mut child: Child) -> Arc<Self> {
        let kill = ProcessKillHandle::from_child(&child);
        let latch = Arc::new(Self {
            state: Mutex::new(None),
            cv: Condvar::new(),
            kill,
        });
        let waiter = Arc::clone(&latch);
        let _ = thread::Builder::new()
            .name("byok-child-reaper".to_owned())
            .spawn(move || {
                let status = child.wait().ok();
                let mut guard = waiter.state.lock().expect("reaper lock poisoned");
                if let Some(code) = status {
                    *guard = Some(code);
                }
                waiter.cv.notify_all();
            });
        latch
    }

    pub fn exit_code_if_finished(&self) -> Option<Option<i32>> {
        let guard = self.state.lock().expect("reaper lock poisoned");
        (*guard).map(|status| status.code())
    }

    pub fn wait_timeout(&self, timeout: Duration) -> Option<Option<i32>> {
        let mut guard = self.state.lock().expect("reaper lock poisoned");
        let deadline = std::time::Instant::now() + timeout;
        while guard.is_none() {
            let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
                return None;
            };
            let (next, timed) = self
                .cv
                .wait_timeout(guard, remaining)
                .expect("reaper lock poisoned");
            guard = next;
            if timed.timed_out() && guard.is_none() {
                return None;
            }
        }
        (*guard).map(|status| status.code())
    }

    /// Gracefully terminates (`SIGTERM` + wait on Unix, immediate kill on Windows) then escalates to hard kill.
    pub fn terminate_gracefully(&self, sigterm_grace: Duration) {
        {
            let guard = self.state.lock().expect("reaper lock poisoned");
            if guard.is_some() {
                return;
            }
            if let Some(handle) = &self.kill {
                #[cfg(unix)]
                {
                    handle.send_sigterm();
                }
                #[cfg(not(unix))]
                {
                    handle.kill_force();
                }
            }
        }
        #[cfg(unix)]
        if self.wait_timeout(sigterm_grace).is_some() {
            return;
        }
        let _ = sigterm_grace;
        self.force_kill_and_reap(Duration::from_secs(2));
    }

    pub fn force_kill_and_reap(&self, wait: Duration) {
        {
            let guard = self.state.lock().expect("reaper lock poisoned");
            if guard.is_some() {
                return;
            }
            if let Some(handle) = &self.kill {
                handle.kill_force();
            }
        }
        let _ = self.wait_timeout(wait);
    }
}

/// Successful parsed outcome of one re-entered Host command invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    pub receipt: Value,
    pub exit_code: Option<i32>,
}

/// Failure modes returned by [`run_host_command`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    Spawn(String),
    WriteStdin(String),
    Timeout { killed: bool },
    InvalidReceipt(String),
    InconsistentExit { code: Option<i32> },
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(err) => write!(f, "failed to spawn Host command: {err}"),
            Self::WriteStdin(err) => write!(f, "failed to write Host command stdin: {err}"),
            Self::Timeout { killed } => write!(
                f,
                "Host command timed out (process {})",
                if *killed { "terminated" } else { "left running in background" }
            ),
            Self::InvalidReceipt(msg) => write!(f, "Host command produced no valid receipt: {msg}"),
            Self::InconsistentExit { code } => {
                write!(f, "Host command exited with code {code:?} after writing ok receipt")
            }
        }
    }
}

impl std::error::Error for CommandError {}

fn parse_receipt_line(raw: &[u8]) -> Result<Value, CommandError> {
    let text = String::from_utf8(raw.to_vec())
        .map_err(|err| CommandError::InvalidReceipt(format!("stdout is not UTF-8: {err}")))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(CommandError::InvalidReceipt("empty stdout".to_owned()));
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|err| CommandError::InvalidReceipt(format!("malformed receipt JSON: {err}")))?;
    let Some(obj) = value.as_object() else {
        return Err(CommandError::InvalidReceipt("receipt must be a JSON object".to_owned()));
    };
    if !matches!(obj.get("ok"), Some(Value::Bool(_))) {
        return Err(CommandError::InvalidReceipt("receipt missing boolean `ok`".to_owned()));
    }
    Ok(value)
}

/// Runs a one-shot re-entered Host command, writes `stdin_bytes` once, and parses one JSON receipt.
///
/// When `kill_on_timeout` is `false` and `deadline` expires, the child is NOT killed and a dedicated
/// background reaper thread drains its stdout to EOF before calling `Child::wait()` so the child
/// never hits `EPIPE` on delayed receipt writes or lingers as a zombie.
pub fn run_host_command(
    spec: &HostCommandSpec,
    args: &[&str],
    stdin_bytes: &[u8],
    deadline: Option<Duration>,
    kill_on_timeout: bool,
) -> Result<CommandOutcome, CommandError> {
    run_host_command_with_stdin(
        spec,
        args,
        |stdin| {
            if stdin_bytes.is_empty() {
                Ok(())
            } else {
                stdin.write_all(stdin_bytes).and_then(|_| stdin.flush())
            }
        },
        deadline,
        kill_on_timeout,
    )
}

pub(crate) fn run_host_command_with_stdin<F>(
    spec: &HostCommandSpec,
    args: &[&str],
    write_stdin: F,
    deadline: Option<Duration>,
    kill_on_timeout: bool,
) -> Result<CommandOutcome, CommandError>
where
    F: FnOnce(&mut std::process::ChildStdin) -> std::io::Result<()>,
{
    let mut child = spawn_host_child(spec, args).map_err(|err| CommandError::Spawn(err.to_string()))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = child.stdout.take().expect("stdout is piped");

    let write_res = write_stdin(&mut stdin);
    drop(stdin);

    let latch = ProcessExitLatch::spawn(child);
    let latch_waiter = Arc::clone(&latch);
    let (tx, rx) = mpsc::channel::<Result<(Vec<u8>, Option<i32>), String>>();

    let _ = thread::Builder::new()
        .name("byok-cmd-drain".to_owned())
        .spawn(move || {
            let mut buf = Vec::new();
            let read_res = stdout.read_to_end(&mut buf);
            drop(stdout);
            // Block indefinitely in background so timed-out custody writers are always reaped cleanly.
            let code = loop {
                if let Some(exit) = latch_waiter.wait_timeout(Duration::from_secs(3600)) {
                    break exit;
                }
            };
            let payload = read_res
                .map(|_| (buf, code))
                .map_err(|err| err.to_string());
            let _ = tx.send(payload);
        });

    if let Err(ref err) = write_res
        && err.kind() != ErrorKind::BrokenPipe
    {
        if kill_on_timeout {
            latch.force_kill_and_reap(Duration::from_secs(2));
        }
        return Err(CommandError::WriteStdin(err.to_string()));
    }

    let waited = match deadline {
        Some(limit) => rx.recv_timeout(limit),
        None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    };

    match waited {
        Ok(Ok((bytes, exit_code))) => {
            if let Err(err) = write_res {
                // BrokenPipe: if the child still emitted an explicit JSON refusal receipt, surface it!
                if let Ok(receipt) = parse_receipt_line(&bytes) {
                    if receipt["ok"].as_bool() == Some(true) && exit_code != Some(0) {
                        return Err(CommandError::InconsistentExit { code: exit_code });
                    }
                    return Ok(CommandOutcome { receipt, exit_code });
                }
                return Err(CommandError::WriteStdin(err.to_string()));
            }
            let receipt = parse_receipt_line(&bytes)?;
            if receipt["ok"].as_bool() == Some(true) && exit_code != Some(0) {
                return Err(CommandError::InconsistentExit { code: exit_code });
            }
            Ok(CommandOutcome { receipt, exit_code })
        }
        Ok(Err(read_err)) => Err(CommandError::InvalidReceipt(read_err)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if kill_on_timeout {
                latch.force_kill_and_reap(Duration::from_secs(2));
                Err(CommandError::Timeout { killed: true })
            } else {
                Err(CommandError::Timeout { killed: false })
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CommandError::InvalidReceipt(
            "command stdout reader disconnected unexpectedly".to_owned(),
        )),
    }
}
