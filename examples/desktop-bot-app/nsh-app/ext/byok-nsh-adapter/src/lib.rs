//! NSH Mixed adapter crate connecting TSX UI to the UI-agnostic `byok-shell` Host supervisor.

mod bridge;
mod quit;
mod supervisor;

use byok_shell::EXPECTED_BRIDGE_VERSION;
use nsh_core::JsonValue;
use nsh_core::prelude::*;

/// Bridge, Host supervisor lifecycle, and desktop quit hooks exposed to TSX from `byok-nsh-adapter`.
///
/// # Rust
///
/// Uses a process-wide `#[module]` singleton instead of a `#[class]` because only one
/// `HostSupervisor` + `MaintenanceLock` may own the storage root and survive TSX hot updates.
#[module]
pub struct ByokShell;

#[module]
impl ByokShell {
    /// Expected NDJSON bridge protocol version shared between shell and Host (`2`).
    pub fn bridge_version() -> u32 {
        EXPECTED_BRIDGE_VERSION
    }

    /// Starts or confirms the process-wide `HostSupervisor` singleton cleanly.
    pub fn start(app_version: Option<String>) -> Result<JsonValue, JsError> {
        supervisor::ensure_started(app_version)
    }

    /// Restarts the active `HostSupervisor` cleanly after a stop or crash.
    pub fn restart() -> Result<(), JsError> {
        supervisor::restart_supervisor()
    }

    /// Returns whether the process-wide `HostSupervisor` singleton has been started.
    pub fn is_started() -> bool {
        supervisor::active_shell().is_some()
    }

    /// Returns the most recently observed `SupervisedHostState`, or `null` before first state arrives.
    pub fn state() -> Option<JsonValue> {
        supervisor::current_state()
    }

    /// Returns the latest OS sleep-inhibition error message object, or `null` when healthy.
    pub fn power_error() -> Option<JsonValue> {
        supervisor::current_power_error()
    }

    /// Executes one contract-allowlisted bridge RPC (`bridge-contract.json`); unallowlisted methods reject with `code: "unknown_method"`.
    pub async fn call(method: String, params: Option<JsonValue>) -> Result<JsonValue, JsError> {
        bridge::dispatch_call(method, params).await
    }

    /// Subscribes to `SupervisedHostState` transitions on the engine thread and returns an unsubscribe `Stop` callback.
    pub fn on_state(sys: System, cx: CallCx<'_>, #[args(state)] listener: Callback<JsonValue>) -> Stop {
        supervisor::subscribe_state(&sys, cx, listener)
    }

    /// Subscribes to coalesced 50 ms Host state-changed hints and returns an unsubscribe `Stop` callback.
    pub fn on_state_hint(sys: System, cx: CallCx<'_>, listener: Callback<()>) -> Stop {
        supervisor::subscribe_state_hint(&sys, cx, listener)
    }

    /// Subscribes to OS sleep-inhibition acquisition errors and returns an unsubscribe `Stop` callback.
    pub fn on_power_error(
        sys: System,
        cx: CallCx<'_>,
        #[args(error)] listener: Callback<JsonValue>,
    ) -> Stop {
        supervisor::subscribe_power_error(&sys, cx, listener)
    }

    /// Subscribes to app shutdown initiation (before 10s Host graceful drain finishes) and returns an unsubscribe `Stop` callback.
    pub fn on_quitting(sys: System, cx: CallCx<'_>, listener: Callback<()>) -> Stop {
        supervisor::subscribe_quitting(&sys, cx, listener)
    }

    /// Registers native desktop quit hooks (`QuitMode::Explicit`, macOS system requests, and `on_quit_request` Host drain); returns `Stop`.
    pub fn install_quit_hooks(sys: System, cx: CallCx<'_>) -> Stop {
        quit::install_quit_hooks(&sys, cx)
    }

    /// Requests unified graceful application shutdown (draining `MaintenanceLock` and stopping the Host).
    pub fn request_quit(sys: System, cx: CallCx<'_>) {
        quit::request_quit(&sys, cx);
    }
}

/// Native module entrypoint imported in TSX as `import { ByokShell } from "byok-nsh-adapter"`.
#[native_module("byok-nsh-adapter")]
fn native(registry: &mut Registry) {
    registry.module::<ByokShell>();
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, UNIX_EPOCH};

    use byok_shell::{
        BridgeContract, HostCommandSpec, HostSupervisor, HostSupervisorConfig, MaintenanceLock,
        QuitOutcome,
    };
    use nsh_core::element::declarations;

    use crate::bridge::{format_utc_stamp, parse_login_item_set_param, validate_renderer_method};
    use crate::quit::drain_for_quit;
    use crate::supervisor::{EventHub, ShellEvent};

    #[test]
    fn declarations_have_zero_undocumented_symbols() {
        let reg = crate::registry();
        assert!(
            reg.undocumented().is_empty(),
            "undocumented exports: {:?}",
            reg.undocumented()
        );
        let dts = declarations(&reg, &[]);
        for expected in [
            "export interface ByokShellModule",
            "export declare const ByokShell: ByokShellModule;",
            "call(method: string, params?: unknown | null): Promise<unknown>;",
            "start(appVersion?: string | null): unknown;",
            "installQuitHooks(): () => void;",
            "requestQuit(): void;",
            "bridgeVersion(): number;",
        ] {
            assert!(dts.contains(expected), "missing `{expected}` in:\n{dts}");
        }
    }

    #[test]
    fn bridge_contract_rejects_unallowlisted_and_bad_login_item_params() {
        for forbidden in ["hello", "shutdown", "keys.profilesChanged", "shell.unknown"] {
            let err = validate_renderer_method(forbidden).expect_err("must reject forbidden method");
            assert_eq!(err.code(), Some("unknown_method"));
        }
        assert!(validate_renderer_method("status").is_ok());
        assert!(validate_renderer_method("keys.submit").is_ok());
        assert!(validate_renderer_method("settings.loginItem").is_ok());

        let bad_login = parse_login_item_set_param(&serde_json::json!({ "enabled": "yes" }))
            .expect_err("string enabled must be rejected");
        assert_eq!(bad_login.code(), Some("invalid_params"));
        assert_eq!(
            parse_login_item_set_param(&serde_json::json!({ "enabled": true })).unwrap(),
            true
        );
    }

    #[test]
    fn utc_stamp_formatting_matches_iso_filename_contract() {
        assert_eq!(format_utc_stamp(UNIX_EPOCH), "1970-01-01T00-00-00.000Z");
    }

    #[test]
    fn event_hub_delivers_events_and_closes_channel_on_unsubscribe() {
        let hub = EventHub::new();
        let (id, rx) = hub.subscribe();
        hub.publish(ShellEvent::StateHint);
        hub.publish(ShellEvent::Quitting);
        assert!(matches!(rx.recv().unwrap(), ShellEvent::StateHint));
        assert!(matches!(rx.recv().unwrap(), ShellEvent::Quitting));
        hub.unsubscribe(id);
        assert!(rx.recv().is_err(), "unsubscribed receiver must terminate cleanly");
    }

    #[test]
    fn drain_for_quit_waits_for_maintenance_lock_and_respects_handed_over() {
        let contract = BridgeContract::load().expect("contract loads");
        let command = HostCommandSpec::dev_node_host(PathBuf::from("nonexistent-host.cjs"));
        let supervisor = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(command, contract),
            |_| {},
            || {},
        ));
        let maintenance = MaintenanceLock::new();
        let guard = maintenance.try_begin().expect("acquire maintenance guard");
        guard.confirm();
        let maintenance_bg = maintenance.clone();
        let supervisor_bg = Arc::clone(&supervisor);
        let handle = std::thread::spawn(move || drain_for_quit(&maintenance_bg, &supervisor_bg));

        std::thread::sleep(Duration::from_millis(30));
        assert!(!handle.is_finished(), "quit drain must block until active maintenance releases");
        drop(guard);
        assert_eq!(handle.join().unwrap(), QuitOutcome::HandedOver);

        let clean_lock = MaintenanceLock::new();
        assert_eq!(drain_for_quit(&clean_lock, &supervisor), QuitOutcome::Quit);
    }
}
