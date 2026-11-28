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

    /// Restarts the active `HostSupervisor` off the engine thread after a stop or crash.
    pub async fn restart() -> Result<(), JsError> {
        supervisor::restart_supervisor().await
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
    pub fn on_state(
        sys: System,
        cx: CallCx<'_>,
        #[args(state)] listener: Callback<JsonValue>,
    ) -> Stop {
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::pin::pin;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::task::{Context, Poll, Waker};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use byok_shell::{
        BridgeContract, HostCommandSpec, HostSupervisor, HostSupervisorConfig, MaintenanceLock,
        QuitOutcome, ShellRouter, SupervisedHostState,
    };
    use nsh_core::desktop::{DesktopCommand, WindowEvent};
    use nsh_core::element::desktop::{QUIT_TIMEOUT, on_app_quit, on_quit_request, quit, restart};
    use nsh_core::element::{
        Dialog, DialogButtonStyle, DialogReply, Os, Root, declarations, px, size, spawn, view,
    };
    use nsh_core::prelude::*;
    use nsh_core::{
        ApproxTextEngine, Command, Core, EventKind, EventPayload, JsonValue, MountItem,
        PayloadValue, ROOT_ID,
    };

    use crate::bridge::{
        execute_restore_sync, execute_start_fresh_sync, finish_recovery_call, format_utc_stamp,
        handle_login_item_get_with, handle_login_item_set_with, open_recovery_failure_dialog,
        parse_login_item_set_param, validate_renderer_method,
    };
    use crate::quit::{
        drain_for_quit, drain_for_quit_with, fallback_app_quit_cleanup_with,
        should_call_desktop_quit,
    };
    use crate::supervisor::{
        EventHub, RuntimeShell, ShellEvent, build_runtime_shell, restart_shell_sync,
    };

    struct TestTempDir(PathBuf);

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp test dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        predicate()
    }

    fn poll_ready<F: std::future::Future>(fut: F) -> F::Output {
        let mut fut = pin!(fut);
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(out) => out,
            Poll::Pending => panic!("expected immediately ready future in unit test"),
        }
    }

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
            "restart(): Promise<void>;",
            "installQuitHooks(): () => void;",
            "requestQuit(): void;",
            "bridgeVersion(): number;",
        ] {
            assert!(dts.contains(expected), "missing `{expected}` in:\n{dts}");
        }
    }

    #[test]
    fn runtime_shell_retains_startup_app_version_for_restore() {
        let command = HostCommandSpec::dev_node_host(PathBuf::from("nonexistent-host.cjs"));
        let shell = build_runtime_shell(command, "2.4.0", false).expect("shell builds");
        assert_eq!(shell.app_version, "2.4.0");
    }

    #[test]
    fn bridge_contract_rejects_unallowlisted_and_bad_login_item_params() {
        for forbidden in ["hello", "shutdown", "keys.profilesChanged", "shell.unknown"] {
            let err =
                validate_renderer_method(forbidden).expect_err("must reject forbidden method");
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
        assert!(
            rx.recv().is_err(),
            "unsubscribed receiver must terminate cleanly"
        );
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
        assert!(
            !handle.is_finished(),
            "quit drain must block until active maintenance releases"
        );
        drop(guard);
        assert_eq!(handle.join().unwrap(), QuitOutcome::HandedOver);

        let clean_lock = MaintenanceLock::new();
        assert_eq!(drain_for_quit(&clean_lock, &supervisor), QuitOutcome::Quit);
    }

    #[test]
    fn drain_for_quit_waits_for_active_custody_before_stopping_host() {
        let maintenance = MaintenanceLock::new();
        let custody_guard = maintenance
            .try_begin_custody()
            .expect("acquire custody guard");
        let stop_calls = Arc::new(AtomicUsize::new(0));
        let stop_calls_bg = Arc::clone(&stop_calls);
        let maintenance_bg = maintenance.clone();

        let handle = std::thread::spawn(move || {
            drain_for_quit_with(&maintenance_bg, || {
                stop_calls_bg.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });

        std::thread::sleep(Duration::from_millis(60));
        assert!(
            !handle.is_finished(),
            "quit drain must block while custody guard is held"
        );
        assert_eq!(
            stop_calls.load(Ordering::SeqCst),
            0,
            "Host must not stop before in-flight custody guard drops"
        );

        drop(custody_guard);
        let outcome = handle.join().unwrap();
        assert_eq!(outcome, QuitOutcome::Quit);
        assert!(should_call_desktop_quit(outcome));
        assert_eq!(stop_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn login_item_single_engine_path_handles_linux_macos_and_windows_semantics() {
        // 1. Linux stays supported: false on read and fails closed on set without invoking backend.
        let backend_touched = Arc::new(AtomicBool::new(false));
        let touched = Arc::clone(&backend_touched);
        let linux_get = poll_ready(handle_login_item_get_with(
            Os::Linux,
            &JsonValue::Null,
            move || {
                touched.store(true, Ordering::SeqCst);
                std::future::ready(true)
            },
        ))
        .expect("linux get succeeds with supported: false");
        assert_eq!(
            linux_get,
            serde_json::json!({ "supported": false, "enabled": false })
        );
        assert!(!backend_touched.load(Ordering::SeqCst));

        let touched = Arc::clone(&backend_touched);
        let linux_set = poll_ready(handle_login_item_set_with(
            Os::Linux,
            &serde_json::json!({ "enabled": true }),
            move |_| {
                touched.store(true, Ordering::SeqCst);
                std::future::ready(Ok::<(), &'static str>(()))
            },
            || std::future::ready(true),
        ))
        .expect_err("linux set must fail closed");
        assert_eq!(linux_set.code(), Some("method_failed"));
        assert!(!backend_touched.load(Ordering::SeqCst));

        // 2. macOS and Windows read and set via the single engine-thread path and return OS-reported state.
        for desktop_os in [Os::MacOs, Os::Windows] {
            let get_ok = poll_ready(handle_login_item_get_with(
                desktop_os,
                &JsonValue::Null,
                || std::future::ready(true),
            ))
            .expect("desktop get succeeds");
            assert_eq!(
                get_ok,
                serde_json::json!({ "supported": true, "enabled": true })
            );

            // Set ok + OS still reports false (e.g., macOS SMAppService RequiresApproval).
            let set_reported = poll_ready(handle_login_item_set_with(
                desktop_os,
                &serde_json::json!({ "enabled": true }),
                |requested| {
                    assert!(requested);
                    std::future::ready(Ok::<(), &'static str>(()))
                },
                || std::future::ready(false),
            ))
            .expect("set succeeds and reports actual OS read");
            assert_eq!(
                set_reported,
                serde_json::json!({ "supported": true, "enabled": false })
            );

            // Backend failure maps to method_failed without calling read.
            let set_err = poll_ready(handle_login_item_set_with(
                desktop_os,
                &serde_json::json!({ "enabled": false }),
                |_| std::future::ready(Err("permission denied")),
                || {
                    panic!("read must not run when set fails");
                    #[allow(unreachable_code)]
                    std::future::ready(false)
                },
            ))
            .expect_err("backend failure maps to method_failed");
            assert_eq!(set_err.code(), Some("method_failed"));
        }

        // 3. Parameter validation fails closed with invalid_params on every OS.
        let bad_get = poll_ready(handle_login_item_get_with(
            Os::MacOs,
            &serde_json::json!({ "unexpected": 1 }),
            || std::future::ready(false),
        ))
        .expect_err("non-null loginItem params must fail");
        assert_eq!(bad_get.code(), Some("invalid_params"));

        let bad_set = poll_ready(handle_login_item_set_with(
            Os::Windows,
            &serde_json::json!({ "enabled": "true" }),
            |_| std::future::ready(Ok::<(), &'static str>(())),
            || std::future::ready(false),
        ))
        .expect_err("non-boolean enabled must fail");
        assert_eq!(bad_set.code(), Some("invalid_params"));
    }

    #[test]
    fn recovery_restore_and_start_fresh_trigger_restart_hook_and_quit_drain_skips_second_host_stop()
    {
        let tmp = TestTempDir::new("byok-adapter-recovery");
        let contract = BridgeContract::load().expect("contract loads");

        let write_mock = |name: &str,
                          store_refused: bool,
                          fail_restore: bool|
         -> (HostCommandSpec, PathBuf) {
            let shutdown_log = tmp.path().join(format!("{name}-shutdowns.log"));
            let script = format!(
                r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: {{ version: arg1, target: '/tmp/snap' }} }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  if ({fail_restore}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'restore_failed',
      message: 'simulated restore refusal',
      movedBack: true,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{ ok: true, asidePath: '/tmp/adapter-restored.aside' }}) + '\n');
  process.exit(0);
}}
if (subcmd === {start_fresh_cmd}) {{
  process.stdout.write(JSON.stringify({{
    ok: true,
    moved: [{{ from: '/tmp/host', to: '/tmp/adapter-fresh.aside' }}],
  }}) + '\n');
  process.exit(0);
}}
if (subcmd === {custody_cmd}) {{
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {{ raw += chunk; }});
  process.stdin.on('end', () => {{
    process.stdout.write(JSON.stringify({{
      ok: true,
      statuses: [{{ profile_ref: 'post-restart-profile', enabled: true }}],
    }}) + '\n');
    process.exit(0);
  }});
}} else {{
  const rl = readline.createInterface({{ input: process.stdin }});
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {{
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
      process.stdout.write(JSON.stringify({{
        event: 'state',
        state: {{ state: 'stopped', pid: process.pid, storeRefused: {store_refused}, reason: 'stopped' }},
      }}) + '\n');
    }} else if (msg.method === 'keys.profilesChanged') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ ok: true }} }}) + '\n');
    }} else if (msg.method === 'shutdown') {{
      fs.appendFileSync({shutdown_log}, 'shutdown\n');
      process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
      process.exit(0);
    }}
  }});
}}
"#,
                snapshot_status_cmd =
                    serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
                restore_cmd = serde_json::to_string(&contract.host_commands.restore).unwrap(),
                start_fresh_cmd =
                    serde_json::to_string(&contract.host_commands.start_fresh).unwrap(),
                custody_cmd = serde_json::to_string(&contract.host_commands.custody).unwrap(),
                shutdown_log =
                    serde_json::to_string(&shutdown_log.to_string_lossy().into_owned()).unwrap(),
            );
            let script_path = tmp.path().join(format!("{name}.mjs"));
            fs::write(&script_path, script).expect("write mock host script");
            (HostCommandSpec::dev_node_host(script_path), shutdown_log)
        };

        let shutdown_count = |path: &Path| -> usize {
            fs::read_to_string(path)
                .map(|text| text.lines().count())
                .unwrap_or(0)
        };

        // 1. shell.restore seals lock, invokes restart() hook, and quit drain returns HandedOver
        //    without stopping the Host twice or calling plain desktop::quit().
        let (restore_spec, restore_shutdowns) = write_mock("adapter-restore", false, false);
        let shell = build_runtime_shell(restore_spec.clone(), "1.0.0", true).expect("shell starts");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                shell.supervisor.last_state(),
                Some(SupervisedHostState::Stopped {
                    store_refused: false,
                    ..
                })
            )
        }));

        let (out, relaunched) = execute_restore_sync(
            &shell.router,
            &shell.app_version,
            "2026-11-25T00-00-00.000Z",
        );
        assert!(relaunched, "restore must request adapter restart()");
        let mut restart_calls = 0usize;
        let mut quit_calls = 0usize;
        let payload = poll_ready(finish_recovery_call(
            out,
            relaunched,
            &shell.maintenance,
            |_| {
                panic!("successful restore must not show failure dialog");
                #[allow(unreachable_code)]
                (std::future::ready(DialogReply::dismissed()), || {})
            },
            || {
                restart_calls += 1;
            },
            || {
                quit_calls += 1;
            },
        ))
        .expect("restore JSON payload");
        assert_eq!(payload["asidePath"], "/tmp/adapter-restored.aside");
        assert_eq!(restart_calls, 1);
        assert_eq!(quit_calls, 0);
        assert!(shell.maintenance.is_handed_over());

        let mut quit_stop_calls = 0usize;
        let quit_outcome = drain_for_quit_with(&shell.maintenance, || {
            quit_stop_calls += 1;
            shell.supervisor.stop()
        });
        assert_eq!(quit_outcome, QuitOutcome::HandedOver);
        assert_eq!(
            quit_stop_calls, 0,
            "quit drain must not stop Host a second time after handover"
        );
        assert!(
            !should_call_desktop_quit(quit_outcome),
            "handed-over quit drain must leave process termination to restart()"
        );
        assert_eq!(shutdown_count(&restore_shutdowns), 1);
        assert_eq!(
            shell
                .router
                .dispatch_renderer("keys.list", JsonValue::Null)
                .expect_err("sealed old shell refuses keys.list")
                .code,
            "PROVIDER_CONFIGURATION_BUSY"
        );

        let shell_restarted =
            build_runtime_shell(restore_spec, "1.0.0", false).expect("fresh post-restart shell");
        let recovered_list = shell_restarted
            .router
            .dispatch_renderer("keys.list", JsonValue::Null)
            .expect("fresh post-restart shell keys.list succeeds");
        assert_eq!(recovered_list.as_array().map(Vec::len), Some(1));

        // 2. shell.startFresh seals lock, invokes restart() hook, and quit drain returns HandedOver
        //    without stopping Host twice.
        let (fresh_spec, fresh_shutdowns) = write_mock("adapter-fresh", true, false);
        let shell_fresh =
            build_runtime_shell(fresh_spec.clone(), "1.0.0", true).expect("shell starts");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                shell_fresh.supervisor.last_state(),
                Some(SupervisedHostState::Stopped {
                    store_refused: true,
                    ..
                })
            )
        }));

        let (out, relaunched) =
            execute_start_fresh_sync(&shell_fresh.router, "2026-11-25T00-01-00.000Z");
        assert!(relaunched, "startFresh must request adapter restart()");
        let mut fresh_restart_calls = 0usize;
        let mut fresh_quit_calls = 0usize;
        let payload = poll_ready(finish_recovery_call(
            out,
            relaunched,
            &shell_fresh.maintenance,
            |_| {
                panic!("successful startFresh must not show failure dialog");
                #[allow(unreachable_code)]
                (std::future::ready(DialogReply::dismissed()), || {})
            },
            || {
                fresh_restart_calls += 1;
            },
            || {
                fresh_quit_calls += 1;
            },
        ))
        .expect("startFresh JSON payload");
        assert_eq!(payload["moved"].as_array().map(Vec::len), Some(1));
        assert_eq!(fresh_restart_calls, 1);
        assert_eq!(fresh_quit_calls, 0);
        assert!(shell_fresh.maintenance.is_handed_over());

        let mut fresh_quit_stop_calls = 0usize;
        let fresh_quit_outcome = drain_for_quit_with(&shell_fresh.maintenance, || {
            fresh_quit_stop_calls += 1;
            shell_fresh.supervisor.stop()
        });
        assert_eq!(fresh_quit_outcome, QuitOutcome::HandedOver);
        assert_eq!(fresh_quit_stop_calls, 0);
        assert!(!should_call_desktop_quit(fresh_quit_outcome));
        assert_eq!(shutdown_count(&fresh_shutdowns), 1);

        let shell_after_fresh =
            build_runtime_shell(fresh_spec, "1.0.0", false).expect("fresh post-restart shell");
        assert_eq!(
            shell_after_fresh
                .router
                .dispatch_renderer("keys.list", JsonValue::Null)
                .expect("post-restart keys.list succeeds after startFresh")
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        // 3. Pre-stop refusal does NOT show dialog, call restart(), or seal lock; post-stop refusal
        //    shows the blocking dialog with the coded refusal before calling restart() and seals handover.
        let (fail_spec, fail_shutdowns) = write_mock("adapter-fail", false, true);
        let shell_fail = build_runtime_shell(fail_spec, "1.0.0", true).expect("shell starts");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                shell_fail.supervisor.last_state(),
                Some(SupervisedHostState::Stopped {
                    store_refused: false,
                    ..
                })
            )
        }));

        let (pre_out, pre_relaunched) =
            execute_start_fresh_sync(&shell_fail.router, "2026-11-25T00-02-00.000Z");
        assert!(!pre_relaunched);
        let mut pre_restarts = 0usize;
        let mut pre_quits = 0usize;
        let pre_err = poll_ready(finish_recovery_call(
            pre_out,
            pre_relaunched,
            &shell_fail.maintenance,
            |_| {
                panic!("pre-stop refusal must not show blocking relaunch dialog");
                #[allow(unreachable_code)]
                (std::future::ready(DialogReply::dismissed()), || {})
            },
            || {
                pre_restarts += 1;
            },
            || {
                pre_quits += 1;
            },
        ))
        .expect_err("startFresh without storeRefused must fail precondition");
        assert_eq!(pre_err.code(), Some("precondition_failed"));
        assert_eq!(pre_restarts, 0);
        assert_eq!(pre_quits, 0);
        assert!(!shell_fail.maintenance.is_handed_over());
        assert_eq!(shutdown_count(&fail_shutdowns), 0);

        let (post_out, post_relaunched) = execute_restore_sync(
            &shell_fail.router,
            &shell_fail.app_version,
            "2026-11-25T00-03-00.000Z",
        );
        assert!(
            post_relaunched,
            "post-stop restore refusal must still trigger restart()"
        );
        let shown_dialog = std::cell::RefCell::new(None);
        let events = std::cell::RefCell::new(Vec::new());
        let post_err = poll_ready(finish_recovery_call(
            post_out,
            post_relaunched,
            &shell_fail.maintenance,
            |dlg| {
                *shown_dialog.borrow_mut() = Some(dlg);
                events.borrow_mut().push("dialog");
                (std::future::ready(DialogReply::dismissed()), || {
                    events.borrow_mut().push("close_dialog");
                })
            },
            || {
                events.borrow_mut().push("restart");
            },
            || {
                events.borrow_mut().push("quit");
            },
        ))
        .expect_err("restore refusal surfaces bridge error code");
        assert_eq!(post_err.code(), Some("restore_failed"));
        assert_eq!(*events.borrow(), vec!["dialog", "restart"]);
        let dlg: Dialog = shown_dialog
            .into_inner()
            .expect("post-stop refusal must show blocking dialog before restart");
        assert_eq!(dlg.title.as_deref(), Some("Recovery failed"));
        let msg = dlg.message.as_deref().unwrap_or("");
        assert!(
            msg.contains("restore_failed"),
            "dialog must carry refusal code: {msg}"
        );
        assert!(
            msg.contains("simulated restore refusal"),
            "dialog must carry refusal message: {msg}"
        );
        assert!(
            msg.contains("*.aside-*"),
            "dialog must explain aside stores: {msg}"
        );
        assert!(!dlg.cancelable);
        assert!(!dlg.sheet);
        assert!(dlg.input.is_none());
        assert_eq!(dlg.buttons.len(), 1);
        assert_eq!(dlg.buttons[0].style, DialogButtonStyle::Default);
        assert!(shell_fail.maintenance.is_handed_over());
        let mut post_quit_stops = 0usize;
        assert_eq!(
            drain_for_quit_with(&shell_fail.maintenance, || {
                post_quit_stops += 1;
                shell_fail.supervisor.stop()
            }),
            QuitOutcome::HandedOver
        );
        assert_eq!(post_quit_stops, 0);
        assert_eq!(shutdown_count(&fail_shutdowns), 1);
    }

    #[test]
    fn recovery_refusal_shows_nsh_core_dialog_before_desktop_restart_while_handover_sealed() {
        use std::sync::Mutex;

        let tmp = TestTempDir::new("byok-adapter-nsh-dialog");
        let contract = BridgeContract::load().expect("contract loads");

        let write_fail_mock = |name: &str,
                               store_refused: bool,
                               fail_restore: bool,
                               fail_start_fresh: bool|
         -> (HostCommandSpec, PathBuf) {
            let spawns_log = tmp.path().join(format!("{name}-spawns.log"));
            let script = format!(
                r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: {{ version: arg1, target: '/tmp/snap' }} }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  if ({fail_restore}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'restore_failed',
      message: 'snapshot rename denied',
      movedBack: true,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{ ok: true, asidePath: '/tmp/ok.aside' }}) + '\n');
  process.exit(0);
}}
if (subcmd === {start_fresh_cmd}) {{
  if ({fail_start_fresh}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'clear_failed',
      message: 'enrollment revoke refused',
      movedBack: false,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{ ok: true, moved: [] }}) + '\n');
  process.exit(0);
}}
fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'stopped', pid: process.pid, storeRefused: {store_refused}, reason: 'stopped' }},
    }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
                snapshot_status_cmd =
                    serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
                restore_cmd = serde_json::to_string(&contract.host_commands.restore).unwrap(),
                start_fresh_cmd =
                    serde_json::to_string(&contract.host_commands.start_fresh).unwrap(),
                spawns_log =
                    serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            );
            let script_path = tmp.path().join(format!("{name}.mjs"));
            fs::write(&script_path, script).expect("write fail mock");
            (HostCommandSpec::dev_node_host(script_path), spawns_log)
        };

        let count_lines = |path: &Path| -> usize {
            fs::read_to_string(path)
                .map(|text| text.lines().filter(|line| !line.is_empty()).count())
                .unwrap_or(0)
        };

        // Drive the real `nsh_core::element::dialog` + `nsh_core::element::desktop::restart` path
        // inside `nsh_core::Core` for both post-stop restore (`restore_failed`) and startFresh (`clear_failed`).
        for (case_name, store_refused, expected_code, expected_msg) in [
            (
                "restore-dialog",
                false,
                "restore_failed",
                "snapshot rename denied",
            ),
            (
                "fresh-dialog",
                true,
                "clear_failed",
                "enrollment revoke refused",
            ),
        ] {
            let (spec, spawns_log) =
                write_fail_mock(case_name, store_refused, !store_refused, store_refused);
            let shell = build_runtime_shell(spec, "1.0.0", true).expect("shell starts");
            assert!(wait_until(Duration::from_secs(5), || {
                matches!(
                    shell.supervisor.last_state(),
                    Some(SupervisedHostState::Stopped {
                        store_refused: sr,
                        ..
                    }) if sr == store_refused
                )
            }));
            assert_eq!(count_lines(&spawns_log), 1);

            type PendingRecoveryOutcome =
                Arc<Mutex<Option<(Result<JsonValue, byok_shell::ShellRouteError>, bool)>>>;
            type RecoveryResultSlot = Arc<Mutex<Option<Result<JsonValue, JsError>>>>;

            let result_slot: RecoveryResultSlot = Arc::new(Mutex::new(None));

            // Execute the real recovery call synchronously first (as `blocking(...)` does), then
            // run real `finish_recovery_call(..., dialog, restart)` on the NSH engine thread.
            let pending_outcome: PendingRecoveryOutcome =
                Arc::new(Mutex::new(Some(if !store_refused {
                    let (out, relaunched) = execute_restore_sync(
                        &shell.router,
                        &shell.app_version,
                        "2026-11-25T00-04-00.000Z",
                    );
                    (out.map(|v| serde_json::to_value(v).unwrap()), relaunched)
                } else {
                    let (out, relaunched) =
                        execute_start_fresh_sync(&shell.router, "2026-11-25T00-04-00.000Z");
                    (out.map(|v| serde_json::to_value(v).unwrap()), relaunched)
                })));

            // Handover is already sealed by `guard.confirm()` before the dialog is even shown.
            assert!(shell.maintenance.is_handed_over());

            // Component that spawns `finish_recovery_call(..., open_recovery_failure_dialog, restart, quit)` on the engine thread.
            thread_local! {
                static PENDING_CALL: std::cell::RefCell<
                    Option<(PendingRecoveryOutcome, MaintenanceLock, RecoveryResultSlot)>,
                > = const { std::cell::RefCell::new(None) };
            }
            PENDING_CALL.with(|cell| {
                *cell.borrow_mut() = Some((
                    Arc::clone(&pending_outcome),
                    shell.maintenance.clone(),
                    Arc::clone(&result_slot),
                ));
            });

            #[component]
            fn RecoveryDialogHarness() -> impl IntoElement {
                if let Some((input, maintenance, output)) =
                    PENDING_CALL.with(|cell| cell.borrow_mut().take())
                {
                    spawn(async move {
                        let (out, relaunched) = input.lock().unwrap().take().unwrap();
                        let res = finish_recovery_call(
                            out,
                            relaunched,
                            &maintenance,
                            open_recovery_failure_dialog,
                            restart,
                            quit,
                        )
                        .await;
                        *output.lock().unwrap() = Some(res);
                    });
                }
                view()
            }

            let mut core = Core::new(ApproxTextEngine, size(px(800.0), px(600.0)));
            core.mount_root(&Root::of::<RecoveryDialogHarness>());
            let first_batch = core.commit().expect("initial commit");
            core.run_component_tasks();
            let second_batch = core.commit();

            let mut all_commands = Vec::new();
            for batch in [Some(first_batch), second_batch].into_iter().flatten() {
                for item in batch.items {
                    if let MountItem::Command { id, command } = item
                        && id == ROOT_ID
                    {
                        all_commands.push(command);
                    }
                }
            }

            let shown_dialog = all_commands
                .iter()
                .find_map(|cmd| match cmd {
                    Command::Dialog(dlg) => Some(dlg.clone()),
                    _ => None,
                })
                .expect("nsh_core::element::dialog must emit Command::Dialog on ROOT_ID");
            assert!(
                !all_commands.iter().any(|cmd| {
                    matches!(
                        cmd,
                        Command::Desktop(desktop) if matches!(desktop.as_ref(), DesktopCommand::Restart)
                    )
                }),
                "desktop::restart() must NOT fire before user dismisses the recovery refusal dialog"
            );
            assert!(
                result_slot.lock().unwrap().is_none(),
                "recovery call must wait on dialog dismissal before completing"
            );
            assert_eq!(shown_dialog.title.as_deref(), Some("Recovery failed"));
            let msg = shown_dialog.message.as_deref().unwrap_or("");
            assert!(msg.contains(expected_code), "missing code in dialog: {msg}");
            assert!(
                msg.contains(expected_msg),
                "missing message in dialog: {msg}"
            );
            assert!(
                msg.contains("*.aside-*"),
                "missing aside note in dialog: {msg}"
            );
            assert_eq!(shown_dialog.buttons.len(), 1);
            assert_eq!(shown_dialog.buttons[0].text, "Restart");
            assert!(!shown_dialog.cancelable);
            assert!(!shown_dialog.sheet);

            // While the dialog is open, MaintenanceLock stays sealed: restart refuses and starts no Host.
            let restart_err = restart_shell_sync(&shell)
                .expect_err("restart must refuse while handover dialog is open");
            assert_eq!(restart_err.code(), Some("maintenance_busy"));
            assert_eq!(count_lines(&spawns_log), 1);

            // User clicks "Restart" on the native alert dialog.
            let handled = core.component_event(
                ROOT_ID,
                EventKind::Dialog,
                &EventPayload::Map(vec![
                    ("id", PayloadValue::Number(f64::from(shown_dialog.id))),
                    ("index", PayloadValue::Number(0.0)),
                ]),
            );
            assert!(
                handled,
                "Core must route EventKind::Dialog to pending DialogAnswer"
            );
            core.run_component_tasks();
            let after_batch = core.commit().expect("commit after dialog dismissal");

            let saw_restart = after_batch.items.iter().any(|item| {
                matches!(
                    item,
                    MountItem::Command {
                        id,
                        command: Command::Desktop(desktop)
                    } if *id == ROOT_ID && matches!(desktop.as_ref(), DesktopCommand::Restart)
                )
            });
            assert!(
                saw_restart,
                "desktop::restart() must fire immediately after user dismisses the recovery refusal dialog"
            );
            assert!(
                !after_batch.items.iter().any(|item| {
                    matches!(
                        item,
                        MountItem::Command {
                            id,
                            command: Command::CloseDialog(_) | Command::Desktop(_)
                        } if *id == ROOT_ID
                            && !matches!(
                                item,
                                MountItem::Command {
                                    command: Command::Desktop(desktop),
                                    ..
                                } if matches!(desktop.as_ref(), DesktopCommand::Restart)
                            )
                    )
                }),
                "ordinary dialog acknowledgement must not emit CloseDialog or desktop::quit()"
            );

            let final_err = result_slot
                .lock()
                .unwrap()
                .take()
                .expect("recovery call resolves after dialog dismissal")
                .expect_err("recovery refusal must still reject with coded JsError");
            assert_eq!(final_err.code(), Some(expected_code));
            assert!(shell.maintenance.is_handed_over());
            assert_eq!(count_lines(&spawns_log), 1);
        }
    }

    #[test]
    fn quit_during_recovery_refusal_dialog_closes_dialog_and_quits_without_restart_while_handover_sealed()
     {
        use std::sync::Mutex;

        let tmp = TestTempDir::new("byok-adapter-dialog-quit");
        let contract = BridgeContract::load().expect("contract loads");

        let write_fail_mock = |name: &str,
                               store_refused: bool,
                               fail_restore: bool,
                               fail_start_fresh: bool|
         -> (HostCommandSpec, PathBuf) {
            let spawns_log = tmp.path().join(format!("{name}-spawns.log"));
            let script = format!(
                r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: {{ version: arg1, target: '/tmp/snap' }} }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  if ({fail_restore}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'restore_failed',
      message: 'not enough space to stage snapshot',
      movedBack: true,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{ ok: true, asidePath: '/tmp/ok.aside' }}) + '\n');
  process.exit(0);
}}
if (subcmd === {start_fresh_cmd}) {{
  if ({fail_start_fresh}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'clear_failed',
      message: 'enrollment revoke refused',
      movedBack: false,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{ ok: true, moved: [] }}) + '\n');
  process.exit(0);
}}
fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'stopped', pid: process.pid, storeRefused: {store_refused}, reason: 'stopped' }},
    }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
                snapshot_status_cmd =
                    serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
                restore_cmd = serde_json::to_string(&contract.host_commands.restore).unwrap(),
                start_fresh_cmd =
                    serde_json::to_string(&contract.host_commands.start_fresh).unwrap(),
                spawns_log =
                    serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            );
            let script_path = tmp.path().join(format!("{name}.mjs"));
            fs::write(&script_path, script).expect("write fail mock");
            (HostCommandSpec::dev_node_host(script_path), spawns_log)
        };

        let count_lines = |path: &Path| -> usize {
            fs::read_to_string(path)
                .map(|text| text.lines().filter(|line| !line.is_empty()).count())
                .unwrap_or(0)
        };

        // Drive system/user quit (`WindowEvent::QuitRequest`) while the native recovery-refusal
        // dialog is open for both `shell.restore` (`restore_failed`) and `shell.startFresh` (`clear_failed`).
        for (case_name, store_refused, expected_code) in [
            ("restore-quit-dialog", false, "restore_failed"),
            ("fresh-quit-dialog", true, "clear_failed"),
        ] {
            let (spec, spawns_log) =
                write_fail_mock(case_name, store_refused, !store_refused, store_refused);
            let shell = build_runtime_shell(spec, "1.0.0", true).expect("shell starts");
            assert!(wait_until(Duration::from_secs(5), || {
                matches!(
                    shell.supervisor.last_state(),
                    Some(SupervisedHostState::Stopped {
                        store_refused: sr,
                        ..
                    }) if sr == store_refused
                )
            }));
            assert_eq!(count_lines(&spawns_log), 1);

            type PendingRecoveryOutcome =
                Arc<Mutex<Option<(Result<JsonValue, byok_shell::ShellRouteError>, bool)>>>;
            type RecoveryResultSlot = Arc<Mutex<Option<Result<JsonValue, JsError>>>>;

            let result_slot: RecoveryResultSlot = Arc::new(Mutex::new(None));
            let quit_handler_outcome = Arc::new(Mutex::new(None::<QuitOutcome>));
            let quit_handler_stops = Arc::new(AtomicUsize::new(0));
            let pending_outcome: PendingRecoveryOutcome =
                Arc::new(Mutex::new(Some(if !store_refused {
                    let (out, relaunched) = execute_restore_sync(
                        &shell.router,
                        &shell.app_version,
                        "2026-11-25T00-04-30.000Z",
                    );
                    (out.map(|v| serde_json::to_value(v).unwrap()), relaunched)
                } else {
                    let (out, relaunched) =
                        execute_start_fresh_sync(&shell.router, "2026-11-25T00-04-30.000Z");
                    (out.map(|v| serde_json::to_value(v).unwrap()), relaunched)
                })));

            assert!(shell.maintenance.is_handed_over());

            type QuitDialogHarnessState = (
                PendingRecoveryOutcome,
                crate::supervisor::RuntimeShell,
                RecoveryResultSlot,
                Arc<Mutex<Option<QuitOutcome>>>,
                Arc<AtomicUsize>,
            );
            thread_local! {
                static PENDING_QUIT_CALL: std::cell::RefCell<Option<QuitDialogHarnessState>> =
                    const { std::cell::RefCell::new(None) };
            }
            PENDING_QUIT_CALL.with(|cell| {
                *cell.borrow_mut() = Some((
                    Arc::clone(&pending_outcome),
                    shell.clone(),
                    Arc::clone(&result_slot),
                    Arc::clone(&quit_handler_outcome),
                    Arc::clone(&quit_handler_stops),
                ));
            });

            #[component]
            fn RecoveryDialogQuitHarness() -> impl IntoElement {
                if let Some((input, shell, output, outcome_slot, stop_counter)) =
                    PENDING_QUIT_CALL.with(|cell| cell.borrow_mut().take())
                {
                    let shell_for_quit = shell.clone();
                    on_quit_request(move || {
                        let outcome = drain_for_quit_with(&shell_for_quit.maintenance, || {
                            stop_counter.fetch_add(1, Ordering::SeqCst);
                            shell_for_quit.supervisor.stop()
                        });
                        *outcome_slot.lock().unwrap() = Some(outcome);
                        if should_call_desktop_quit(outcome) {
                            quit();
                        }
                    });
                    spawn(async move {
                        let (out, relaunched) = input.lock().unwrap().take().unwrap();
                        let res = finish_recovery_call(
                            out,
                            relaunched,
                            &shell.maintenance,
                            open_recovery_failure_dialog,
                            restart,
                            quit,
                        )
                        .await;
                        *output.lock().unwrap() = Some(res);
                    });
                }
                view()
            }

            let mut core = Core::new(ApproxTextEngine, size(px(800.0), px(600.0)));
            core.mount_root(&Root::of::<RecoveryDialogQuitHarness>());
            let first_batch = core.commit().expect("initial commit");
            core.run_component_tasks();
            let second_batch = core.commit();

            let mut open_commands = Vec::new();
            for batch in [Some(first_batch), second_batch].into_iter().flatten() {
                for item in batch.items {
                    if let MountItem::Command { id, command } = item
                        && id == ROOT_ID
                    {
                        open_commands.push(command);
                    }
                }
            }

            let shown_dialog = open_commands
                .iter()
                .find_map(|cmd| match cmd {
                    Command::Dialog(dlg) => Some(dlg.clone()),
                    _ => None,
                })
                .expect("recovery refusal dialog must open on ROOT_ID");
            assert!(
                result_slot.lock().unwrap().is_none(),
                "recovery call must stay pending while dialog is open"
            );

            // Leave the dialog unanswered and deliver a system/user QuitRequest (e.g. macOS Log Out / Shut Down).
            core.component_event(
                ROOT_ID,
                EventKind::Window,
                &EventPayload::Window(Box::new(WindowEvent::QuitRequest)),
            );
            core.run_component_tasks();
            let after_batch = core.commit().expect("commit after quit during dialog");

            // Quit handler saw confirmed handover, skipped a second Host stop, and deferred exit to recovery.
            assert_eq!(
                *quit_handler_outcome.lock().unwrap(),
                Some(QuitOutcome::HandedOver)
            );
            assert_eq!(quit_handler_stops.load(Ordering::SeqCst), 0);

            let root_commands: Vec<&Command> = after_batch
                .items
                .iter()
                .filter_map(|item| match item {
                    MountItem::Command { id, command } if *id == ROOT_ID => Some(command),
                    _ => None,
                })
                .collect();

            let close_pos = root_commands
                .iter()
                .position(|cmd| matches!(cmd, Command::CloseDialog(id) if *id == shown_dialog.id))
                .expect("quit during pending refusal dialog must emit Command::CloseDialog(id)");
            let quit_pos = root_commands
                .iter()
                .position(|cmd| {
                    matches!(
                        cmd,
                        Command::Desktop(desktop) if matches!(desktop.as_ref(), DesktopCommand::Quit)
                    )
                })
                .expect("quit during pending refusal dialog must emit DesktopCommand::Quit");
            assert!(
                close_pos < quit_pos,
                "Command::CloseDialog must precede DesktopCommand::Quit: {root_commands:?}"
            );
            assert!(
                !root_commands.iter().any(|cmd| {
                    matches!(
                        cmd,
                        Command::Desktop(desktop) if matches!(desktop.as_ref(), DesktopCommand::Restart)
                    )
                }),
                "quit during pending refusal dialog must NOT emit DesktopCommand::Restart"
            );

            let final_err = result_slot
                .lock()
                .unwrap()
                .take()
                .expect("recovery call must resolve once quit closes the refusal dialog")
                .expect_err("recovery refusal must still reject with coded JsError");
            assert_eq!(final_err.code(), Some(expected_code));
            assert!(
                shell.maintenance.is_handed_over(),
                "handover must stay sealed through quit"
            );
            let restart_err = restart_shell_sync(&shell)
                .expect_err("Host restart must stay refused while handover and quit are active");
            assert_eq!(restart_err.code(), Some("maintenance_busy"));
            assert_eq!(count_lines(&spawns_log), 1);
        }
    }

    #[test]
    fn quit_while_recovery_draining_routes_to_desktop_quit_without_dialog_or_restart() {
        let tmp = TestTempDir::new("byok-adapter-quit-during-drain");
        let contract = BridgeContract::load().expect("contract loads");

        let count_lines = |path: &Path| -> usize {
            fs::read_to_string(path)
                .map(|text| text.lines().filter(|line| !line.is_empty()).count())
                .unwrap_or(0)
        };

        for (case_name, fail_restore) in [("drain-fail", true), ("drain-ok", false)] {
            let spawns_log = tmp.path().join(format!("{case_name}-spawns.log"));
            let entered_marker = tmp.path().join(format!("{case_name}-entered"));
            let release_marker = tmp.path().join(format!("{case_name}-release"));
            let script = format!(
                r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: {{ version: arg1, target: '/tmp/snap' }} }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  const tmpEntered = {entered} + '.tmp';
  fs.writeFileSync(tmpEntered, 'entered');
  fs.renameSync(tmpEntered, {entered});
  const timer = setInterval(() => {{
    if (fs.existsSync({release})) {{
      clearInterval(timer);
      if ({fail_restore}) {{
        process.stdout.write(JSON.stringify({{
          ok: false,
          code: 'restore_failed',
          message: 'disk full while staging snapshot',
          movedBack: true,
        }}) + '\n');
        process.exit(1);
      }}
      process.stdout.write(JSON.stringify({{ ok: true, asidePath: '/tmp/drained.aside' }}) + '\n');
      process.exit(0);
    }}
  }}, 10);
}} else {{
  fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
  const rl = readline.createInterface({{ input: process.stdin }});
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {{
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
      process.stdout.write(JSON.stringify({{
        event: 'state',
        state: {{ state: 'stopped', pid: process.pid, storeRefused: false, reason: 'stopped' }},
      }}) + '\n');
    }} else if (msg.method === 'shutdown') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
      process.exit(0);
    }}
  }});
}}
"#,
                snapshot_status_cmd =
                    serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
                restore_cmd = serde_json::to_string(&contract.host_commands.restore).unwrap(),
                entered =
                    serde_json::to_string(&entered_marker.to_string_lossy().into_owned()).unwrap(),
                release =
                    serde_json::to_string(&release_marker.to_string_lossy().into_owned()).unwrap(),
                spawns_log =
                    serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            );
            let script_path = tmp.path().join(format!("{case_name}.mjs"));
            fs::write(&script_path, script).expect("write drain mock");
            let shell = build_runtime_shell(HostCommandSpec::dev_node_host(script_path), "1.0.0", true)
                .expect("shell starts");
            assert!(wait_until(Duration::from_secs(5), || {
                matches!(
                    shell.supervisor.last_state(),
                    Some(SupervisedHostState::Stopped {
                        store_refused: false,
                        ..
                    })
                )
            }));
            assert_eq!(count_lines(&spawns_log), 1);

            let restore_shell = shell.clone();
            let restore_handle = std::thread::spawn(move || {
                execute_restore_sync(
                    &restore_shell.router,
                    &restore_shell.app_version,
                    "2026-11-25T00-04-45.000Z",
                )
            });
            assert!(
                wait_until(Duration::from_secs(5), || entered_marker.exists()),
                "restore must reach barrier while holding MaintenanceLock"
            );

            // Quit arrives while recovery is still moving stores (`busy == true`).
            let (quit_marked_tx, quit_marked_rx) = std::sync::mpsc::channel();
            shell.maintenance.on_quit_requested(move || {
                let _ = quit_marked_tx.send(());
            });
            let quit_shell = shell.clone();
            let extra_stops = Arc::new(AtomicUsize::new(0));
            let extra_stops_bg = Arc::clone(&extra_stops);
            let quit_handle = std::thread::spawn(move || {
                drain_for_quit_with(&quit_shell.maintenance, || {
                    extra_stops_bg.fetch_add(1, Ordering::SeqCst);
                    quit_shell.supervisor.stop()
                })
            });
            quit_marked_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("quit drain marks quitting immediately while waiting on recovery");
            assert!(
                !quit_handle.is_finished(),
                "quit drain must wait until recovery finishes moving stores"
            );

            fs::write(&release_marker, "go").expect("release recovery barrier");
            let (out, relaunched) = restore_handle.join().expect("restore thread joins");
            assert!(relaunched);
            assert_eq!(
                quit_handle.join().expect("quit thread joins"),
                QuitOutcome::HandedOver
            );
            assert_eq!(extra_stops.load(Ordering::SeqCst), 0);
            assert!(shell.maintenance.is_handed_over());

            let mut restart_calls = 0usize;
            let mut quit_calls = 0usize;
            let res = poll_ready(finish_recovery_call(
                out,
                relaunched,
                &shell.maintenance,
                |_| {
                    panic!("must not open blocking dialog when quit was already requested during recovery drain");
                    #[allow(unreachable_code)]
                    (std::future::ready(DialogReply::dismissed()), || {})
                },
                || {
                    restart_calls += 1;
                },
                || {
                    quit_calls += 1;
                },
            ));
            if fail_restore {
                assert_eq!(res.expect_err("restore refusal surfaces code").code(), Some("restore_failed"));
            } else {
                assert_eq!(res.expect("restore ok")["asidePath"], "/tmp/drained.aside");
            }
            assert_eq!(
                restart_calls, 0,
                "must not call desktop::restart() when quit was requested during recovery"
            );
            assert_eq!(
                quit_calls, 1,
                "must call desktop::quit() once recovery drained with handover still sealed"
            );
            assert!(shell.maintenance.is_handed_over());
            assert_eq!(
                restart_shell_sync(&shell)
                    .expect_err("restart stays refused")
                    .code(),
                Some("maintenance_busy")
            );
            assert_eq!(count_lines(&spawns_log), 1);
        }

        // Pre-stop precondition refusal after quit already marked: `relaunched == false`, so
        // `finish_recovery_call` must call neither dialog nor restart nor quit (quit drain owns exit).
        let pre_lock = MaintenanceLock::new();
        pre_lock.mark_quitting();
        let mut pre_restarts = 0usize;
        let mut pre_quits = 0usize;
        let pre_err = poll_ready(finish_recovery_call::<JsonValue, _, _, _, _, _>(
            Err(byok_shell::ShellRouteError::new(
                "precondition_failed",
                "Restore is offered only while the Host is stopped",
            )),
            false,
            &pre_lock,
            |_| {
                panic!("pre-stop refusal must not show dialog");
                #[allow(unreachable_code)]
                (std::future::ready(DialogReply::dismissed()), || {})
            },
            || {
                pre_restarts += 1;
            },
            || {
                pre_quits += 1;
            },
        ))
        .expect_err("pre-stop refusal returns coded error");
        assert_eq!(pre_err.code(), Some("precondition_failed"));
        assert_eq!(pre_restarts, 0);
        assert_eq!(pre_quits, 0);

        // Race branch: quit marked right as dialog opens (before first poll) still closes dialog
        // via closer and routes to on_quit() without calling on_restart().
        let race_lock = MaintenanceLock::new();
        let events = std::cell::RefCell::new(Vec::new());
        let race_err = poll_ready(finish_recovery_call::<JsonValue, _, _, _, _, _>(
            Err(byok_shell::ShellRouteError::new(
                "restore_failed",
                "disk full",
            )),
            true,
            &race_lock,
            |_| {
                events.borrow_mut().push("open_dialog");
                race_lock.mark_quitting();
                (std::future::pending::<DialogReply>(), || {
                    events.borrow_mut().push("close_dialog");
                })
            },
            || {
                events.borrow_mut().push("restart");
            },
            || {
                events.borrow_mut().push("quit");
            },
        ))
        .expect_err("refusal surfaces coded error");
        assert_eq!(race_err.code(), Some("restore_failed"));
        assert_eq!(*events.borrow(), vec!["open_dialog", "close_dialog", "quit"]);

        // Task cancellation while dialog is pending closes the dialog on drop without restart/quit.
        let drop_lock = MaintenanceLock::new();
        let drop_events = std::cell::RefCell::new(Vec::new());
        {
            let mut fut = pin!(finish_recovery_call::<JsonValue, _, _, _, _, _>(
                Err(byok_shell::ShellRouteError::new(
                    "clear_failed",
                    "revoke denied",
                )),
                true,
                &drop_lock,
                |_| {
                    drop_events.borrow_mut().push("open_dialog");
                    (std::future::pending::<DialogReply>(), || {
                        drop_events.borrow_mut().push("close_dialog");
                    })
                },
                || {
                    drop_events.borrow_mut().push("restart");
                },
                || {
                    drop_events.borrow_mut().push("quit");
                },
            ));
            let waker = Waker::noop();
            let mut cx = Context::from_waker(waker);
            assert!(matches!(fut.as_mut().poll(&mut cx), Poll::Pending));
        }
        assert_eq!(*drop_events.borrow(), vec!["open_dialog", "close_dialog"]);

        // EventHub quitting hook mirrors `ShellEvent::Quitting` into MaintenanceLock synchronously.
        let hub_lock = MaintenanceLock::new();
        let hub_lock_hook = hub_lock.clone();
        let hub = EventHub::with_quitting_hook(move || hub_lock_hook.mark_quitting());
        let (_sub_id, rx) = hub.subscribe();
        hub.publish(ShellEvent::StateHint);
        assert!(!hub_lock.is_quitting());
        hub.publish(ShellEvent::Quitting);
        assert!(hub_lock.is_quitting());
        assert!(matches!(rx.recv().unwrap(), ShellEvent::StateHint));
        assert!(matches!(rx.recv().unwrap(), ShellEvent::Quitting));
    }

    #[test]
    fn adapter_restart_guard_refuses_during_barrier_handover_quit_and_allows_after_precondition_error()
     {
        let tmp = TestTempDir::new("byok-adapter-restart-guard");
        let contract = BridgeContract::load().expect("contract loads");

        let count_lines = |path: &Path| -> usize {
            fs::read_to_string(path)
                .map(|text| text.lines().filter(|line| !line.is_empty()).count())
                .unwrap_or(0)
        };

        // 1. Barrier test through adapter's `restart_shell_sync` and `execute_restore_sync`.
        let store_path = tmp.path().join("adapter-store.json");
        let aside_path = tmp.path().join("adapter-store.json.aside");
        fs::write(&store_path, "before-restore").expect("seed store");
        let spawns_log = tmp.path().join("barrier-spawns.log");
        let shutdowns_log = tmp.path().join("barrier-shutdowns.log");
        let entered_marker = tmp.path().join("barrier-entered");
        let release_marker = tmp.path().join("barrier-release");

        let barrier_script = format!(
            r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: {{ version: arg1, target: '/tmp/snap' }} }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  const tmpEntered = {entered} + '.tmp';
  fs.writeFileSync(tmpEntered, 'entered');
  fs.renameSync(tmpEntered, {entered});
  const timer = setInterval(() => {{
    if (fs.existsSync({release})) {{
      clearInterval(timer);
      fs.renameSync({store_path}, {aside_path});
      fs.writeFileSync({store_path}, 'after-restore');
      process.stdout.write(JSON.stringify({{ ok: true, asidePath: {aside_path} }}) + '\n');
      process.exit(0);
    }}
  }}, 10);
}} else {{
  fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
  const rl = readline.createInterface({{ input: process.stdin }});
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {{
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
      process.stdout.write(JSON.stringify({{
        event: 'state',
        state: {{ state: 'stopped', pid: process.pid, storeRefused: false, reason: 'stopped' }},
      }}) + '\n');
    }} else if (msg.method === 'shutdown') {{
      fs.appendFileSync({shutdowns_log}, String(process.pid) + '\n');
      process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
      process.exit(0);
    }}
  }});
}}
"#,
            snapshot_status_cmd =
                serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
            restore_cmd = serde_json::to_string(&contract.host_commands.restore).unwrap(),
            entered =
                serde_json::to_string(&entered_marker.to_string_lossy().into_owned()).unwrap(),
            release =
                serde_json::to_string(&release_marker.to_string_lossy().into_owned()).unwrap(),
            store_path = serde_json::to_string(&store_path.to_string_lossy().into_owned()).unwrap(),
            aside_path = serde_json::to_string(&aside_path.to_string_lossy().into_owned()).unwrap(),
            spawns_log = serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            shutdowns_log =
                serde_json::to_string(&shutdowns_log.to_string_lossy().into_owned()).unwrap(),
        );
        let barrier_script_path = tmp.path().join("adapter-barrier.mjs");
        fs::write(&barrier_script_path, barrier_script).expect("write barrier script");
        let shell = build_runtime_shell(
            HostCommandSpec::dev_node_host(barrier_script_path),
            "1.0.0",
            true,
        )
        .expect("shell starts");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                shell.supervisor.last_state(),
                Some(SupervisedHostState::Stopped {
                    store_refused: false,
                    ..
                })
            )
        }));
        assert_eq!(count_lines(&spawns_log), 1);

        let shell_bg = shell.clone();
        let restore_handle = std::thread::spawn(move || {
            execute_restore_sync(
                &shell_bg.router,
                &shell_bg.app_version,
                "2026-11-25T00-05-00.000Z",
            )
        });

        assert!(
            wait_until(Duration::from_secs(5), || entered_marker.exists()),
            "restore must reach barrier after Host stop"
        );
        assert_eq!(count_lines(&shutdowns_log), 1);
        assert_eq!(fs::read_to_string(&store_path).unwrap(), "before-restore");

        let busy_err = restart_shell_sync(&shell)
            .expect_err("adapter restart must refuse while restore holds MaintenanceLock");
        assert_eq!(busy_err.code(), Some("maintenance_busy"));
        assert_eq!(
            count_lines(&spawns_log),
            1,
            "refused adapter restart must not start a new Host"
        );

        fs::write(&release_marker, "go").expect("release barrier");
        let (out, relaunched) = restore_handle.join().expect("restore thread joins");
        assert!(relaunched);
        let mut restart_calls = 0usize;
        let mut quit_calls = 0usize;
        let payload = poll_ready(finish_recovery_call(
            out,
            relaunched,
            &shell.maintenance,
            |_| {
                panic!("successful restore must not show failure dialog");
                #[allow(unreachable_code)]
                (std::future::ready(DialogReply::dismissed()), || {})
            },
            || {
                restart_calls += 1;
            },
            || {
                quit_calls += 1;
            },
        ))
        .expect("restore succeeds");
        assert_eq!(payload["asidePath"], aside_path.to_string_lossy().as_ref());
        assert_eq!(restart_calls, 1);
        assert_eq!(quit_calls, 0);
        assert!(shell.maintenance.is_handed_over());

        let post_handover_err = restart_shell_sync(&shell)
            .expect_err("adapter restart must stay refused after handover");
        assert_eq!(post_handover_err.code(), Some("maintenance_busy"));
        assert_eq!(count_lines(&spawns_log), 1);

        // 2. Recoverable precondition error releases lock so adapter restart succeeds; quit refuses it.
        let precond_spawns = tmp.path().join("precond-spawns.log");
        let precond_script = format!(
            r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: null }}) + '\n');
  process.exit(0);
}}
fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'stopped', pid: process.pid, storeRefused: false, reason: 'stopped' }},
    }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            snapshot_status_cmd =
                serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
            spawns_log =
                serde_json::to_string(&precond_spawns.to_string_lossy().into_owned()).unwrap(),
        );
        let precond_script_path = tmp.path().join("adapter-precond.mjs");
        fs::write(&precond_script_path, precond_script).expect("write precond script");
        let precond_shell = build_runtime_shell(
            HostCommandSpec::dev_node_host(precond_script_path),
            "1.0.0",
            true,
        )
        .expect("shell starts");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                precond_shell.supervisor.last_state(),
                Some(SupervisedHostState::Stopped {
                    store_refused: false,
                    ..
                })
            )
        }));
        let initial_pid = match precond_shell.supervisor.last_state() {
            Some(SupervisedHostState::Stopped { pid, .. }) => pid,
            other => panic!("expected stopped state, got {other:?}"),
        };
        assert_eq!(count_lines(&precond_spawns), 1);

        let (missing_out, missing_relaunched) = execute_restore_sync(
            &precond_shell.router,
            &precond_shell.app_version,
            "2026-11-25T00-06-00.000Z",
        );
        assert!(!missing_relaunched);
        let missing_err = missing_out.expect_err("missing snapshot must refuse");
        assert_eq!(missing_err.code, "missing_snapshot");

        restart_shell_sync(&precond_shell)
            .expect("adapter restart must succeed after recoverable precondition error");
        assert!(
            wait_until(Duration::from_secs(5), || {
                matches!(
                    precond_shell.supervisor.last_state(),
                    Some(SupervisedHostState::Stopped { pid, .. }) if pid != initial_pid
                )
            }),
            "allowed adapter restart must spawn and connect a new Host"
        );
        assert_eq!(count_lines(&precond_spawns), 2);

        assert_eq!(
            drain_for_quit(&precond_shell.maintenance, &precond_shell.supervisor),
            QuitOutcome::Quit
        );
        let quit_err = restart_shell_sync(&precond_shell)
            .expect_err("adapter restart must refuse once quit holds MaintenanceLock");
        assert_eq!(quit_err.code(), Some("maintenance_busy"));
        assert_eq!(count_lines(&precond_spawns), 2);
    }

    #[test]
    fn fallback_app_quit_cleanup_runs_on_quit_timeout_path_drains_once_and_guards_reentry() {
        use std::future::Future;
        use std::pin::Pin;
        use std::sync::{Mutex, mpsc};

        // ADR-052 D2: Windows/Linux OS shutdown runs `on_app_quit` under upstream 200 ms `QUIT_TIMEOUT`.
        assert_eq!(QUIT_TIMEOUT, Duration::from_millis(200));

        struct OffThreadDrainFuture {
            state: Arc<Mutex<(bool, Option<Waker>)>>,
        }

        impl OffThreadDrainFuture {
            fn spawn(work: Box<dyn FnOnce() -> QuitOutcome + Send>, runs: Arc<AtomicUsize>) -> Self {
                let state = Arc::new(Mutex::new((false, None::<Waker>)));
                let bg_state = Arc::clone(&state);
                std::thread::spawn(move || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    let _ = work();
                    let waker = {
                        let mut guard = bg_state.lock().expect("drain future state lock poisoned");
                        guard.0 = true;
                        guard.1.take()
                    };
                    if let Some(waker) = waker {
                        waker.wake();
                    }
                });
                Self { state }
            }
        }

        impl Future for OffThreadDrainFuture {
            type Output = ();

            fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
                let mut guard = self.state.lock().expect("drain future state lock poisoned");
                if guard.0 {
                    Poll::Ready(())
                } else {
                    guard.1 = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }

        let tmp = TestTempDir::new("byok-adapter-d2-fallback-quit");
        let spawns_log = tmp.path().join("spawns.log");
        let shutdowns_log = tmp.path().join("shutdowns.log");
        let script = format!(
            r#"
import fs from 'node:fs';
import readline from 'node:readline';

fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 4 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'stopped', pid: process.pid, storeRefused: false, reason: 'stopped' }},
    }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    fs.appendFileSync({shutdowns_log}, String(process.pid) + '\n');
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            spawns_log =
                serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            shutdowns_log =
                serde_json::to_string(&shutdowns_log.to_string_lossy().into_owned()).unwrap(),
        );
        let script_path = tmp.path().join("host.mjs");
        fs::write(&script_path, script).expect("write mock host");

        let read_logged_pids = |path: &Path| -> Vec<u32> {
            fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        };

        let contract = BridgeContract::load().expect("contract loads");
        let maintenance = MaintenanceLock::new();
        let (state_tx, state_rx) = mpsc::channel();
        let supervisor = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(HostCommandSpec::dev_node_host(script_path), contract)
                .with_maintenance_lock(maintenance.clone()),
            move |state| {
                let _ = state_tx.send(state);
            },
            || {},
        ));
        let router = Arc::new(ShellRouter::new(
            Arc::clone(&supervisor),
            maintenance.clone(),
            "1.0.0",
        ));
        supervisor.start();
        let shell = RuntimeShell {
            supervisor,
            maintenance,
            router,
            app_version: "1.0.0".to_owned(),
        };

        let host_pid = loop {
            match state_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("mock host must emit initial stopped state")
            {
                SupervisedHostState::Stopped { pid, .. } => break pid,
                _ => continue,
            }
        };
        assert_eq!(read_logged_pids(&spawns_log), vec![host_pid]);

        let shell_for_hook = shell.clone();
        let hub = Arc::new(EventHub::with_quitting_hook(move || {
            shell_for_hook.maintenance.mark_quitting();
        }));
        let (_sub_id, events_rx) = hub.subscribe();
        let quitting = Arc::new(AtomicBool::new(false));
        let get_shell_calls = Arc::new(AtomicUsize::new(0));
        let drain_runs = Arc::new(AtomicUsize::new(0));

        type FallbackQuitHarnessState = (
            Arc<AtomicBool>,
            Arc<EventHub>,
            RuntimeShell,
            Arc<AtomicUsize>,
            Arc<AtomicUsize>,
        );
        thread_local! {
            static PENDING_FALLBACK_QUIT: std::cell::RefCell<Option<FallbackQuitHarnessState>> =
                const { std::cell::RefCell::new(None) };
        }
        PENDING_FALLBACK_QUIT.with(|cell| {
            *cell.borrow_mut() = Some((
                Arc::clone(&quitting),
                Arc::clone(&hub),
                shell.clone(),
                Arc::clone(&get_shell_calls),
                Arc::clone(&drain_runs),
            ));
        });

        #[component]
        fn FallbackQuitHarness() -> impl IntoElement {
            if let Some((quitting, hub, shell, get_shell_calls, drain_runs)) =
                PENDING_FALLBACK_QUIT.with(|cell| cell.borrow_mut().take())
            {
                on_app_quit(move || {
                    let quitting = Arc::clone(&quitting);
                    let hub = Arc::clone(&hub);
                    let shell = shell.clone();
                    let get_shell_calls = Arc::clone(&get_shell_calls);
                    let drain_runs = Arc::clone(&drain_runs);
                    async move {
                        fallback_app_quit_cleanup_with(
                            quitting,
                            &hub,
                            move || {
                                get_shell_calls.fetch_add(1, Ordering::SeqCst);
                                Some(shell)
                            },
                            move |work| OffThreadDrainFuture::spawn(work, drain_runs),
                        )
                        .await;
                    }
                });
            }
            view()
        }

        let (wake_tx, wake_rx) = mpsc::channel::<()>();
        let mut core = Core::new(ApproxTextEngine, size(px(800.0), px(600.0)));
        core.set_task_notify(Arc::new(move || {
            let _ = wake_tx.send(());
        }));
        core.mount_root(&Root::of::<FallbackQuitHarness>());
        core.commit();
        assert!(core.has_quit_listeners());
        assert!(!shell.maintenance.is_quitting());
        assert!(events_rx.try_recv().is_err());

        // 1. First `on_app_quit` call (Windows/Linux `QUIT_TIMEOUT` path): publishes `Quitting`
        //    once and drains the active shell (marks MaintenanceLock quitting + stops Host).
        assert!(
            core.start_quit(),
            "Core::start_quit must start registered on_app_quit fallback cleanup"
        );
        core.run_component_tasks();
        assert!(quitting.load(Ordering::Acquire));
        assert!(
            matches!(events_rx.try_recv(), Ok(ShellEvent::Quitting)),
            "fallback_app_quit_cleanup must publish ShellEvent::Quitting once"
        );
        assert!(
            events_rx.try_recv().is_err(),
            "fallback_app_quit_cleanup must not publish duplicate Quitting events"
        );
        assert!(shell.maintenance.is_quitting());

        let deadline = Instant::now() + Duration::from_secs(5);
        while core.quit_pending() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("fallback_app_quit_cleanup drain must finish cleanly");
            wake_rx
                .recv_timeout(remaining)
                .expect("off-thread shell drain must wake Core");
            core.run_component_tasks();
        }
        assert!(!core.quit_pending());
        assert_eq!(get_shell_calls.load(Ordering::SeqCst), 1);
        assert_eq!(drain_runs.load(Ordering::SeqCst), 1);
        assert_eq!(read_logged_pids(&shutdowns_log), vec![host_pid]);
        assert_eq!(read_logged_pids(&spawns_log), vec![host_pid]);
        assert!(shell.supervisor.stop().is_ok());

        // 2. Second call returns at once via the `quitting` swap guard (no second event or drain).
        let second_shell_calls = Arc::new(AtomicUsize::new(0));
        let second_drain_runs = Arc::new(AtomicUsize::new(0));
        poll_ready(fallback_app_quit_cleanup_with(
            Arc::clone(&quitting),
            &hub,
            || {
                second_shell_calls.fetch_add(1, Ordering::SeqCst);
                Some(shell.clone())
            },
            |_| {
                second_drain_runs.fetch_add(1, Ordering::SeqCst);
                std::future::ready(())
            },
        ));
        assert_eq!(second_shell_calls.load(Ordering::SeqCst), 0);
        assert_eq!(second_drain_runs.load(Ordering::SeqCst), 0);
        assert!(events_rx.try_recv().is_err());

        // Re-firing `Core::start_quit()` through `on_app_quit` also settles immediately on poll 1.
        assert!(core.start_quit());
        core.run_component_tasks();
        assert!(
            !core.quit_pending(),
            "re-entrant on_app_quit call must return immediately without scheduling a second drain"
        );
        assert_eq!(get_shell_calls.load(Ordering::SeqCst), 1);
        assert_eq!(drain_runs.load(Ordering::SeqCst), 1);
        assert!(events_rx.try_recv().is_err());
    }
}
