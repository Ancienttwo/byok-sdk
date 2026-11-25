//! S1 recovery orchestration and strict receipt parsing (`snapshot`, `snapshot-status`, `restore`, `start-fresh`).

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bridge::{HostState, SupervisedHostState};
use crate::command::{CommandError, HostCommandSpec, run_host_command};
use crate::contract::HostCommands;
use crate::host::HostSupervisor;
use crate::maintenance::{MaintenanceBusyError, MaintenanceLock};

/// A single moved directory record emitted by `byok-desktop-start-fresh`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MovedEntry {
    pub from: String,
    pub to: String,
}

/// Complete snapshot descriptor returned by `byok-desktop-snapshot-status`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotInfo {
    pub version: String,
    pub target: String,
}

/// Result returned by `shell.state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellView {
    pub host: Option<SupervisedHostState>,
    pub restore: Option<SnapshotVersionView>,
    pub restore_error: Option<String>,
}

/// Minimal snapshot offer version returned inside `ShellView`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnapshotVersionView {
    pub version: String,
}

/// Result returned by `shell.restore`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSuccess {
    pub aside_path: String,
}

/// Result returned by `shell.startFresh`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartFreshSuccess {
    pub moved: Vec<MovedEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireErr {
    ok: bool,
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveBackErr {
    ok: bool,
    code: String,
    message: String,
    moved_back: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotOk {
    ok: bool,
    target: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotStatusOk {
    ok: bool,
    snapshot: Option<SnapshotInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreOk {
    ok: bool,
    aside_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartFreshOk {
    ok: bool,
    moved: Vec<MovedEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SnapshotWireReceipt {
    Ok(SnapshotOk),
    Err(WireErr),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SnapshotStatusWireReceipt {
    Ok(SnapshotStatusOk),
    Err(WireErr),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RestoreWireReceipt {
    Ok(RestoreOk),
    Err(MoveBackErr),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StartFreshWireReceipt {
    Ok(StartFreshOk),
    Err(MoveBackErr),
}

/// Error raised by S1 recovery orchestration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryError {
    pub code: String,
    pub message: String,
}

impl RecoveryError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<MaintenanceBusyError> for RecoveryError {
    fn from(err: MaintenanceBusyError) -> Self {
        Self::new(err.code(), err.to_string())
    }
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RecoveryError {}

fn run_receipt(
    command: &HostCommandSpec,
    args: &[&str],
    deadline: Option<Duration>,
    kill_on_timeout: bool,
    what: &str,
) -> Result<(Value, Option<i32>), RecoveryError> {
    let outcome = run_host_command(command, args, b"", deadline, kill_on_timeout).map_err(|err| match err {
        CommandError::InvalidReceipt(detail) => {
            RecoveryError::new("invalid_receipt", format!("{what} did not report: {detail}"))
        }
        other => RecoveryError::new("command_failed", format!("{what} failed: {other}")),
    })?;
    Ok((outcome.receipt, outcome.exit_code))
}

/// Runs S1 `byok-desktop-snapshot` (`snapshotStores`) after callers confirmed the Host is stopped.
/// Never kills mid-mutation so copy/atomic publish completes without leaving partial state.
pub fn run_snapshot(
    command: &HostCommandSpec,
    commands: &HostCommands,
    version: &str,
) -> Result<String, RecoveryError> {
    let (receipt, exit_code) = run_receipt(
        command,
        &[commands.snapshot.as_str(), version],
        None,
        false,
        "Snapshot",
    )?;
    let parsed: SnapshotWireReceipt = serde_json::from_value(receipt).map_err(|err| {
        RecoveryError::new("invalid_receipt", format!("Snapshot receipt malformed: {err}"))
    })?;
    match parsed {
        SnapshotWireReceipt::Ok(SnapshotOk { ok: true, target }) => {
            if exit_code != Some(0) {
                return Err(RecoveryError::new(
                    "invalid_exit",
                    format!("Snapshot exited with code {exit_code:?} after writing receipt"),
                ));
            }
            Ok(target)
        }
        SnapshotWireReceipt::Err(WireErr {
            ok: false,
            code,
            message,
        }) => Err(RecoveryError::new(code, message)),
        _ => Err(RecoveryError::new(
            "invalid_receipt",
            "Snapshot receipt ok flag disagreed with fields",
        )),
    }
}

/// Queries S1 `byok-desktop-snapshot-status` for `version`.
pub fn run_snapshot_status(
    command: &HostCommandSpec,
    commands: &HostCommands,
    version: &str,
    deadline: Option<Duration>,
) -> Result<Option<SnapshotInfo>, RecoveryError> {
    let (receipt, exit_code) = run_receipt(
        command,
        &[commands.snapshot_status.as_str(), version],
        deadline,
        true,
        "Snapshot status",
    )?;
    let parsed: SnapshotStatusWireReceipt = serde_json::from_value(receipt).map_err(|err| {
        RecoveryError::new(
            "invalid_receipt",
            format!("Snapshot status receipt malformed: {err}"),
        )
    })?;
    match parsed {
        SnapshotStatusWireReceipt::Ok(SnapshotStatusOk { ok: true, snapshot }) => {
            if exit_code != Some(0) {
                return Err(RecoveryError::new(
                    "invalid_exit",
                    format!("Snapshot status exited with code {exit_code:?}"),
                ));
            }
            Ok(snapshot)
        }
        SnapshotStatusWireReceipt::Err(WireErr {
            ok: false,
            code,
            message,
        }) => Err(RecoveryError::new(code, message)),
        _ => Err(RecoveryError::new(
            "invalid_receipt",
            "Snapshot status receipt ok flag disagreed with fields",
        )),
    }
}

/// Runs S1 `byok-desktop-restore` directly once Host stop and maintenance lock preconditions are met.
/// Waits for completion without killing mid-rename so Host rollback remains intact.
pub fn run_restore(
    command: &HostCommandSpec,
    commands: &HostCommands,
    version: &str,
    stamp: &str,
) -> Result<RestoreSuccess, RecoveryError> {
    let (receipt, exit_code) = run_receipt(
        command,
        &[commands.restore.as_str(), version, stamp],
        None,
        false,
        "Restore",
    )?;
    let parsed: RestoreWireReceipt = serde_json::from_value(receipt).map_err(|err| {
        RecoveryError::new("invalid_receipt", format!("Restore receipt malformed: {err}"))
    })?;
    match parsed {
        RestoreWireReceipt::Ok(RestoreOk {
            ok: true,
            aside_path,
        }) => {
            if exit_code != Some(0) {
                return Err(RecoveryError::new(
                    "invalid_exit",
                    format!("Restore exited with code {exit_code:?}"),
                ));
            }
            Ok(RestoreSuccess { aside_path })
        }
        RestoreWireReceipt::Err(MoveBackErr {
            ok: false,
            code,
            message,
            moved_back,
        }) => Err(RecoveryError::new(
            code,
            format!(
                "Restore refused: {message}. {}",
                if moved_back {
                    "The stores are back where they were."
                } else {
                    "Some stores remain aside."
                }
            ),
        )),
        _ => Err(RecoveryError::new(
            "invalid_receipt",
            "Restore receipt ok flag disagreed with fields",
        )),
    }
}

/// Runs S1 `byok-desktop-start-fresh` directly once Host stop and maintenance lock preconditions are met.
/// Waits for completion without killing mid-rename so Host rollback remains intact.
pub fn run_start_fresh(
    command: &HostCommandSpec,
    commands: &HostCommands,
    stamp: &str,
) -> Result<StartFreshSuccess, RecoveryError> {
    let (receipt, exit_code) = run_receipt(
        command,
        &[commands.start_fresh.as_str(), stamp],
        None,
        false,
        "Start fresh",
    )?;
    let parsed: StartFreshWireReceipt = serde_json::from_value(receipt).map_err(|err| {
        RecoveryError::new(
            "invalid_receipt",
            format!("Start fresh receipt malformed: {err}"),
        )
    })?;
    match parsed {
        StartFreshWireReceipt::Ok(StartFreshOk { ok: true, moved }) => {
            if exit_code != Some(0) {
                return Err(RecoveryError::new(
                    "invalid_exit",
                    format!("Start fresh exited with code {exit_code:?}"),
                ));
            }
            Ok(StartFreshSuccess { moved })
        }
        StartFreshWireReceipt::Err(MoveBackErr {
            ok: false,
            code,
            message,
            moved_back,
        }) => {
            let partial = if code == "clear_failed" {
                " The enrollment may already be gone; starting fresh again recovers."
            } else {
                ""
            };
            Err(RecoveryError::new(
                code,
                format!(
                    "Start fresh refused: {message}. {}{} byok-agent doctor shows the device enrollment.",
                    if moved_back {
                        "The stores are back where they were."
                    } else {
                        "Some stores are still aside, as listed."
                    },
                    partial
                ),
            ))
        }
        _ => Err(RecoveryError::new(
            "invalid_receipt",
            "Start fresh receipt ok flag disagreed with fields",
        )),
    }
}

/// Handles `shell.state` using current supervisor state and `byok-desktop-snapshot-status`.
pub fn shell_state(
    supervisor: &HostSupervisor,
    version: &str,
    deadline: Option<Duration>,
) -> ShellView {
    let host = supervisor.last_state();
    match run_snapshot_status(
        supervisor.command_spec(),
        &supervisor.contract().host_commands,
        version,
        deadline,
    ) {
        Ok(snapshot) => ShellView {
            host,
            restore: snapshot.map(|s| SnapshotVersionView { version: s.version }),
            restore_error: None,
        },
        Err(err) => ShellView {
            host,
            restore: None,
            restore_error: Some(err.message),
        },
    }
}

fn is_stopped(state: Option<&SupervisedHostState>) -> Option<bool> {
    match state {
        Some(SupervisedHostState::Stopped { store_refused, .. }) => Some(*store_refused),
        _ => None,
    }
}

/// Handles `shell.restore`: acquires maintenance lock, requires stopped Host + complete snapshot,
/// confirms `supervisor.stop()`, then runs `byok-desktop-restore` and seals terminal handover via caller callback.
pub fn shell_restore<R>(
    supervisor: &HostSupervisor,
    maintenance: &MaintenanceLock,
    version: &str,
    stamp: &str,
    status_deadline: Option<Duration>,
    relaunch: R,
) -> Result<RestoreSuccess, RecoveryError>
where
    R: FnOnce(Option<&RecoveryError>),
{
    let guard = maintenance.try_begin()?;
    if is_stopped(supervisor.last_state().as_ref()).is_none() {
        return Err(RecoveryError::new(
            "precondition_failed",
            "Restore is offered only while the Host is stopped",
        ));
    }
    let commands = &supervisor.contract().host_commands;
    if run_snapshot_status(supervisor.command_spec(), commands, version, status_deadline)?.is_none() {
        return Err(RecoveryError::new(
            "missing_snapshot",
            format!("No complete snapshot of version {version} to restore"),
        ));
    }
    supervisor
        .stop()
        .map_err(|err| RecoveryError::new("host_stop_failed", err.0))?;

    let result = run_restore(supervisor.command_spec(), commands, version, stamp);
    guard.confirm();
    // Release `busy` while preserving confirmed handover before `relaunch` can call `begin_quit()`.
    drop(guard);
    relaunch(result.as_ref().err());
    result
}

/// Handles `shell.startFresh`: acquires maintenance lock, requires stopped + refused store,
/// confirms `supervisor.stop()`, then runs `byok-desktop-start-fresh` and seals terminal handover via caller callback.
pub fn shell_start_fresh<R>(
    supervisor: &HostSupervisor,
    maintenance: &MaintenanceLock,
    stamp: &str,
    relaunch: R,
) -> Result<StartFreshSuccess, RecoveryError>
where
    R: FnOnce(Option<&RecoveryError>),
{
    let guard = maintenance.try_begin()?;
    if is_stopped(supervisor.last_state().as_ref()) != Some(true) {
        return Err(RecoveryError::new(
            "precondition_failed",
            "Start fresh is offered only while the Host is stopped on a refused store",
        ));
    }
    supervisor
        .stop()
        .map_err(|err| RecoveryError::new("host_stop_failed", err.0))?;

    let commands = &supervisor.contract().host_commands;
    let result = run_start_fresh(supervisor.command_spec(), commands, stamp);
    guard.confirm();
    // Release `busy` while preserving confirmed handover before `relaunch` can call `begin_quit()`.
    drop(guard);
    relaunch(result.as_ref().err());
    result
}

/// Preserves `HostState::Stopped` compatibility export if callers construct it directly.
pub fn host_is_stopped(state: &HostState) -> bool {
    matches!(state, HostState::Stopped { .. })
}
