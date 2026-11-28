//! S1 and Host lifecycle for an explicit whole-application update handover.

use std::path::PathBuf;

use crate::host::HandoverRecovery;
use crate::{HostSupervisor, MaintenanceGuard, MaintenanceLock, run_snapshot};

#[derive(Debug, PartialEq, Eq)]
pub enum SwapOutcome {
    Swapped { executable: PathBuf },
    RolledBackVerified(String),
    InstallCorrupted(String),
}

/// Owns a staged update and reports the verified result of consuming it.
pub trait UpdateInstaller {
    fn swap(self) -> SwapOutcome;
}

#[derive(Debug, PartialEq, Eq)]
pub enum HandoverOutcome {
    Swapped { executable: PathBuf },
    QuitRequested,
}

#[derive(Debug, PartialEq, Eq)]
pub struct UpdateFailure {
    pub code: &'static str,
    pub message: String,
    pub host_recovered: bool,
    pub recovery_code: Option<&'static str>,
}

impl UpdateFailure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            host_recovered: false,
            recovery_code: None,
        }
    }
}

/// Runs handover while the caller owns the installation lock. The caller must release
/// that lock and request platform restart only after `Swapped` returns.
pub fn handover<I: UpdateInstaller>(
    maintenance: &MaintenanceLock,
    supervisor: &HostSupervisor,
    current_version: &str,
    installer: I,
) -> Result<HandoverOutcome, UpdateFailure> {
    let guard = maintenance
        .try_begin()
        .map_err(|err| UpdateFailure::new(err.code(), err.to_string()))?;
    guard.begin_pending();
    if let Err(err) = supervisor.stop() {
        drop(installer);
        return Err(recover_host(
            maintenance,
            supervisor,
            guard,
            UpdateFailure::new("update_host_stop_failed", err.to_string()),
        ));
    }
    if let Err(err) = run_snapshot(
        supervisor.command_spec(),
        &supervisor.contract().host_commands,
        current_version,
    ) {
        drop(installer);
        return Err(recover_host(
            maintenance,
            supervisor,
            guard,
            UpdateFailure::new("update_snapshot_failed", err.to_string()),
        ));
    }
    if maintenance.is_quitting() {
        drop(installer);
        guard.cancel_pending();
        return Ok(HandoverOutcome::QuitRequested);
    }

    match installer.swap() {
        SwapOutcome::Swapped { executable } => {
            guard.confirm();
            drop(guard);
            Ok(HandoverOutcome::Swapped { executable })
        }
        SwapOutcome::RolledBackVerified(message) => Err(recover_host(
            maintenance,
            supervisor,
            guard,
            UpdateFailure::new("update_install_failed", message),
        )),
        SwapOutcome::InstallCorrupted(message) => {
            supervisor.mark_install_corrupted();
            guard.cancel_pending();
            Err(UpdateFailure::new("update_install_corrupted", message))
        }
    }
}

fn recover_host(
    maintenance: &MaintenanceLock,
    supervisor: &HostSupervisor,
    guard: MaintenanceGuard,
    mut failure: UpdateFailure,
) -> UpdateFailure {
    guard.cancel_pending();
    if !maintenance.is_quitting() {
        let recovery = supervisor.recover_during_handover(&guard);
        if !maintenance.is_quitting() {
            match recovery {
                HandoverRecovery::Running => failure.host_recovered = true,
                HandoverRecovery::Quitting => (),
                HandoverRecovery::Failed => {
                    failure.recovery_code = Some("update_host_recovery_failed")
                }
            }
        }
    }
    drop(guard);
    failure
}
