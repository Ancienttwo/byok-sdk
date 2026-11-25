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
        QuitOutcome, SupervisedHostState,
    };
    use nsh_core::JsonValue;
    use nsh_core::element::{Os, declarations};

    use crate::bridge::{
        execute_restore_sync, execute_start_fresh_sync, finish_recovery_call, format_utc_stamp,
        handle_login_item_get_with, handle_login_item_set_with, parse_login_item_set_param,
        validate_renderer_method,
    };
    use crate::quit::{drain_for_quit, drain_for_quit_with, should_call_desktop_quit};
    use crate::supervisor::{EventHub, ShellEvent, build_runtime_shell};

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
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 2 }} }}) + '\n');
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
        let payload = finish_recovery_call(out, relaunched, || {
            restart_calls += 1;
        })
        .expect("restore JSON payload");
        assert_eq!(payload["asidePath"], "/tmp/adapter-restored.aside");
        assert_eq!(restart_calls, 1);
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
        let payload = finish_recovery_call(out, relaunched, || {
            fresh_restart_calls += 1;
        })
        .expect("startFresh JSON payload");
        assert_eq!(payload["moved"].as_array().map(Vec::len), Some(1));
        assert_eq!(fresh_restart_calls, 1);
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

        // 3. Pre-stop refusal does NOT call restart() or seal lock; post-stop refusal DOES.
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
        let pre_err = finish_recovery_call(pre_out, pre_relaunched, || {
            pre_restarts += 1;
        })
        .expect_err("startFresh without storeRefused must fail precondition");
        assert_eq!(pre_err.code(), Some("precondition_failed"));
        assert_eq!(pre_restarts, 0);
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
        let mut post_restarts = 0usize;
        let post_err = finish_recovery_call(post_out, post_relaunched, || {
            post_restarts += 1;
        })
        .expect_err("restore refusal surfaces bridge error code");
        assert_eq!(post_err.code(), Some("restore_failed"));
        assert_eq!(post_restarts, 1);
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
}
