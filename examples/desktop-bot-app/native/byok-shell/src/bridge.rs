//! NDJSON v2 bridge client framing, multiplexing, hello handshake, and graceful Host shutdown.

use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::command::ProcessExitLatch;

/// Host runtime state pushed spontaneously by the Host process over NDJSON.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HostState {
    Starting {
        pid: u32,
    },
    Running {
        pid: u32,
        #[serde(rename = "activeWork")]
        active_work: u64,
    },
    Stopped {
        pid: u32,
        reason: String,
        #[serde(rename = "storeRefused")]
        store_refused: bool,
    },
}

/// Supervisor view of Host state including restart backoff and permanent failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SupervisedHostState {
    Starting {
        pid: u32,
    },
    Running {
        pid: u32,
        #[serde(rename = "activeWork")]
        active_work: u64,
    },
    Stopped {
        pid: u32,
        reason: String,
        #[serde(rename = "storeRefused")]
        store_refused: bool,
    },
    Restarting {
        #[serde(rename = "inMs")]
        in_ms: u64,
        reason: String,
    },
    Failed {
        reason: String,
    },
}

impl From<HostState> for SupervisedHostState {
    fn from(value: HostState) -> Self {
        match value {
            HostState::Starting { pid } => Self::Starting { pid },
            HostState::Running { pid, active_work } => Self::Running { pid, active_work },
            HostState::Stopped {
                pid,
                reason,
                store_refused,
            } => Self::Stopped {
                pid,
                reason,
                store_refused,
            },
        }
    }
}

/// Wire bridge error codes matching `src/bridge/protocol.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeErrorCode {
    BridgeVersionMismatch,
    HelloRequired,
    UnknownMethod,
    InvalidMessage,
    HostExited,
    InvalidParams,
    MethodFailed,
    UnauthorizedMethod,
    Other(String),
}

impl BridgeErrorCode {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "bridge_version_mismatch" => Self::BridgeVersionMismatch,
            "hello_required" => Self::HelloRequired,
            "unknown_method" => Self::UnknownMethod,
            "invalid_message" => Self::InvalidMessage,
            "host_exited" => Self::HostExited,
            "invalid_params" => Self::InvalidParams,
            "method_failed" => Self::MethodFailed,
            "unauthorized_method" => Self::UnauthorizedMethod,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::BridgeVersionMismatch => "bridge_version_mismatch",
            Self::HelloRequired => "hello_required",
            Self::UnknownMethod => "unknown_method",
            Self::InvalidMessage => "invalid_message",
            Self::HostExited => "host_exited",
            Self::InvalidParams => "invalid_params",
            Self::MethodFailed => "method_failed",
            Self::UnauthorizedMethod => "unauthorized_method",
            Self::Other(other) => other.as_str(),
        }
    }
}

/// Error returned for an individual bridge call or fatal wire framing failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: BridgeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for BridgeError {}

/// Failure returned when stopping the Host did not result in an acknowledged exit `0`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopError(pub String);

impl fmt::Display for StopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StopError {}

type PendingMap = Mutex<HashMap<u64, mpsc::Sender<Result<Value, BridgeError>>>>;

struct ClientState {
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingMap,
    closed: Mutex<Option<BridgeError>>,
    shutdown_started: AtomicBool,
    latch: Arc<ProcessExitLatch>,
}

impl ClientState {
    fn fail_all(&self, error: BridgeError) {
        {
            let mut closed_guard = self.closed.lock().expect("closed lock poisoned");
            if closed_guard.is_none() {
                *closed_guard = Some(error.clone());
            }
        }
        let mut pending = self.pending.lock().expect("pending lock poisoned");
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(error.clone()));
        }
        drop(pending);
        let mut stdin = self.stdin.lock().expect("stdin lock poisoned");
        *stdin = None;
    }

    fn current_closed(&self) -> Option<BridgeError> {
        self.closed.lock().expect("closed lock poisoned").clone()
    }
}

/// Multiplexed NDJSON client speaking to one live Host child process.
pub struct BridgeClient {
    shared: Arc<ClientState>,
    next_id: AtomicU64,
}

impl BridgeClient {
    /// Connects to a freshly spawned Host child, performs `hello`, and rejects on version drift.
    pub fn connect<F>(
        child: Child,
        expected_bridge_version: u32,
        on_state: F,
    ) -> Result<Self, BridgeError>
    where
        F: Fn(HostState) + Send + Sync + 'static,
    {
        Self::connect_with_hello_timeout(child, expected_bridge_version, None, on_state)
    }

    /// Connects to a Host child with an optional `hello` handshake deadline.
    pub fn connect_with_hello_timeout<F>(
        mut child: Child,
        expected_bridge_version: u32,
        hello_timeout: Option<Duration>,
        on_state: F,
    ) -> Result<Self, BridgeError>
    where
        F: Fn(HostState) + Send + Sync + 'static,
    {
        let stdin = child.stdin.take().expect("Host child stdin is piped");
        let stdout = child.stdout.take().expect("Host child stdout is piped");
        let latch = ProcessExitLatch::spawn(child);

        let shared = Arc::new(ClientState {
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            closed: Mutex::new(None),
            shutdown_started: AtomicBool::new(false),
            latch: Arc::clone(&latch),
        });

        // Reader thread decodes NDJSON lines until EOF or framing failure.
        let reader_shared = Arc::clone(&shared);
        let _ = thread::Builder::new()
            .name("byok-bridge-reader".to_owned())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => {
                            let exit_code = reader_shared
                                .latch
                                .wait_timeout(Duration::from_secs(2))
                                .flatten();
                            reader_shared.fail_all(BridgeError::new(
                                BridgeErrorCode::HostExited,
                                format!("Host closed stdout (exit code {exit_code:?})"),
                            ));
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if let Err(err) = handle_host_line(trimmed, &reader_shared, &on_state) {
                                reader_shared.fail_all(err);
                                reader_shared
                                    .latch
                                    .force_kill_and_reap(Duration::from_secs(2));
                                break;
                            }
                        }
                        Err(err) => {
                            reader_shared.fail_all(BridgeError::new(
                                BridgeErrorCode::HostExited,
                                format!("Host stdout read failed: {err}"),
                            ));
                            reader_shared
                                .latch
                                .force_kill_and_reap(Duration::from_secs(2));
                            break;
                        }
                    }
                }
            });

        let client = Self {
            shared,
            next_id: AtomicU64::new(1),
        };

        let hello_res = client.call_raw_timeout(
            "hello",
            serde_json::json!({ "bridgeVersion": expected_bridge_version }),
            hello_timeout,
        );
        match hello_res {
            Ok(value) => {
                let actual = value
                    .get("bridgeVersion")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok());
                if actual != Some(expected_bridge_version) {
                    client.kill();
                    return Err(BridgeError::new(
                        BridgeErrorCode::BridgeVersionMismatch,
                        format!(
                            "Host bridge version {actual:?} differs from shell version {expected_bridge_version}"
                        ),
                    ));
                }
                Ok(client)
            }
            Err(err) => {
                client.kill();
                Err(err)
            }
        }
    }

    /// Sends one NDJSON request and blocks until its response id returns or the pipe fails.
    pub fn call_raw(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        self.call_raw_timeout(method, params, None)
    }

    pub(crate) fn call_raw_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, BridgeError> {
        if let Some(closed) = self.shared.current_closed() {
            return Err(closed);
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.shared.pending.lock().expect("pending lock poisoned");
            if let Some(closed) = self.shared.current_closed() {
                return Err(closed);
            }
            pending.insert(id, tx);
        }

        let wire = if params.is_null() {
            serde_json::json!({ "id": id, "method": method })
        } else {
            serde_json::json!({ "id": id, "method": method, "params": params })
        };
        let encoded = match serde_json::to_string(&wire) {
            Ok(s) => format!("{s}\n"),
            Err(err) => {
                self.shared.pending.lock().expect("pending lock poisoned").remove(&id);
                return Err(BridgeError::new(BridgeErrorCode::InvalidParams, err.to_string()));
            }
        };

        let write_result = {
            let mut guard = self.shared.stdin.lock().expect("stdin lock poisoned");
            match guard.as_mut() {
                Some(stdin) => stdin
                    .write_all(encoded.as_bytes())
                    .and_then(|_| stdin.flush()),
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "Host stdin is closed",
                )),
            }
        };

        if let Err(err) = write_result {
            self.shared.pending.lock().expect("pending lock poisoned").remove(&id);
            let failure = BridgeError::new(
                BridgeErrorCode::HostExited,
                format!("Host pipe failed: {err}"),
            );
            self.shared.fail_all(failure.clone());
            return Err(failure);
        }

        match timeout {
            Some(limit) => match rx.recv_timeout(limit) {
                Ok(res) => res,
                Err(_) => {
                    self.shared.pending.lock().expect("pending lock poisoned").remove(&id);
                    Err(BridgeError::new(
                        BridgeErrorCode::HostExited,
                        format!("Bridge call `{method}` timed out after {} ms", limit.as_millis()),
                    ))
                }
            },
            None => rx.recv().unwrap_or_else(|_| {
                Err(BridgeError::new(
                    BridgeErrorCode::HostExited,
                    "Bridge response channel closed",
                ))
            }),
        }
    }

    /// Returns whether the child has already exited and its OS exit code if known.
    pub fn exit_code(&self) -> Option<Option<i32>> {
        self.shared.latch.exit_code_if_finished()
    }

    /// Waits up to `timeout` for the child to exit.
    pub fn wait_exit(&self, timeout: Duration) -> Option<Option<i32>> {
        self.shared.latch.wait_timeout(timeout)
    }

    /// Requests an acknowledged `shutdown` RPC and requires the child to exit `0` within `grace`.
    pub fn shutdown_and_wait(&self, grace: Duration) -> Result<(), StopError> {
        let deadline = Instant::now() + grace;
        self.shared.shutdown_started.store(true, Ordering::Release);

        let rpc_res = self.call_raw_timeout("shutdown", Value::Null, Some(grace));
        if let Err(err) = rpc_res {
            self.shared.latch.terminate_gracefully(Duration::from_secs(2));
            return Err(StopError(format!("Host shutdown RPC failed: {err}")));
        }

        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        match self.shared.latch.wait_timeout(remaining) {
            Some(Some(0)) => Ok(()),
            Some(code) => {
                Err(StopError(format!("Host exited with code {code:?} after shutdown")))
            }
            None => {
                self.shared.latch.terminate_gracefully(Duration::from_secs(2));
                Err(StopError(format!(
                    "Host did not shut down within {} ms",
                    grace.as_millis()
                )))
            }
        }
    }

    /// Forcefully terminates the child process.
    pub fn kill(&self) {
        self.shared.latch.force_kill_and_reap(Duration::from_secs(2));
        self.shared.fail_all(BridgeError::new(
            BridgeErrorCode::HostExited,
            "Host killed by shell",
        ));
    }
}

fn handle_host_line<F>(
    line: &str,
    shared: &Arc<ClientState>,
    on_state: &F,
) -> Result<(), BridgeError>
where
    F: Fn(HostState),
{
    let value: Value = serde_json::from_str(line)
        .map_err(|_| BridgeError::new(BridgeErrorCode::InvalidMessage, "Bridge line is not JSON"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| BridgeError::new(BridgeErrorCode::InvalidMessage, "Bridge line is not an object"))?;

    if let Some(event) = obj.get("event") {
        if event.as_str() != Some("state") {
            return Err(BridgeError::new(
                BridgeErrorCode::InvalidMessage,
                "Bridge event is not a Host state",
            ));
        }
        let state_val = obj
            .get("state")
            .ok_or_else(|| BridgeError::new(BridgeErrorCode::InvalidMessage, "Missing state payload"))?;
        let state: HostState = serde_json::from_value(state_val.clone()).map_err(|err| {
            BridgeError::new(
                BridgeErrorCode::InvalidMessage,
                format!("Invalid Host state event: {err}"),
            )
        })?;
        on_state(state);
        return Ok(());
    }

    let id = obj
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::InvalidMessage,
                "Bridge message has no integer id",
            )
        })?;

    if id == 0 {
        let detail = obj
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Host reported fatal bridge frame error (id 0)");
        let code = obj
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .map(BridgeErrorCode::parse)
            .unwrap_or(BridgeErrorCode::InvalidMessage);
        return Err(BridgeError::new(code, detail));
    }

    let sender = {
        let mut pending = shared.pending.lock().expect("pending lock poisoned");
        pending.remove(&id)
    }
    .ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::InvalidMessage,
            format!("Bridge reply {id} has no matching request"),
        )
    })?;

    if let Some(err_obj) = obj.get("error") {
        let code = err_obj
            .get("code")
            .and_then(Value::as_str)
            .map(BridgeErrorCode::parse)
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::InvalidMessage,
                    "Bridge error reply missing code",
                )
            })?;
        let message = err_obj
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Bridge error")
            .to_owned();
        let _ = sender.send(Err(BridgeError::new(code, message)));
    } else {
        let result = obj.get("result").cloned().unwrap_or(Value::Null);
        let _ = sender.send(Ok(result));
    }
    Ok(())
}
