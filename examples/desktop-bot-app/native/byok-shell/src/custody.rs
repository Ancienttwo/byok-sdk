//! Custody one-shot stdin pipeline: secret redaction, Rust-buffer zeroing, submit timeout lock preservation, and list kill semantics.

use std::fmt;
use std::io::Write;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::bridge::BridgeErrorCode;
use crate::command::{CommandError, HostCommandSpec, run_host_command, run_host_command_with_stdin};
use crate::host::HostSupervisor;
use crate::maintenance::MaintenanceLock;

/// Default deadline waiting on a custody subprocess (`30s`).
pub const DEFAULT_CUSTODY_DEADLINE: Duration = Duration::from_secs(30);

/// Rust-owned byte buffer carrying a secret-bearing JSON payload to custody stdin.
///
/// Automatically zeroized on drop and redacted in `Debug` output. QuickJS heap strings
/// created prior to FFI entry are not zeroizable from Rust and remain outside this guarantee.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    /// Wraps raw UTF-8/bytes in a `Zeroizing` buffer.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Wraps UTF-8 text in a `Zeroizing` buffer.
    pub fn from_string(mut raw: String) -> Self {
        let bytes = Zeroizing::new(std::mem::take(&mut raw).into_bytes());
        Self(bytes)
    }

    /// Returns a read-only view for single-shot stdin transmission.
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes([REDACTED])")
    }
}

/// Secret-free failure returned by custody operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyError {
    pub code: String,
    pub message: String,
}

impl CustodyError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for CustodyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CustodyError {}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CustodyWireReceipt {
    SubmitOk {
        ok: bool,
        status: Value,
    },
    ListOk {
        ok: bool,
        statuses: Vec<Value>,
    },
    Refusal {
        ok: bool,
        code: String,
        message: String,
    },
}

fn validate_submit_payload_is_not_list(bytes: &[u8]) -> Result<(), CustodyError> {
    if let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(bytes)
        && obj.get("op").and_then(Value::as_str) == Some("list")
    {
        return Err(CustodyError::new(
            "invalid_params",
            "keys.submit takes configure or replace_secret; keys.list lists",
        ));
    }
    Ok(())
}

fn refresh_profiles(supervisor: Option<&HostSupervisor>, saved: bool) -> Result<(), CustodyError> {
    let Some(supervisor) = supervisor else {
        return Ok(());
    };
    match supervisor.call_shell_to_host("keys.profilesChanged", Value::Null) {
        Ok(_) => Ok(()),
        Err(err)
            if matches!(
                err.code,
                BridgeErrorCode::HostExited | BridgeErrorCode::UnknownMethod
            ) =>
        {
            Ok(())
        }
        Err(err) => Err(CustodyError::new(
            "catalog_refresh_failed",
            format!(
                "{} (refresh failed: {})",
                if saved {
                    "The key change was saved"
                } else {
                    "Stored providers were read"
                },
                err.message
            ),
        )),
    }
}

fn parse_refusal_or_invalid(receipt: Value, code: Option<i32>, label: &str) -> Result<CustodyWireReceipt, CustodyError> {
    let parsed: CustodyWireReceipt = serde_json::from_value(receipt).map_err(|err| {
        CustodyError::new(
            "custody_failed",
            format!("Custody child returned unexpected {label} receipt schema: {err}"),
        )
    })?;
    match parsed {
        CustodyWireReceipt::Refusal {
            ok: false,
            code,
            message,
        } => Err(CustodyError::new(code, message)),
        CustodyWireReceipt::Refusal { ok: true, .. } => Err(CustodyError::new(
            "custody_failed",
            "Custody receipt claimed ok=true without payload",
        )),
        other => {
            if code != Some(0) {
                return Err(CustodyError::new(
                    "custody_exited",
                    format!("Custody child exited with code {code:?} after a receipt"),
                ));
            }
            Ok(other)
        }
    }
}

/// Executes `keys.submit` through a disposable custody child, zeroizing `payload` on drop/return
/// and NEVER killing the child on timeout so in-flight OS keychain / SQLite configuration locks stay intact.
pub fn submit_to_custody(
    command: &HostCommandSpec,
    custody_subcommand: &str,
    payload: SecretBytes,
    deadline: Duration,
    maintenance_lock: Option<&MaintenanceLock>,
    supervisor: Option<&HostSupervisor>,
) -> Result<Value, CustodyError> {
    if maintenance_lock.is_some_and(MaintenanceLock::is_busy) {
        return Err(CustodyError::new(
            "PROVIDER_CONFIGURATION_BUSY",
            "Cannot change provider keys while an app update or recovery action is running",
        ));
    }

    validate_submit_payload_is_not_list(payload.as_bytes())?;

    let outcome = run_host_command_with_stdin(
        command,
        &[custody_subcommand],
        move |stdin| {
            // Write and immediately drop (zeroize) the secret buffer before blocking up to `deadline`.
            let write_res = stdin.write_all(payload.as_bytes()).and_then(|_| stdin.flush());
            drop(payload);
            write_res
        },
        Some(deadline),
        false,
    );

    let outcome = match outcome {
        Ok(ok) => ok,
        Err(CommandError::Timeout { .. }) => {
            return Err(CustodyError::new(
                "custody_timeout",
                format!(
                    "Key storage did not answer within {} seconds and is still working, perhaps waiting for a system unlock prompt; the change may still be saved, so reload stored providers before trying again.",
                    deadline.as_secs()
                ),
            ));
        }
        Err(CommandError::Spawn(msg)) | Err(CommandError::WriteStdin(msg)) | Err(CommandError::InvalidReceipt(msg)) => {
            return Err(CustodyError::new("custody_exited", msg));
        }
        Err(CommandError::InconsistentExit { code }) => {
            return Err(CustodyError::new(
                "custody_exited",
                format!("Custody child exited with code {code:?} after writing a receipt"),
            ));
        }
    };

    match parse_refusal_or_invalid(outcome.receipt, outcome.exit_code, "submit")? {
        CustodyWireReceipt::SubmitOk { ok: true, status } => {
            refresh_profiles(supervisor, true)?;
            Ok(status)
        }
        CustodyWireReceipt::SubmitOk { ok: false, .. } => Err(CustodyError::new(
            "custody_failed",
            "Custody submit receipt marked ok=false without error code",
        )),
        CustodyWireReceipt::ListOk { .. } => Err(CustodyError::new(
            "custody_failed",
            "Custody child answered a change with a list",
        )),
        CustodyWireReceipt::Refusal { .. } => unreachable!(),
    }
}

/// Lists stored provider statuses via custody child, terminating on timeout (`kill_on_timeout = true`).
pub fn list_from_custody(
    command: &HostCommandSpec,
    custody_subcommand: &str,
    deadline: Duration,
    supervisor: Option<&HostSupervisor>,
) -> Result<Vec<Value>, CustodyError> {
    let outcome = run_host_command(
        command,
        &[custody_subcommand],
        br#"{"op":"list"}"#,
        Some(deadline),
        true,
    )
    .map_err(|err| match err {
        CommandError::Timeout { .. } => CustodyError::new(
            "custody_timeout",
            format!(
                "Key storage did not list stored providers within {} seconds, perhaps waiting for a system unlock prompt. Nothing was changed; answer any prompt, then reload stored providers.",
                deadline.as_secs()
            ),
        ),
        other => CustodyError::new("custody_exited", other.to_string()),
    })?;

    match parse_refusal_or_invalid(outcome.receipt, outcome.exit_code, "list")? {
        CustodyWireReceipt::ListOk { ok: true, statuses } => {
            refresh_profiles(supervisor, false)?;
            Ok(statuses)
        }
        CustodyWireReceipt::ListOk { ok: false, .. } => Err(CustodyError::new(
            "custody_failed",
            "Custody list receipt marked ok=false without error code",
        )),
        CustodyWireReceipt::SubmitOk { .. } => Err(CustodyError::new(
            "custody_failed",
            "Custody child answered a list with a change",
        )),
        CustodyWireReceipt::Refusal { .. } => unreachable!(),
    }
}
