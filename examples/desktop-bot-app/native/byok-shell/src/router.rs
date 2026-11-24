//! Contract-enforced renderer bridge router covering all `mainMethods` and Host-forwarded methods.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bridge::BridgeErrorCode;
use crate::contract::BridgeContract;
use crate::custody::{DEFAULT_CUSTODY_DEADLINE, SecretBytes, list_from_custody, submit_to_custody};
use crate::host::HostSupervisor;
use crate::maintenance::MaintenanceLock;
use crate::recovery::{shell_restore, shell_start_fresh, shell_state};

/// Exact list of `mainMethods` dispatched locally by the desktop shell (`settings.loginItem*` UI integration lives in `#2461`).
pub const HANDLED_MAIN_METHODS: &[&str] = &[
    "settings.loginItem",
    "settings.setLoginItem",
    "keys.submit",
    "keys.list",
    "shell.state",
    "shell.restore",
    "shell.startFresh",
];

/// Login item state matching `LoginItemView` in `src/bridge/domains/settings.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginItemView {
    pub supported: bool,
    pub enabled: bool,
}

/// Platform hook for `settings.loginItem` / `settings.setLoginItem` implemented by UI layer (`#2461`).
pub trait LoginItemBackend: Send + Sync {
    fn get(&self) -> Result<LoginItemView, ShellRouteError>;
    fn set(&self, enabled: bool) -> Result<LoginItemView, ShellRouteError>;
}

/// Default login item backend failing closed cleanly on unsupported / pre-UI contexts.
pub struct UnsupportedLoginItemBackend;

impl LoginItemBackend for UnsupportedLoginItemBackend {
    fn get(&self) -> Result<LoginItemView, ShellRouteError> {
        Ok(LoginItemView {
            supported: false,
            enabled: false,
        })
    }

    fn set(&self, _enabled: bool) -> Result<LoginItemView, ShellRouteError> {
        Err(ShellRouteError::new(
            BridgeErrorCode::MethodFailed.as_str(),
            "Login item switching is provided by the platform UI shell (#2461)",
        ))
    }
}

/// Structured refusal emitted by [`ShellRouter::dispatch_renderer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRouteError {
    pub code: String,
    pub message: String,
}

impl ShellRouteError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ShellRouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ShellRouteError {}

/// Single contract-backed router enforcing `rendererMethods`, `mainMethods`, and `shellToHostMethods` isolation.
pub struct ShellRouter {
    supervisor: std::sync::Arc<HostSupervisor>,
    maintenance: MaintenanceLock,
    login_item: Box<dyn LoginItemBackend>,
    app_version: String,
    custody_deadline: Duration,
    recovery_deadline: Option<Duration>,
}

impl ShellRouter {
    pub fn new(
        supervisor: std::sync::Arc<HostSupervisor>,
        maintenance: MaintenanceLock,
        login_item: Box<dyn LoginItemBackend>,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            supervisor,
            maintenance,
            login_item,
            app_version: app_version.into(),
            custody_deadline: DEFAULT_CUSTODY_DEADLINE,
            recovery_deadline: None,
        }
    }

    /// Overrides default custody/S1 timeouts (mainly for integration tests).
    pub fn with_deadlines(
        mut self,
        custody_deadline: Duration,
        recovery_deadline: Option<Duration>,
    ) -> Self {
        self.custody_deadline = custody_deadline;
        self.recovery_deadline = recovery_deadline;
        self
    }

    pub fn contract(&self) -> &BridgeContract {
        self.supervisor.contract()
    }

    /// Dispatches a non-secret renderer call (`keys.submit` must enter via [`Self::dispatch_keys_submit`]).
    pub fn dispatch_renderer(&self, method: &str, params: Value) -> Result<Value, ShellRouteError> {
        let contract = self.supervisor.contract();
        if !contract.allows_renderer_method(method) {
            return Err(ShellRouteError::new(
                BridgeErrorCode::UnknownMethod.as_str(),
                format!("Bridge method `{method}` is not in contract rendererMethods"),
            ));
        }

        if contract.is_main_method(method) {
            return match method {
                "settings.loginItem" => {
                    if !params.is_null() {
                        return Err(ShellRouteError::new(
                            BridgeErrorCode::InvalidParams.as_str(),
                            "settings.loginItem takes no params",
                        ));
                    }
                    let view = self.login_item.get()?;
                    serde_json::to_value(view).map_err(|err| {
                        ShellRouteError::new(BridgeErrorCode::MethodFailed.as_str(), err.to_string())
                    })
                }
                "settings.setLoginItem" => {
                    let enabled = params
                        .as_object()
                        .and_then(|obj| obj.get("enabled"))
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            ShellRouteError::new(
                                BridgeErrorCode::InvalidParams.as_str(),
                                "settings.setLoginItem needs { enabled: boolean }",
                            )
                        })?;
                    let view = self.login_item.set(enabled)?;
                    serde_json::to_value(view).map_err(|err| {
                        ShellRouteError::new(BridgeErrorCode::MethodFailed.as_str(), err.to_string())
                    })
                }
                "keys.list" => {
                    if !params.is_null() {
                        return Err(ShellRouteError::new(
                            BridgeErrorCode::InvalidParams.as_str(),
                            "keys.list takes no params",
                        ));
                    }
                    let statuses = list_from_custody(
                        self.supervisor.command_spec(),
                        contract.host_commands.custody.as_str(),
                        self.custody_deadline,
                        Some(&self.supervisor),
                    )
                    .map_err(|err| ShellRouteError::new(err.code, err.message))?;
                    Ok(Value::Array(statuses))
                }
                "keys.submit" => Err(ShellRouteError::new(
                    BridgeErrorCode::InvalidParams.as_str(),
                    "keys.submit requires SecretBytes path via dispatch_keys_submit",
                )),
                "shell.state" => {
                    if !params.is_null() {
                        return Err(ShellRouteError::new(
                            BridgeErrorCode::InvalidParams.as_str(),
                            "shell.state takes no params",
                        ));
                    }
                    let view = shell_state(&self.supervisor, &self.app_version, self.recovery_deadline);
                    serde_json::to_value(view).map_err(|err| {
                        ShellRouteError::new(BridgeErrorCode::MethodFailed.as_str(), err.to_string())
                    })
                }
                "shell.restore" | "shell.startFresh" => Err(ShellRouteError::new(
                    BridgeErrorCode::InvalidParams.as_str(),
                    "recovery actions require version/stamp/relaunch invocation",
                )),
                other => Err(ShellRouteError::new(
                    BridgeErrorCode::UnknownMethod.as_str(),
                    format!("Unhandled main method `{other}`"),
                )),
            };
        }

        self.supervisor
            .call_renderer_forwarded(method, params)
            .map_err(|err| ShellRouteError::new(err.code.as_str(), err.message))
    }

    /// Dedicated secret-bearing `keys.submit` entry consuming and immediately zeroizing `SecretBytes`.
    pub fn dispatch_keys_submit(&self, payload: SecretBytes) -> Result<Value, ShellRouteError> {
        let contract = self.supervisor.contract();
        if !contract.allows_renderer_method("keys.submit") || !contract.is_main_method("keys.submit") {
            return Err(ShellRouteError::new(
                BridgeErrorCode::UnknownMethod.as_str(),
                "keys.submit is not authorized in bridge-contract.json",
            ));
        }
        submit_to_custody(
            self.supervisor.command_spec(),
            contract.host_commands.custody.as_str(),
            payload,
            self.custody_deadline,
            Some(&self.maintenance),
            Some(&self.supervisor),
        )
        .map_err(|err| ShellRouteError::new(err.code, err.message))
    }

    /// Executes `shell.state` with explicit app version.
    pub fn state(&self, app_version: &str) -> crate::recovery::ShellView {
        shell_state(&self.supervisor, app_version, self.recovery_deadline)
    }

    /// Executes `shell.restore` under `MaintenanceLock` and `supervisor.stop()`.
    pub fn restore<R>(
        &self,
        app_version: &str,
        stamp: &str,
        relaunch: R,
    ) -> Result<crate::recovery::RestoreSuccess, ShellRouteError>
    where
        R: FnOnce(Option<&crate::recovery::RecoveryError>),
    {
        shell_restore(
            &self.supervisor,
            &self.maintenance,
            app_version,
            stamp,
            self.recovery_deadline,
            relaunch,
        )
        .map_err(|err| ShellRouteError::new(err.code, err.message))
    }

    /// Executes `shell.startFresh` under `MaintenanceLock` and `supervisor.stop()`.
    pub fn start_fresh<R>(
        &self,
        stamp: &str,
        relaunch: R,
    ) -> Result<crate::recovery::StartFreshSuccess, ShellRouteError>
    where
        R: FnOnce(Option<&crate::recovery::RecoveryError>),
    {
        shell_start_fresh(
            &self.supervisor,
            &self.maintenance,
            stamp,
            self.recovery_deadline,
            relaunch,
        )
        .map_err(|err| ShellRouteError::new(err.code, err.message))
    }
}
