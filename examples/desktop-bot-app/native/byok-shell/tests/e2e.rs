use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use byok_shell::{
    BridgeClient, BridgeContract, BridgeErrorCode, EXPECTED_BRIDGE_VERSION,
    FOREIGN_RUNTIME_VARIABLES, HostCommandSpec,
    HostState, HostSupervisor, HostSupervisorConfig, KeepAwake, KeepAwakeBackend, KeepAwakeGuard,
    LinuxInhibitBackend, MaintenanceBusyError, MaintenanceLock, PowerError, QuitOutcome,
    SecretBytes, ShellRouter, SupervisedHostState, filter_env_pairs, list_from_custody,
    run_restore, run_snapshot, run_snapshot_status, select_linux_backend, shell_restore,
    shell_start_fresh, spawn_host_child, submit_to_custody,
};
use byok_shell::update::{HandoverOutcome, SwapOutcome, UpdateInstaller, handover};
use serde_json::{Value, json};

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let base = env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("create temp test dir");
        Self(base)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("resolve desktop-bot-app root")
        .to_path_buf()
}

fn try_real_host_bundle() -> Option<PathBuf> {
    let bundle = app_root().join("dist/host/host.cjs");
    if bundle.exists() {
        return Some(bundle);
    }
    if env::var("BYOK_SHELL_E2E_LIVE_HOST").ok().as_deref() == Some("1") {
        panic!(
            "real Host bundle missing at {} — run `bun run --filter @byok-sdk/example-desktop-bot-app build:host`",
            bundle.display()
        );
    }
    None
}

fn with_temp_home_env(spec: HostCommandSpec, home: &Path) -> HostCommandSpec {
    let local_app_data = home.join("AppData/Local");
    let roaming_app_data = home.join("AppData/Roaming");
    let xdg_data_home = home.join(".local/share");
    let _ = fs::create_dir_all(&local_app_data);
    let _ = fs::create_dir_all(&roaming_app_data);
    let _ = fs::create_dir_all(&xdg_data_home);
    spec.with_env("HOME", home.to_string_lossy().into_owned())
        .with_env("USERPROFILE", home.to_string_lossy().into_owned())
        .with_env(
            "LOCALAPPDATA",
            local_app_data.to_string_lossy().into_owned(),
        )
        .with_env("APPDATA", roaming_app_data.to_string_lossy().into_owned())
        .with_env(
            "XDG_DATA_HOME",
            xdg_data_home.to_string_lossy().into_owned(),
        )
}

fn real_host_spec_with_temp_home(bundle: &Path, home: &Path) -> HostCommandSpec {
    with_temp_home_env(HostCommandSpec::dev_node_host(bundle.to_path_buf()), home)
}

fn host_storage_root_for(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/BYOK Bots")
    } else if cfg!(target_os = "linux") {
        home.join(".local/share/byok-desktop-bots")
    } else {
        home.join("AppData/Local/BYOK Bots")
    }
}

fn write_node_script(dir: &Path, name: &str, body: &str) -> HostCommandSpec {
    let script = dir.join(name);
    fs::write(&script, body).expect("write node test script");
    HostCommandSpec::dev_node_host(script)
}

fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: kill(pid, 0) probes process existence without sending a signal.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        // `tasklist` CSV avoids extra winapi process-query features and substring PID matches (e.g. 12 vs 1234).
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output();
        match out {
            Ok(res) => String::from_utf8_lossy(&res.stdout).contains(&format!(",\"{pid}\",")),
            Err(_) => false,
        }
    }
}

fn wait_for_pid_file(pid_file: &Path, timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(raw) = fs::read_to_string(pid_file)
            && let Ok(pid) = raw.trim().parse::<u32>()
        {
            return Some(pid);
        }
        thread::sleep(Duration::from_millis(25));
    }
    fs::read_to_string(pid_file)
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
}

fn wait_until<F>(timeout: Duration, mut cond: F) -> bool
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    cond()
}

struct FakeUpdate<F>(F);

impl<F: FnOnce() -> SwapOutcome> UpdateInstaller for FakeUpdate<F> {
    fn swap(self) -> SwapOutcome {
        (self.0)()
    }
}

fn update_host(dir: &TempDir, lock: &MaintenanceLock, mode: &str) -> HostSupervisor {
    let spec = write_node_script(dir.path(), "update-host.cjs", r#"
const fs = require('node:fs');
const rl = require('node:readline');
const { MODE, LAUNCHES, SNAPSHOT, RECOVERING, ALLOW_HELLO } = process.env;
if (process.argv[2] === 'byok-desktop-snapshot') {
  fs.writeFileSync(SNAPSHOT, process.argv[3]);
  const result = MODE === 'snapshot' || MODE === 'recovery-fails' || MODE === 'quit'
    ? { ok: false, code: 'snapshot_denied', message: 'Injected S1 refusal' }
    : { ok: true, target: SNAPSHOT };
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(result.ok ? 0 : 1));
} else {
  const recovery = fs.existsSync(LAUNCHES);
  fs.appendFileSync(LAUNCHES, process.pid + '\n');
  rl.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    const write = (value, done) => process.stdout.write(JSON.stringify(value) + '\n', done);
    if (req.method === 'hello') {
      if (recovery && MODE === 'recovery-fails') process.exit(1);
      const ready = () => {
        write({ id: req.id, result: { bridgeVersion: req.params.bridgeVersion } });
        write({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 0 } });
      };
      if (recovery && (MODE === 'rollback' || MODE === 'quit')) {
        fs.writeFileSync(RECOVERING, 'hello');
        const timer = setInterval(() => {
          if (fs.existsSync(ALLOW_HELLO)) {
            clearInterval(timer);
            ready();
          }
        }, 10);
      } else ready();
    } else if (req.method === 'shutdown') {
      write({ id: req.id, result: null }, () => process.exit(MODE === 'stop' && !recovery ? 1 : 0));
    }
  });
}
"#);
    let spec = spec.with_env("MODE", mode);
    let spec = [("LAUNCHES", "launches"), ("SNAPSHOT", "snapshot"), ("RECOVERING", "recovering"), ("ALLOW_HELLO", "allow-hello")]
        .into_iter().fold(spec, |spec, (env, file)| {
            spec.with_env(env, dir.path().join(file).to_string_lossy())
        });
    let mut config = HostSupervisorConfig::new(spec, BridgeContract::load().unwrap())
        .with_maintenance_lock(lock.clone());
    config.shutdown_grace = Duration::from_secs(2);
    let host = HostSupervisor::new(config, |_| {}, || {});
    host.start();
    assert!(wait_until(Duration::from_secs(5), || matches!(host.last_state(), Some(SupervisedHostState::Running { .. }))));
    host
}

#[test]
fn update_stop_and_snapshot_errors_recover_only_after_old_host_hello() {
    for (mode, code, recovered) in [
        ("stop", "update_host_stop_failed", true),
        ("snapshot", "update_snapshot_failed", true),
        ("recovery-fails", "update_snapshot_failed", false),
    ] {
        let dir = TempDir::new("byok-update-recover");
        let lock = MaintenanceLock::new();
        let host = update_host(&dir, &lock, mode);
        let error = handover(&lock, &host, "1.0.0", FakeUpdate(|| panic!("unexpected swap"))).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.host_recovered, recovered);
        assert_eq!(error.recovery_code, (!recovered).then_some("update_host_recovery_failed"));
        assert!(!lock.is_handed_over());
        assert!(lock.try_begin().is_ok());
        if mode == "stop" {
            assert!(!dir.path().join("snapshot").exists());
        } else {
            assert_eq!(fs::read_to_string(dir.path().join("snapshot")).unwrap(), "1.0.0");
        }
        assert_eq!(
            matches!(host.last_state(), Some(SupervisedHostState::Running { .. })),
            recovered,
        );
    }
}

#[test]
fn update_rollback_keeps_maintenance_until_old_host_ready_and_quit_aborts_wait() {
    for mode in ["rollback", "quit"] {
        let dir = TempDir::new("byok-update-wait");
        let lock = MaintenanceLock::new();
        let host = Arc::new(update_host(&dir, &lock, mode));
        thread::scope(|scope| {
            let work = scope.spawn(|| handover(&lock, &host, "1.0.0", FakeUpdate(|| {
                assert_eq!(mode, "rollback");
                SwapOutcome::RolledBackVerified("Fake installer exited before takeover".into())
            })));
            assert!(wait_until(Duration::from_secs(3), || dir.path().join("recovering").exists()));
            let router = ShellRouter::new(Arc::clone(&host), lock.clone(), "1.0.0");
            let busy = router.restore("1.0.0", "2026-11-25T00-00-00.000Z", |_| panic!("restore restarted app"));
            assert_eq!(busy.unwrap_err().code, "maintenance_busy");
            assert!(!lock.is_handed_over());
            if mode == "quit" {
                assert_eq!(lock.begin_quit(), QuitOutcome::Quit);
            } else {
                fs::write(dir.path().join("allow-hello"), b"ready").unwrap();
            }
            let error = work.join().unwrap().unwrap_err();
            assert_eq!(error.code, if mode == "rollback" { "update_install_failed" } else { "update_snapshot_failed" });
            assert_eq!(error.host_recovered, mode == "rollback");
            assert_eq!(error.recovery_code, None);
        });
    }
}

#[test]
fn update_only_seals_maintenance_after_verified_swap() {
    for corrupted in [false, true] {
        let dir = TempDir::new("byok-update-swap");
        let lock = MaintenanceLock::new();
        let host = update_host(&dir, &lock, "swap");
        let executable = dir.path().join("updated-exe");
        let result = handover(&lock, &host, "1.0.0", FakeUpdate(|| {
            assert_eq!(fs::read_to_string(dir.path().join("snapshot")).unwrap(), "1.0.0");
            if corrupted {
                SwapOutcome::InstallCorrupted("Injected incomplete rollback".into())
            } else {
                SwapOutcome::Swapped { executable: executable.clone() }
            }
        }));
        if corrupted {
            let error = result.unwrap_err();
            assert_eq!(error.code, "update_install_corrupted");
            assert!(!error.host_recovered);
            assert!(host.restart(&lock).is_err());
            assert_eq!(lock.begin_quit(), QuitOutcome::Quit);
        } else {
            assert_eq!(result.unwrap(), HandoverOutcome::Swapped { executable });
            assert_eq!(lock.begin_quit(), QuitOutcome::HandedOver);
        }
        assert_eq!(fs::read_to_string(dir.path().join("launches")).unwrap().lines().count(), 1);
    }
}

#[test]
fn env_filtering_strips_foreign_runtime_variables_case_insensitively() {
    let input = [
        ("PATH", "/usr/bin"),
        ("NODE_OPTIONS", "--require=/tmp/evil.js"),
        ("node_path", "/tmp/other"),
        ("PI_PACKAGE_DIR", "/tmp/pi"),
        ("Byok_Pi_Bin", "/tmp/pi-bin"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("BYOK_CUSTOM_KEEP", "ok"),
    ];
    let filtered = filter_env_pairs(input);
    for var in FOREIGN_RUNTIME_VARIABLES {
        assert!(
            !filtered.iter().any(|(k, _)| k.eq_ignore_ascii_case(var)),
            "{var} must be stripped"
        );
    }
    assert!(filtered.contains(&("PATH".to_owned(), "/usr/bin".to_owned())));
    assert!(filtered.contains(&("BYOK_CUSTOM_KEEP".to_owned(), "ok".to_owned())));
}

#[test]
fn real_host_s1_snapshot_status_restore_roundtrip_under_temp_home() {
    let Some(bundle) = try_real_host_bundle() else {
        return;
    };
    let tmp = TempDir::new("byok-s1-e2e");
    let home = tmp.path();
    let contract = BridgeContract::load().expect("contract loads");
    let spec = real_host_spec_with_temp_home(&bundle, home);

    let store_dir = home.join(".byok/byok-desktop-bots");
    let host_dir = host_storage_root_for(home).join("host");
    fs::create_dir_all(&store_dir).expect("create store dir");
    fs::create_dir_all(&host_dir).expect("create host dir");
    fs::write(store_dir.join("device.json"), b"v1-store-data").expect("write device.json");
    fs::write(host_dir.join("settings.json"), b"v1-host-settings").expect("write settings.json");

    assert_eq!(
        run_snapshot_status(
            &spec,
            &contract.host_commands,
            "1.0.0",
            Some(Duration::from_secs(15))
        )
        .expect("status query"),
        None
    );

    let snap_target =
        run_snapshot(&spec, &contract.host_commands, "1.0.0").expect("snapshot succeeds");
    let canon_home = fs::canonicalize(home).expect("canonical home");
    let canon_target = fs::canonicalize(&snap_target).expect("canonical snapshot target");
    assert!(
        canon_target.starts_with(&canon_home),
        "snapshot target {} must reside inside temp home {}",
        canon_target.display(),
        canon_home.display()
    );

    let status = run_snapshot_status(
        &spec,
        &contract.host_commands,
        "1.0.0",
        Some(Duration::from_secs(15)),
    )
    .expect("status after snapshot")
    .expect("snapshot exists");
    assert_eq!(status.version, "1.0.0");
    assert_eq!(status.target, snap_target);

    fs::write(store_dir.join("device.json"), b"v2-mutated").expect("mutate store");
    let restored = run_restore(
        &spec,
        &contract.host_commands,
        "1.0.0",
        "2026-11-24T12-00-00.000Z",
    )
    .expect("restore succeeds");
    let canon_aside = fs::canonicalize(&restored.aside_path).expect("canonical aside");
    assert!(canon_aside.starts_with(&canon_home));
    assert_eq!(
        fs::read_to_string(store_dir.join("device.json")).expect("read restored store"),
        "v1-store-data"
    );
}

#[test]
fn real_host_rejects_hello_version_mismatch_and_malformed_json_fail_closed() {
    let Some(bundle) = try_real_host_bundle() else {
        return;
    };
    let tmp = TempDir::new("byok-real-proto");
    let spec = real_host_spec_with_temp_home(&bundle, tmp.path());

    // Wrong bridge version -> supervisor immediately stops as Failed without restart loop.
    let mut bad_contract = BridgeContract::load().expect("contract loads");
    bad_contract.bridge_version = 999;

    let observed = Arc::new(Mutex::new(Vec::<SupervisedHostState>::new()));
    let observed_ref = Arc::clone(&observed);
    let mut cfg = HostSupervisorConfig::new(spec.clone(), bad_contract);
    cfg.initial_backoff = Duration::from_millis(50);
    cfg.max_backoff = Duration::from_millis(100);
    cfg.shutdown_grace = Duration::from_secs(5);
    let supervisor = HostSupervisor::new(cfg, move |s| observed_ref.lock().unwrap().push(s), || {});
    supervisor.start();

    assert!(
        wait_until(Duration::from_secs(10), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Failed { .. })
            )
        }),
        "real Host must fail closed as Failed on hello version mismatch; saw {:?}",
        observed.lock().unwrap()
    );
    drop(supervisor);

    // Raw malformed line against real Host: emits id:0 invalid_message and exits non-zero.
    let mut child = spawn_host_child(&spec, &[]).expect("spawn real host");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"not-valid-json\n")
            .expect("write malformed");
        stdin.flush().expect("flush");
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait real host");
    assert!(
        !output.status.success(),
        "real Host must exit non-zero on malformed frame"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(stdout.trim()).expect("id:0 JSON error reply");
    assert_eq!(parsed["id"].as_u64(), Some(0));
    assert_eq!(parsed["error"]["code"].as_str(), Some("invalid_message"));
}

#[test]
fn real_host_custody_invalid_json_never_leaks_secret_in_receipt() {
    let Some(bundle) = try_real_host_bundle() else {
        return;
    };
    let tmp = TempDir::new("byok-custody-real");
    let contract = BridgeContract::load().expect("contract loads");
    let spec = real_host_spec_with_temp_home(&bundle, tmp.path());
    let sentinel = "sk-super-secret-do-not-echo-998877";
    let malformed =
        SecretBytes::from_string(format!("{{\"op\":\"configure\",\"secret\":\"{sentinel}\""));
    let dbg = format!("{malformed:?}");
    assert!(!dbg.contains(sentinel), "Debug must redact SecretBytes");

    let err = submit_to_custody(
        &spec,
        &contract.host_commands.custody,
        malformed,
        Duration::from_secs(10),
        None,
        None,
    )
    .expect_err("malformed custody JSON must fail closed");
    assert_eq!(err.code, "custody_request_invalid");
    assert!(
        !err.message.contains(sentinel),
        "custody error leaked secret: {}",
        err.message
    );
}

#[test]
fn supervisor_multiplexes_out_of_order_replies_coalesces_hints_and_resets_backoff() {
    let tmp = TempDir::new("byok-sup-harness");
    let crash_flag = tmp.path().join("crash-once");
    fs::write(&crash_flag, b"1").unwrap();

    let script = format!(
        r#"
import fs from 'node:fs';
import readline from 'node:readline';
const flag = {flag};
const rl = readline.createInterface({{ input: process.stdin }});
let greeted = false;
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    if (fs.existsSync(flag)) {{
      fs.unlinkSync(flag);
      setTimeout(() => process.exit(2), 180);
      return;
    }}
    greeted = true;
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'starting', pid: process.pid }} }}) + '\n');
    for (let i = 1; i <= 5; i++) {{
      process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: i }} }}) + '\n');
    }}
    return;
  }}
  if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
  if (msg.method === 'k8.view') {{
    const delay = msg.params?.botId === 'slow' ? 120 : 10;
    setTimeout(() => {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ ok: msg.params?.botId ?? null }} }}) + '\n');
    }}, delay);
  }}
}});
"#,
        flag = serde_json::to_string(&crash_flag.to_string_lossy().into_owned()).unwrap()
    );

    let spec = write_node_script(tmp.path(), "mock-host.mjs", &script);
    let contract = BridgeContract::load().expect("contract loads");
    let states = Arc::new(Mutex::new(Vec::<SupervisedHostState>::new()));
    let hints = Arc::new(AtomicUsize::new(0));
    let states_ref = Arc::clone(&states);
    let hints_ref = Arc::clone(&hints);

    let mut cfg = HostSupervisorConfig::new(spec, contract);
    cfg.initial_backoff = Duration::from_millis(50);
    cfg.max_backoff = Duration::from_millis(120);
    cfg.backoff_reset = Duration::from_millis(150);
    cfg.hint_window = Duration::from_millis(60);
    cfg.shutdown_grace = Duration::from_secs(3);

    let supervisor = Arc::new(HostSupervisor::new(
        cfg,
        move |s| states_ref.lock().unwrap().push(s),
        move || {
            hints_ref.fetch_add(1, Ordering::Relaxed);
        },
    ));
    supervisor.start();

    assert!(
        wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 5, .. })
            )
        }),
        "supervisor must crash once, restart with backoff, and reach activeWork=5; states={:?}",
        states.lock().unwrap()
    );

    // Give hint coalescer time to fire once for the burst of 6 state pushes.
    thread::sleep(Duration::from_millis(150));
    let hint_count = hints.load(Ordering::Relaxed);
    assert!(
        (1..=3).contains(&hint_count),
        "50-60ms coalescer must merge state bursts, got {hint_count} hints"
    );

    // Verify backoff reset observed Restarting state and healthy run exceeded backoff_reset.
    let history = states.lock().unwrap().clone();
    assert!(
        history
            .iter()
            .any(|s| matches!(s, SupervisedHostState::Restarting { in_ms: 50, .. })),
        "expected first crash backoff of 50ms, history={history:?}"
    );

    // Out-of-order concurrent replies (`slow` requested first, `fast` returns first).
    let sup_a = Arc::clone(&supervisor);
    let sup_b = Arc::clone(&supervisor);
    let h_slow =
        thread::spawn(move || sup_a.call_renderer_forwarded("k8.view", json!({ "botId": "slow" })));
    thread::sleep(Duration::from_millis(15));
    let h_fast =
        thread::spawn(move || sup_b.call_renderer_forwarded("k8.view", json!({ "botId": "fast" })));

    assert_eq!(h_fast.join().unwrap().unwrap(), json!({ "ok": "fast" }));
    assert_eq!(h_slow.join().unwrap().unwrap(), json!({ "ok": "slow" }));

    // Renderer cannot call shellToHost (`keys.profilesChanged`), while shell_to_host can.
    let unauthorized = supervisor
        .call_renderer_forwarded("keys.profilesChanged", Value::Null)
        .expect_err("renderer must not call shellToHost");
    assert_eq!(unauthorized.code, BridgeErrorCode::UnauthorizedMethod);

    supervisor.stop().expect("clean shutdown exits 0");
    // Repeated stop after clean exit remains idempotent Ok.
    supervisor
        .stop()
        .expect("repeat stop after clean exit is Ok");
}

#[test]
fn failed_stop_refuses_subsequent_retry_and_recovery_respects_stopped_invariant() {
    let tmp = TempDir::new("byok-stop-fail");
    let script = r#"
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'stopped', pid: process.pid, reason: 'store_refused', storeRefused: true } }) + '\n');
    return;
  }
  if (msg.method === 'shutdown') {
    // Deliberately ignore shutdown and exit signals for test timeout verification.
  }
});
process.on('SIGTERM', () => {});
"#;
    let spec = write_node_script(tmp.path(), "stuck-host.mjs", script);
    let contract = BridgeContract::load().expect("contract loads");
    let mut cfg = HostSupervisorConfig::new(spec, contract);
    cfg.shutdown_grace = Duration::from_millis(200);
    let supervisor = Arc::new(HostSupervisor::new(cfg, |_| {}, || {}));
    supervisor.start();

    assert!(wait_until(Duration::from_secs(3), || {
        matches!(
            supervisor.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: true,
                ..
            })
        )
    }));

    // First stop fails because Host ignores shutdown within grace and had to be terminated.
    supervisor.stop().expect_err("stuck shutdown must fail");
    // Critical P2-2 fix: a second stop attempt MUST NOT silently treat prior forced termination as Ok!
    supervisor
        .stop()
        .expect_err("retry stop after unclean termination must still refuse");

    let maintenance = MaintenanceLock::new();
    let start_fresh_res = shell_start_fresh(&supervisor, &maintenance, "2026-01-01", |_| {});
    assert_eq!(
        start_fresh_res
            .expect_err("must not run S1 start-fresh after failed stop")
            .code,
        "host_stop_failed"
    );
}

#[test]
fn custody_submit_timeout_preserves_child_drains_stdout_without_epipe_and_list_timeout_kills() {
    let tmp = TempDir::new("byok-custody-timeout");
    let marker = tmp.path().join("submit-committed.txt");
    let list_marker = tmp.path().join("list-leaked.txt");

    let script = format!(
        r#"
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {{ input += chunk; }});
process.stdin.on('end', () => {{
  const req = JSON.parse(input);
  if (req.op === 'list') {{
    setTimeout(() => {{
      fs.writeFileSync({list_marker}, 'should-have-been-killed');
      process.stdout.write(JSON.stringify({{ ok: true, statuses: [] }}) + '\n');
    }}, 1500);
    return;
  }}
  setTimeout(() => {{
    try {{
      process.stdout.write(JSON.stringify({{ ok: true, status: {{ profile_ref: 'w' }} }}) + '\n');
      fs.writeFileSync({marker}, 'committed-cleanly-without-epipe');
    }} catch (err) {{
      fs.writeFileSync({marker}, 'EPIPE:' + err.code);
    }}
  }}, 350);
}});
"#,
        marker = serde_json::to_string(&marker.to_string_lossy().into_owned()).unwrap(),
        list_marker = serde_json::to_string(&list_marker.to_string_lossy().into_owned()).unwrap()
    );
    let spec = write_node_script(tmp.path(), "custody-sim.mjs", &script);
    let contract = BridgeContract::load().expect("contract loads");

    // 1. Submit times out cleanly at 100ms WITHOUT killing child AND holds MaintenanceLock custody exclusion until child exits at 450ms without EPIPE.
    let lock = MaintenanceLock::new();
    let sentinel = "sk-custody-e2e-keep-lock";
    let err = submit_to_custody(
        &spec,
        &contract.host_commands.custody,
        SecretBytes::from_string(format!(
            "{{\"op\":\"replace_secret\",\"profileRef\":\"w\",\"secret\":\"{sentinel}\"}}"
        )),
        Duration::from_millis(100),
        Some(&lock),
        None,
    )
    .expect_err("submit must time out at 100ms");
    assert_eq!(err.code, "custody_timeout");
    assert!(!err.message.contains(sentinel));
    assert!(
        matches!(lock.try_begin(), Err(MaintenanceBusyError)),
        "MaintenanceLock must reject S1 maintenance while timed-out custody child is still running"
    );

    assert!(
        wait_until(Duration::from_secs(3), || marker.exists()),
        "custody child must finish writing after timeout"
    );
    assert!(
        wait_until(Duration::from_secs(2), || !lock.is_busy()),
        "MaintenanceLock must release custody exclusion once child exits"
    );
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "committed-cleanly-without-epipe"
    );

    // 2. List times out at 100ms AND kills child so delayed work never finishes, releasing lock once killed.
    let list_err = list_from_custody(
        &spec,
        &contract.host_commands.custody,
        Duration::from_millis(100),
        Some(&lock),
        None,
    )
    .expect_err("list must time out");
    assert_eq!(list_err.code, "custody_timeout");
    assert!(
        wait_until(Duration::from_secs(2), || !lock.is_busy()),
        "MaintenanceLock must release custody exclusion after list timeout kill"
    );
    thread::sleep(Duration::from_millis(1700));
    assert!(!list_marker.exists(), "list timeout must kill child");

    // 3. MaintenanceLock blocks concurrent submit, begin_quit drains in-flight maintenance,
    //    blocked stdin write respects deadline, and hung keys.profilesChanged returns catalog_refresh_timeout.
    let guard = lock.try_begin().expect("acquire maintenance lock");
    let busy_err = submit_to_custody(
        &spec,
        &contract.host_commands.custody,
        SecretBytes::from_string(
            r#"{"op":"replace_secret","profileRef":"w","secret":"s"}"#.to_owned(),
        ),
        Duration::from_secs(1),
        Some(&lock),
        None,
    )
    .expect_err("busy maintenance lock must refuse keys.submit");
    assert_eq!(busy_err.code, "PROVIDER_CONFIGURATION_BUSY");

    let lock_clone = lock.clone();
    let quit_thread = thread::spawn(move || lock_clone.begin_quit());
    thread::sleep(Duration::from_millis(40));
    assert!(lock.is_quitting());
    drop(guard);
    assert_eq!(quit_thread.join().unwrap(), QuitOutcome::Quit);

    // Large payload written to a child that never drains stdin must still time out within deadline.
    let sleepy_stdin = write_node_script(
        tmp.path(),
        "sleepy-stdin.mjs",
        "setTimeout(() => {}, 5000);",
    );
    let large_secret = "x".repeat(512 * 1024);
    let started = Instant::now();
    let stdin_timeout = submit_to_custody(
        &sleepy_stdin,
        &contract.host_commands.custody,
        SecretBytes::from_string(format!(r#"{{"op":"configure","secret":"{large_secret}"}}"#)),
        Duration::from_millis(150),
        None,
        None,
    )
    .expect_err("blocked stdin write must time out");
    assert_eq!(stdin_timeout.code, "custody_timeout");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "stdin write must be covered by deadline"
    );

    // Hung keys.profilesChanged after custody receipt returns bounded `catalog_refresh_timeout`.
    let fast_custody_hung_host = write_node_script(
        tmp.path(),
        "hung-refresh.mjs",
        r#"
import readline from 'node:readline';
const arg = process.argv[2];
if (arg) {
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ ok: true, status: { profile_ref: 'w' } }) + '\n');
  });
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
      process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 0 } }) + '\n');
    } else if (msg.method === 'shutdown') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: null }) + '\n');
      process.exit(0);
    }
  });
}
"#,
    );
    let sup = HostSupervisor::new(
        HostSupervisorConfig::new(fast_custody_hung_host.clone(), contract.clone()),
        |_| {},
        || {},
    );
    sup.start();
    assert!(wait_until(Duration::from_secs(3), || {
        matches!(sup.last_state(), Some(SupervisedHostState::Running { .. }))
    }));
    let refresh_err = submit_to_custody(
        &fast_custody_hung_host,
        &contract.host_commands.custody,
        SecretBytes::from_string(
            r#"{"op":"replace_secret","profileRef":"w","secret":"ok"}"#.to_owned(),
        ),
        Duration::from_millis(200),
        None,
        Some(&sup),
    )
    .expect_err("hung keys.profilesChanged must fail with catalog_refresh_timeout");
    assert_eq!(refresh_err.code, "catalog_refresh_timeout");
    sup.stop().expect("clean shutdown");
}

#[test]
fn router_routes_main_methods_and_rejects_shell_only_methods_from_renderer() {
    let tmp = TempDir::new("byok-router");
    let host_saw_login_item = tmp.path().join("host-saw-login-item");
    let script = format!(
        r#"
import fs from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
  if (msg.method === 'keys.profilesChanged') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    return;
  }}
  if (msg.method === 'settings.loginItem' || msg.method === 'settings.setLoginItem') {{
    fs.writeFileSync({marker}, msg.method);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ supported: true, enabled: true }} }}) + '\n');
    return;
  }}
  if (msg.method === 'k8.view') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ botId: msg.params?.botId ?? null }} }}) + '\n');
  }}
}});
"#,
        marker =
            serde_json::to_string(&host_saw_login_item.to_string_lossy().into_owned()).unwrap(),
    );
    let spec = write_node_script(tmp.path(), "router-host.mjs", &script);
    let contract = BridgeContract::load().expect("contract loads");
    let supervisor = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(spec, contract),
        |_| {},
        || {},
    ));
    supervisor.start();

    assert!(wait_until(Duration::from_secs(3), || {
        supervisor
            .call_renderer_forwarded("k8.view", json!({ "botId": "b1" }))
            .is_ok()
    }));

    let router = ShellRouter::new(Arc::clone(&supervisor), MaintenanceLock::new(), "0.0.1");
    assert_eq!(
        router
            .dispatch_renderer("k8.view", json!({ "botId": "b1" }))
            .unwrap(),
        json!({ "botId": "b1" })
    );
    // Login-item methods belong exclusively to the engine-thread NSH adapter and must neither
    // run a duplicate backend in ShellRouter nor forward to the Host.
    let login_get = router
        .dispatch_renderer("settings.loginItem", Value::Null)
        .expect_err("settings.loginItem must not have a second path in ShellRouter");
    assert_eq!(login_get.code, "unknown_method");
    let login_set = router
        .dispatch_renderer("settings.setLoginItem", json!({ "enabled": true }))
        .expect_err("settings.setLoginItem must not have a second path in ShellRouter");
    assert_eq!(login_set.code, "unknown_method");
    assert!(
        !host_saw_login_item.exists(),
        "login-item mainMethods must never be forwarded to the Host"
    );

    let blocked = router
        .dispatch_renderer("keys.profilesChanged", Value::Null)
        .expect_err("renderer must never invoke shellToHostMethods");
    assert_eq!(blocked.code, "unknown_method");

    supervisor.stop().expect("clean shutdown");
}

#[test]
fn router_shell_state_and_shell_restore_run_host_stopped_order_and_confirm_handover() {
    let Some(bundle) = try_real_host_bundle() else {
        return;
    };
    let tmp = TempDir::new("byok-restore-e2e");
    let home = tmp.path();
    let spec = real_host_spec_with_temp_home(&bundle, home);
    let contract = BridgeContract::load().expect("contract loads");

    // Populate temp home stores and capture real snapshot v1.0.0 before starting a stopped mock Host.
    let store_dir = home.join(".byok/byok-desktop-bots");
    let host_dir = host_storage_root_for(home).join("host");
    fs::create_dir_all(&store_dir).unwrap();
    fs::create_dir_all(&host_dir).unwrap();
    fs::write(store_dir.join("device.json"), b"snapshot-v1").unwrap();
    fs::write(host_dir.join("settings.json"), b"host-v1").unwrap();
    run_snapshot(&spec, &contract.host_commands, "1.0.0").expect("snapshot v1.0.0");
    fs::write(store_dir.join("device.json"), b"mutated-v2").unwrap();

    // Real supervisor running real host.cjs in S1 argv? Use a script that stops cleanly and answers S1 argv via forwarding to real host.cjs.
    let wrapper = format!(
        r#"
import {{ execFileSync }} from 'node:child_process';
import readline from 'node:readline';
const realHost = {real_host};
const args = process.argv.slice(2);
if (args.length > 0) {{
  const out = execFileSync(process.execPath, [realHost, ...args], {{ encoding: 'utf8', env: process.env }});
  process.stdout.write(out);
  process.exit(0);
}}
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'stopped', pid: process.pid, reason: 'halted', storeRefused: false }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
        real_host = serde_json::to_string(&bundle.to_string_lossy().into_owned()).unwrap()
    );
    let wrapper_spec = with_temp_home_env(
        write_node_script(tmp.path(), "restore-wrapper.mjs", &wrapper),
        home,
    );

    let supervisor = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(wrapper_spec, contract),
        |_| {},
        || {},
    ));
    supervisor.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            supervisor.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));

    let maintenance = MaintenanceLock::new();
    let router = ShellRouter::new(Arc::clone(&supervisor), maintenance.clone(), "1.0.0")
        .with_deadlines(Duration::from_secs(10), Some(Duration::from_secs(15)));

    let view = router
        .state("1.0.0")
        .expect("router.state allowed by contract");
    assert_eq!(view.restore_error, None);
    assert_eq!(view.restore.map(|r| r.version), Some("1.0.0".to_owned()));
    let routed_state = router
        .dispatch_renderer("shell.state", Value::Null)
        .expect("dispatch_renderer shell.state uses configured app_version");
    assert_eq!(routed_state["restore"]["version"], json!("1.0.0"));

    let mut relaunched_with_err = None;
    let mut quit_outcome = None;
    let lock_in_relaunch = maintenance.clone();
    let ok = shell_restore(
        &supervisor,
        &maintenance,
        "1.0.0",
        "2026-11-24T12-30-00.000Z",
        Some(Duration::from_secs(15)),
        |err| {
            relaunched_with_err = Some(err.is_some());
            // Reproduces P1-3: relaunch invoking begin_quit() must return HandedOver immediately without deadlocking.
            quit_outcome = Some(lock_in_relaunch.begin_quit());
        },
    )
    .expect("shell_restore succeeds");

    assert_eq!(relaunched_with_err, Some(false));
    assert_eq!(quit_outcome, Some(QuitOutcome::HandedOver));
    assert!(maintenance.is_handed_over());
    assert!(
        fs::canonicalize(&ok.aside_path)
            .unwrap()
            .starts_with(fs::canonicalize(home).unwrap())
    );
    assert_eq!(
        fs::read_to_string(store_dir.join("device.json")).unwrap(),
        "snapshot-v1"
    );
}

#[test]
fn bridge_drop_and_off_reader_callbacks_and_strict_shutdown_contract() {
    let tmp = TempDir::new("byok-bridge-fixes");

    // 1. P1-1 & P1-2: off-reader on_state issues synchronous status RPC without deadlocking,
    //    and dropping BridgeClient closes Host stdin so the child exits cleanly on EOF.
    let script = r#"
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 0 } }) + '\n');
  } else if (msg.method === 'status') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { state: 'running', pid: process.pid, activeWork: 0 } }) + '\n');
  }
});
setInterval(() => {}, 10000);
"#;
    let spec = write_node_script(tmp.path(), "direct-client.mjs", script);
    let child = spawn_host_child(&spec, &[]).expect("spawn direct child");
    let pid = child.id();
    let client_slot: Arc<Mutex<Option<Arc<BridgeClient>>>> = Arc::new(Mutex::new(None));
    let callback_slot = Arc::clone(&client_slot);
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let client = Arc::new(
        BridgeClient::connect(child, EXPECTED_BRIDGE_VERSION, move |state| {
            if matches!(state, HostState::Running { .. }) {
                if let Some(c) = callback_slot.lock().unwrap().as_ref().cloned() {
                    let reply = c.call_raw("status", Value::Null);
                    let _ = done_tx.send(reply.is_ok());
                }
            }
        })
        .expect("connect direct client"),
    );
    *client_slot.lock().unwrap() = Some(Arc::clone(&client));
    // Trigger another state push after slot populated? Even better, wait cleanly if hello pushed before slot:
    drop(client);
    // Drop slot's Arc too so refcount drops to 0 and Drop closes stdin even if callback ran slightly later.
    let _ = done_rx.recv_timeout(Duration::from_millis(200));
    *client_slot.lock().unwrap() = None;
    assert!(
        wait_until(Duration::from_secs(3), || !is_pid_alive(pid)),
        "dropping BridgeClient must close Host stdin and terminate child"
    );

    // 2. P1-2 synchronous RPC directly inside on_state triggered after connect:
    let script_sync = r#"
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
  } else if (msg.method === 'k8.view') {
    process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 1 } }) + '\n');
    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n');
  } else if (msg.method === 'status') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { state: 'running', pid: process.pid, activeWork: 1 } }) + '\n');
  } else if (msg.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: null }) + '\n');
    process.exit(0);
  }
});
"#;
    let spec_sync = write_node_script(tmp.path(), "sync-cb.mjs", script_sync);
    let sync_holder: Arc<Mutex<Option<Arc<BridgeClient>>>> = Arc::new(Mutex::new(None));
    let sync_cb_ref = Arc::clone(&sync_holder);
    let (rpc_tx, rpc_rx) = std::sync::mpsc::channel();
    let sync_client = Arc::new(
        BridgeClient::connect(spawn_host_child(&spec_sync, &[]).unwrap(), EXPECTED_BRIDGE_VERSION, move |_| {
            let cli = sync_cb_ref.lock().unwrap().as_ref().cloned().unwrap();
            let _ = rpc_tx.send(cli.call_raw("status", Value::Null));
        })
        .unwrap(),
    );
    *sync_holder.lock().unwrap() = Some(Arc::clone(&sync_client));
    assert!(sync_client.call_raw("k8.view", Value::Null).is_ok());
    assert!(
        rpc_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("off-reader RPC must return")
            .is_ok(),
        "synchronous status RPC inside on_state must not deadlock"
    );
    sync_client
        .shutdown_and_wait(Duration::from_secs(3))
        .expect("clean shutdown");
    *sync_holder.lock().unwrap() = None;

    // 3. P2-2: shutdown reply missing `result` or returning non-null fails `stop()` even on exit 0.
    for reply_expr in [
        r#"{ id: msg.id }"#,
        r#"{ id: msg.id, result: { bogus: true } }"#,
    ] {
        let bad_script = format!(
            r#"
import readline from 'node:readline';
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({reply_expr}) + '\n');
    process.exit(0);
  }}
}});
"#
        );
        let cli = BridgeClient::connect(
            spawn_host_child(
                &write_node_script(tmp.path(), "bad-stop.mjs", &bad_script),
                &[],
            )
            .unwrap(),
            EXPECTED_BRIDGE_VERSION,
            |_| {},
        )
        .unwrap();
        assert!(
            cli.shutdown_and_wait(Duration::from_secs(2)).is_err(),
            "shutdown_and_wait must reject `{reply_expr}`"
        );
    }
}

#[test]
fn mutating_s1_not_killed_by_recovery_deadline_and_router_checks_narrowed_contract() {
    let tmp = TempDir::new("byok-s1-nodeadline");
    let script = r#"
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'byok-desktop-snapshot-status') {
  process.stdout.write(JSON.stringify({ ok: true, snapshot: { version: args[1], target: '/tmp/snap' } }) + '\n');
  process.exit(0);
}
if (args[0] === 'byok-desktop-restore') {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: true, asidePath: '/tmp/aside' }) + '\n');
    process.exit(0);
  }, 1200);
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
      process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'stopped', pid: process.pid, reason: 'halted', storeRefused: false } }) + '\n');
    } else if (msg.method === 'shutdown') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: null }) + '\n');
      process.exit(0);
    }
  });
}
"#;
    let spec = write_node_script(tmp.path(), "slow-restore.mjs", script);
    let contract = BridgeContract::load().expect("contract loads");

    // 1. P2-4: 800ms recovery_deadline bounds snapshot-status but never kills slower mutating restore (1200ms > 800ms).
    let sup = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(spec.clone(), contract.clone()),
        |_| {},
        || {},
    ));
    sup.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(sup.last_state(), Some(SupervisedHostState::Stopped { .. }))
    }));
    let lock = MaintenanceLock::new();
    let router = ShellRouter::new(Arc::clone(&sup), lock, "1.0.0")
        .with_deadlines(Duration::from_secs(2), Some(Duration::from_millis(800)));
    let res = router
        .restore("1.0.0", "2026-11-24T12-31-00.000Z", |_| {})
        .expect("mutating restore must finish without being killed by status deadline");
    assert_eq!(res.aside_path, "/tmp/aside");

    // 2. P2-5: narrowed contract removing shell.{state,restore,startFresh} rejects dedicated router methods.
    let mut narrowed = contract;
    narrowed.renderer_methods.retain(|m| {
        !matches!(
            m.as_str(),
            "shell.state" | "shell.restore" | "shell.startFresh"
        )
    });
    narrowed.main_methods.retain(|m| {
        !matches!(
            m.as_str(),
            "shell.state" | "shell.restore" | "shell.startFresh"
        )
    });
    let sup2 = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(spec, narrowed),
        |_| {},
        || {},
    ));
    let router2 = ShellRouter::new(sup2, MaintenanceLock::new(), "1.0.0");
    assert_eq!(router2.state("1.0.0").unwrap_err().code, "unknown_method");
    assert_eq!(
        router2.restore("1.0.0", "stamp", |_| {}).unwrap_err().code,
        "unknown_method"
    );
    assert_eq!(
        router2.start_fresh("stamp", |_| {}).unwrap_err().code,
        "unknown_method"
    );
}

#[test]
fn keep_awake_respects_platform_invariants_and_fails_closed_when_headless() {
    assert_eq!(
        select_linux_backend(Some("ubuntu:GNOME"), None),
        LinuxInhibitBackend::GnomeSession
    );
    assert_eq!(
        select_linux_backend(Some("KDE"), Some("plasma")),
        LinuxInhibitBackend::LogindIdle
    );

    assert!(matches!(
        KeepAwake::acquire("", "reason"),
        Err(PowerError::InvalidArgument(_))
    ));
    assert!(matches!(
        KeepAwake::acquire("byok-shell", ""),
        Err(PowerError::InvalidArgument(_))
    ));

    let unique_reason = format!("byok-shell-e2e-keepawake-{}", std::process::id());
    let guard = KeepAwake::acquire("byok-desktop-bots", &unique_reason);

    #[cfg(target_os = "macos")]
    {
        let guard = guard.expect("macOS IOPMAssertionCreateWithName must succeed");
        let assertions = String::from_utf8_lossy(
            &Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset")
                .stdout,
        )
        .into_owned();
        assert!(
            assertions.contains(&unique_reason),
            "pmset assertions must list active assertion `{unique_reason}`"
        );
        drop(guard);
        let after = String::from_utf8_lossy(
            &Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset")
                .stdout,
        )
        .into_owned();
        assert!(
            !after.contains(&unique_reason),
            "pmset assertions must release `{unique_reason}` on Drop"
        );
    }

    #[cfg(target_os = "windows")]
    {
        let guard = guard.expect("Windows PowerCreateRequest + PowerSetRequest must succeed");
        drop(guard);
    }

    #[cfg(target_os = "linux")]
    {
        match guard {
            Ok(active) => drop(active),
            Err(PowerError::Unavailable { backend, detail }) => {
                assert!(
                    backend == "gnome-session" || backend == "logind-idle",
                    "unexpected backend {backend}: {detail}"
                );
            }
            Err(other) => panic!("unexpected KeepAwake error on Linux: {other}"),
        }
    }
}

fn run_killed_parent_child_mode(use_real_host: bool) {
    let dir = PathBuf::from(env::var("BYOK_KILL_TEST_DIR").expect("BYOK_KILL_TEST_DIR"));
    let pid_file = dir.join("host-pid.txt");

    let spec = if use_real_host {
        // Uses the CI runner's OS credential store & HOME (matching host-smoke.mjs / package-smoke.mjs).
        let bundle = try_real_host_bundle().expect("real Host bundle required for live kill-eof");
        HostCommandSpec::dev_node_host(bundle)
    } else {
        write_node_script(
            &dir,
            "eof-host.mjs",
            r#"
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 5 } }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 0 } }) + '\n');
  }
});
setInterval(() => {}, 10000);
"#,
        )
    };

    let contract = BridgeContract::load().unwrap();
    let cfg = HostSupervisorConfig::new(spec, contract);
    let pid_out = pid_file.clone();
    let recorded = Arc::new(AtomicBool::new(false));
    let sibling_holder: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let sibling_ref = Arc::clone(&sibling_holder);

    let supervisor = HostSupervisor::new(
        cfg,
        move |state| {
            if let SupervisedHostState::Running { pid, .. }
            | SupervisedHostState::Stopped { pid, .. } = state
                && recorded
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                // Spawn an unrelated concurrent sibling child while Host's stdin pipe is open
                // to verify Windows handle inheritance cannot hold Host stdin open.
                let sibling = HostCommandSpec::dev_node_host("-e")
                    .build_command(&["setTimeout(() => {}, 20000)"])
                    .spawn()
                    .ok();
                *sibling_ref.lock().expect("sibling lock poisoned") = sibling;

                let tmp_pid = pid_out.with_extension("tmp");
                let _ = fs::write(&tmp_pid, pid.to_string());
                let _ = fs::rename(&tmp_pid, &pid_out);
            }
        },
        || {},
    );
    supervisor.start();
    thread::sleep(Duration::from_secs(30));
    drop(sibling_holder);
    drop(supervisor);
}

#[test]
fn kill_shell_process_triggers_host_stdin_eof_exit_even_with_concurrent_child() {
    if env::var("BYOK_SHELL_KILL_CHILD_MODE").ok().as_deref() == Some("mock") {
        run_killed_parent_child_mode(false);
        return;
    }
    if env::var("BYOK_SHELL_KILL_CHILD_MODE").ok().as_deref() == Some("real") {
        run_killed_parent_child_mode(true);
        return;
    }

    let tmp = TempDir::new("byok-kill-eof");
    let pid_file = tmp.path().join("host-pid.txt");
    let exe = env::current_exe().expect("test binary exe");
    let mut shell: Child = Command::new(exe)
        .args([
            "--exact",
            "kill_shell_process_triggers_host_stdin_eof_exit_even_with_concurrent_child",
            "--nocapture",
        ])
        .env("BYOK_SHELL_KILL_CHILD_MODE", "mock")
        .env("BYOK_KILL_TEST_DIR", tmp.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child shell process");

    let host_pid = wait_for_pid_file(&pid_file, Duration::from_secs(10))
        .expect("child Host pid never recorded cleanly");
    assert!(
        is_pid_alive(host_pid),
        "Host must be running before shell kill"
    );

    shell.kill().expect("kill parent shell process");
    let _ = shell.wait();

    assert!(
        wait_until(Duration::from_secs(10), || !is_pid_alive(host_pid)),
        "Host pid {host_pid} did not exit on stdin EOF after shell kill"
    );
}

#[test]
fn live_ci_real_host_supervisor_lifecycle_and_kill_eof() {
    // Runs on CI runners where an unlocked OS credential store is provisioned (matching host-smoke.mjs).
    if env::var("BYOK_SHELL_E2E_LIVE_HOST").ok().as_deref() != Some("1") {
        return;
    }

    // 1. Live HostSupervisor connect -> hello -> running -> status -> clean stop() (exit 0).
    let bundle =
        try_real_host_bundle().expect("real Host bundle required when BYOK_SHELL_E2E_LIVE_HOST=1");
    let spec = HostCommandSpec::dev_node_host(bundle);
    let contract = BridgeContract::load().expect("contract loads");
    let cfg = HostSupervisorConfig::new(spec, contract);
    let supervisor = HostSupervisor::new(cfg, |_| {}, || {});
    supervisor.start();

    assert!(
        wait_until(Duration::from_secs(60), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { .. } | SupervisedHostState::Stopped { .. })
            )
        }),
        "live Host failed to reach Running or Stopped; last={:?}",
        supervisor.last_state()
    );
    let status = supervisor
        .call_renderer_forwarded("status", Value::Null)
        .expect("status RPC must succeed against live Host");
    assert!(status.is_object(), "status must return HostState object");
    supervisor
        .stop()
        .expect("clean shutdown against live Host must succeed");

    // 2. Hard-kill shell owning real dist/host/host.cjs -> real Host exits on stdin EOF within 15s.
    let tmp_kill = TempDir::new("byok-live-kill-eof");
    let pid_file = tmp_kill.path().join("host-pid.txt");
    let exe = env::current_exe().expect("test binary exe");
    let mut shell = Command::new(exe)
        .args([
            "--exact",
            "kill_shell_process_triggers_host_stdin_eof_exit_even_with_concurrent_child",
            "--nocapture",
        ])
        .env("BYOK_SHELL_KILL_CHILD_MODE", "real")
        .env("BYOK_KILL_TEST_DIR", tmp_kill.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child shell process for real Host");

    let host_pid = wait_for_pid_file(&pid_file, Duration::from_secs(30))
        .expect("real Host pid never recorded cleanly before kill");

    shell.kill().expect("kill parent shell owning real Host");
    let _ = shell.wait();

    assert!(
        wait_until(Duration::from_secs(15), || !is_pid_alive(host_pid)),
        "real Host pid {host_pid} did not self-exit on stdin EOF after shell kill"
    );
}

#[test]
fn supervisor_keep_awake_lifecycle_off_lock_and_typed_errors() {
    #[derive(Default)]
    struct PowerStats {
        acquires: AtomicUsize,
        releases: AtomicUsize,
        active: AtomicUsize,
    }

    struct FakeGuard {
        stats: Arc<PowerStats>,
    }

    impl Drop for FakeGuard {
        fn drop(&mut self) {
            self.stats.active.fetch_sub(1, Ordering::SeqCst);
            self.stats.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl KeepAwakeGuard for FakeGuard {}

    enum BackendMode {
        Allow,
        BlockOnce(Arc<(Mutex<(bool, bool)>, Condvar)>),
        Fail(PowerError),
    }

    struct FakePowerBackend {
        stats: Arc<PowerStats>,
        mode: BackendMode,
    }

    impl KeepAwakeBackend for FakePowerBackend {
        fn acquire(&self, who: &str, reason: &str) -> Result<Box<dyn KeepAwakeGuard>, PowerError> {
            assert!(!who.is_empty());
            assert!(!reason.is_empty());
            self.stats.acquires.fetch_add(1, Ordering::SeqCst);
            match &self.mode {
                BackendMode::Allow => {
                    self.stats.active.fetch_add(1, Ordering::SeqCst);
                    Ok(Box::new(FakeGuard {
                        stats: Arc::clone(&self.stats),
                    }))
                }
                BackendMode::BlockOnce(gate) => {
                    let (lock, cv) = &**gate;
                    let mut st = lock.lock().expect("block gate poisoned");
                    st.0 = true;
                    cv.notify_all();
                    while !st.1 {
                        st = cv.wait(st).expect("block gate poisoned");
                    }
                    drop(st);
                    self.stats.active.fetch_add(1, Ordering::SeqCst);
                    Ok(Box::new(FakeGuard {
                        stats: Arc::clone(&self.stats),
                    }))
                }
                BackendMode::Fail(err) => Err(err.clone()),
            }
        }
    }

    let contract = BridgeContract::load().expect("contract loads");

    // 1. 0 -> 1 -> 2 -> 0 -> 1 -> crash release -> restarted 0 -> 1 -> stop() release.
    {
        let tmp = TempDir::new("byok-power-lifecycle");
        let dir = tmp.path();
        let script = format!(
            r#"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = {dir};
const crashMarker = path.join(dir, 'crashed-once');
let currentWork = 0;
let timer = null;

function pushState(activeWork) {{
  currentWork = activeWork;
  process.stdout.write(JSON.stringify({{
    event: 'state',
    state: {{ state: 'running', pid: process.pid, activeWork }},
  }}) + '\n');
}}

function pollSteps() {{
  if (fs.existsSync(path.join(dir, 'step-busy1'))) {{
    fs.unlinkSync(path.join(dir, 'step-busy1'));
    pushState(1);
  }} else if (fs.existsSync(path.join(dir, 'step-busy2'))) {{
    fs.unlinkSync(path.join(dir, 'step-busy2'));
    pushState(2);
  }} else if (fs.existsSync(path.join(dir, 'step-idle0'))) {{
    fs.unlinkSync(path.join(dir, 'step-idle0'));
    pushState(0);
  }} else if (fs.existsSync(path.join(dir, 'step-crash'))) {{
    fs.unlinkSync(path.join(dir, 'step-crash'));
    pushState(1);
  }} else if (fs.existsSync(path.join(dir, 'do-exit'))) {{
    fs.unlinkSync(path.join(dir, 'do-exit'));
    fs.writeFileSync(crashMarker, '1');
    if (timer) clearInterval(timer);
    process.exit(1);
  }}
}}

const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => {{
  if (timer) clearInterval(timer);
  process.exit(0);
}});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    if (fs.existsSync(crashMarker)) {{
      pushState(1);
    }} else {{
      pushState(0);
      timer = setInterval(pollSteps, 10);
    }}
    return;
  }}
  if (msg.method === 'status') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ state: 'running', pid: process.pid, activeWork: currentWork }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    if (timer) clearInterval(timer);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            dir = serde_json::to_string(&dir.to_string_lossy().into_owned()).unwrap(),
        );
        let spec = write_node_script(dir, "power-lifecycle.mjs", &script);
        let stats = Arc::new(PowerStats::default());
        let backend = Arc::new(FakePowerBackend {
            stats: Arc::clone(&stats),
            mode: BackendMode::Allow,
        });
        let mut cfg = HostSupervisorConfig::new(spec, contract.clone()).with_power_backend(backend);
        cfg.initial_backoff = Duration::from_millis(50);
        cfg.max_backoff = Duration::from_millis(100);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_ref = Arc::clone(&observed);
        let supervisor = HostSupervisor::new(
            cfg,
            move |st| observed_ref.lock().expect("obs poisoned").push(st),
            || {},
        );
        supervisor.start();

        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 0, .. })
            )
        }));
        assert_eq!(stats.acquires.load(Ordering::SeqCst), 0);
        assert_eq!(stats.active.load(Ordering::SeqCst), 0);

        fs::write(dir.join("step-busy1"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 1, .. })
            )
        }));
        assert_eq!(stats.acquires.load(Ordering::SeqCst), 1);
        assert_eq!(stats.active.load(Ordering::SeqCst), 1);

        fs::write(dir.join("step-busy2"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 2, .. })
            )
        }));
        assert_eq!(
            stats.acquires.load(Ordering::SeqCst),
            1,
            "1 -> 2 must not re-acquire KeepAwake"
        );
        assert_eq!(stats.active.load(Ordering::SeqCst), 1);

        fs::write(dir.join("step-idle0"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 0, .. })
            )
        }));
        assert_eq!(stats.releases.load(Ordering::SeqCst), 1);
        assert_eq!(stats.active.load(Ordering::SeqCst), 0);

        // 0 -> 1 then crash without activeWork: 0 -> guard must release before Restarting.
        fs::write(dir.join("step-crash"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            stats.acquires.load(Ordering::SeqCst) == 2 && stats.active.load(Ordering::SeqCst) == 1
        }));
        observed.lock().expect("obs poisoned").clear();
        fs::write(dir.join("do-exit"), b"1").unwrap();

        assert!(wait_until(Duration::from_secs(5), || {
            observed
                .lock()
                .expect("obs poisoned")
                .iter()
                .any(|s| matches!(s, SupervisedHostState::Restarting { .. }))
        }));
        assert!(wait_until(Duration::from_secs(5), || {
            stats.acquires.load(Ordering::SeqCst) == 3 && stats.active.load(Ordering::SeqCst) == 1
        }));
        assert!(
            stats.releases.load(Ordering::SeqCst) >= 2,
            "crash release must happen before Restarting re-acquire"
        );

        supervisor
            .stop()
            .expect("clean stop releases active KeepAwake");
        assert_eq!(stats.releases.load(Ordering::SeqCst), 3);
        assert_eq!(stats.active.load(Ordering::SeqCst), 0);
        assert_eq!(supervisor.last_power_error(), None);
    }

    // 2. Off-lock proof: slow/blocking OS acquire must never block last_state() or bridge RPCs.
    {
        let tmp = TempDir::new("byok-power-offlock");
        let dir = tmp.path();
        let script = format!(
            r#"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = {dir};
let currentWork = 0;
const timer = setInterval(() => {{
  if (fs.existsSync(path.join(dir, 'go-busy'))) {{
    fs.unlinkSync(path.join(dir, 'go-busy'));
    currentWork = 1;
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'running', pid: process.pid, activeWork: 1 }},
    }}) + '\n');
  }}
}}, 10);

const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => {{
  clearInterval(timer);
  process.exit(0);
}});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: 0 }} }}) + '\n');
    return;
  }}
  if (msg.method === 'status') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ state: 'running', pid: process.pid, activeWork: currentWork }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    clearInterval(timer);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            dir = serde_json::to_string(&dir.to_string_lossy().into_owned()).unwrap(),
        );
        let spec = write_node_script(dir, "power-offlock.mjs", &script);
        let gate = Arc::new((Mutex::new((false, false)), Condvar::new()));
        let stats = Arc::new(PowerStats::default());
        let backend = Arc::new(FakePowerBackend {
            stats: Arc::clone(&stats),
            mode: BackendMode::BlockOnce(Arc::clone(&gate)),
        });
        let cfg = HostSupervisorConfig::new(spec, contract.clone()).with_power_backend(backend);
        let supervisor = HostSupervisor::new(cfg, |_| {}, || {});
        supervisor.start();

        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 0, .. })
            )
        }));

        fs::write(dir.join("go-busy"), b"1").unwrap();
        {
            let (lock, cv) = &*gate;
            let mut st = lock.lock().expect("block gate poisoned");
            while !st.0 {
                st = cv.wait(st).expect("block gate poisoned");
            }
        }

        // While backend.acquire() is blocked, last_state() and bridge RPCs must not stall.
        let prev = supervisor.last_state();
        assert!(matches!(
            prev,
            Some(SupervisedHostState::Running { active_work: 0, .. })
        ));
        let status = supervisor
            .call_renderer_forwarded("status", Value::Null)
            .expect("bridge status RPC must proceed while acquire() is blocked");
        assert_eq!(status.get("activeWork").and_then(Value::as_u64), Some(1));

        {
            let (lock, cv) = &*gate;
            let mut st = lock.lock().expect("block gate poisoned");
            st.1 = true;
            cv.notify_all();
        }
        assert!(wait_until(Duration::from_secs(5), || {
            stats.active.load(Ordering::SeqCst) == 1
                && matches!(
                    supervisor.last_state(),
                    Some(SupervisedHostState::Running { active_work: 1, .. })
                )
        }));
        drop(supervisor);
        assert_eq!(stats.releases.load(Ordering::SeqCst), 1);
        assert_eq!(stats.active.load(Ordering::SeqCst), 0);
    }

    // 3. Typed acquire failure delivers exact PowerError without disrupting Host supervision or repeating on 1 -> 2.
    {
        let tmp = TempDir::new("byok-power-error");
        let dir = tmp.path();
        let script = format!(
            r#"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = {dir};
let currentWork = 1;
const timer = setInterval(() => {{
  if (fs.existsSync(path.join(dir, 'step-busy2'))) {{
    fs.unlinkSync(path.join(dir, 'step-busy2'));
    currentWork = 2;
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'running', pid: process.pid, activeWork: 2 }},
    }}) + '\n');
  }}
}}, 10);

const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => {{
  clearInterval(timer);
  process.exit(0);
}});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: 1 }} }}) + '\n');
    return;
  }}
  if (msg.method === 'status') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ state: 'running', pid: process.pid, activeWork: currentWork }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    clearInterval(timer);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            dir = serde_json::to_string(&dir.to_string_lossy().into_owned()).unwrap(),
        );
        let spec = write_node_script(dir, "power-error.mjs", &script);
        let expected_err = PowerError::Unavailable {
            backend: "fake-dbus",
            detail: "polkit denied".to_owned(),
        };
        let stats = Arc::new(PowerStats::default());
        let backend = Arc::new(FakePowerBackend {
            stats: Arc::clone(&stats),
            mode: BackendMode::Fail(expected_err.clone()),
        });
        let seen_errors = Arc::new(Mutex::new(Vec::new()));
        let seen_errors_ref = Arc::clone(&seen_errors);
        let cfg = HostSupervisorConfig::new(spec, contract.clone())
            .with_power_backend(backend)
            .with_on_power_error(move |err| {
                seen_errors_ref.lock().expect("errors poisoned").push(err);
            });
        let supervisor = HostSupervisor::new(cfg, |_| {}, || {});
        supervisor.start();

        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 1, .. })
            )
        }));
        assert_eq!(supervisor.last_power_error(), Some(expected_err.clone()));
        assert_eq!(
            *seen_errors.lock().expect("errors poisoned"),
            vec![expected_err]
        );
        assert_eq!(stats.acquires.load(Ordering::SeqCst), 1);

        fs::write(dir.join("step-busy2"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 2, .. })
            )
        }));
        assert_eq!(stats.acquires.load(Ordering::SeqCst), 1);
        assert_eq!(seen_errors.lock().expect("errors poisoned").len(), 1);
        let status = supervisor
            .call_renderer_forwarded("status", Value::Null)
            .expect("Host RPCs remain healthy after KeepAwake acquire failure");
        assert_eq!(status.get("activeWork").and_then(Value::as_u64), Some(2));
        supervisor.stop().expect("clean stop succeeds");
    }

    // 4. Stale Host exit during slow KeepAwake::acquire drops the stale guard and never overwrites newer state.
    {
        let tmp = TempDir::new("byok-power-stale-exit");
        let dir = tmp.path();
        let script = format!(
            r#"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = {dir};
const crashMarker = path.join(dir, 'crashed-once');
let timer = null;

const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => {{
  if (timer) clearInterval(timer);
  process.exit(0);
}});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    if (fs.existsSync(crashMarker)) {{
      process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: 0 }} }}) + '\n');
    }} else {{
      process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: 1 }} }}) + '\n');
      timer = setInterval(() => {{
        if (fs.existsSync(path.join(dir, 'do-exit'))) {{
          fs.unlinkSync(path.join(dir, 'do-exit'));
          fs.writeFileSync(crashMarker, '1');
          clearInterval(timer);
          process.exit(1);
        }}
      }}, 10);
    }}
    return;
  }}
  if (msg.method === 'shutdown') {{
    if (timer) clearInterval(timer);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            dir = serde_json::to_string(&dir.to_string_lossy().into_owned()).unwrap(),
        );
        let spec = write_node_script(dir, "power-stale-exit.mjs", &script);
        let gate = Arc::new((Mutex::new((false, false)), Condvar::new()));
        let stats = Arc::new(PowerStats::default());
        let backend = Arc::new(FakePowerBackend {
            stats: Arc::clone(&stats),
            mode: BackendMode::BlockOnce(Arc::clone(&gate)),
        });
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_ref = Arc::clone(&observed);
        let mut cfg = HostSupervisorConfig::new(spec, contract).with_power_backend(backend);
        cfg.initial_backoff = Duration::from_millis(50);
        cfg.max_backoff = Duration::from_millis(100);
        let supervisor = HostSupervisor::new(
            cfg,
            move |st| observed_ref.lock().expect("obs poisoned").push(st),
            || {},
        );
        supervisor.start();

        {
            let (lock, cv) = &*gate;
            let mut st = lock.lock().expect("block gate poisoned");
            while !st.0 {
                st = cv.wait(st).expect("block gate poisoned");
            }
        }

        // Crash Run 1 while Run 1's dispatcher is still blocked inside backend.acquire().
        fs::write(dir.join("do-exit"), b"1").unwrap();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                supervisor.last_state(),
                Some(SupervisedHostState::Running { active_work: 0, .. })
            )
        }));
        let run2_state = supervisor.last_state().expect("Run 2 state present");
        observed.lock().expect("obs poisoned").clear();

        // Unblock Run 1's acquire(): stale guard must drop cleanly and Run 1's Running(1) must not overwrite Run 2.
        {
            let (lock, cv) = &*gate;
            let mut st = lock.lock().expect("block gate poisoned");
            st.1 = true;
            cv.notify_all();
        }
        assert!(wait_until(Duration::from_secs(5), || {
            stats.releases.load(Ordering::SeqCst) == 1 && stats.active.load(Ordering::SeqCst) == 0
        }));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(stats.active.load(Ordering::SeqCst), 0);
        assert_eq!(supervisor.last_state(), Some(run2_state));
        assert!(
            !observed
                .lock()
                .expect("obs poisoned")
                .iter()
                .any(|s| matches!(s, SupervisedHostState::Running { active_work: 1, .. })),
            "stale Run 1 state must not be emitted after exit"
        );
        supervisor.stop().expect("clean stop succeeds");
    }
}

#[test]
fn late_reply_after_call_timeout_does_not_kill_healthy_host() {
    let tmp = TempDir::new("byok-late-reply-timeout");
    let dir = tmp.path();
    let script = format!(
        r#"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = {dir};
let lastRefreshId = null;
const timer = setInterval(() => {{
  if (fs.existsSync(path.join(dir, 'send-dup')) && lastRefreshId !== null) {{
    fs.unlinkSync(path.join(dir, 'send-dup'));
    process.stdout.write(JSON.stringify({{ id: lastRefreshId, result: null }}) + '\n');
  }}
}}, 10);

const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => {{
  clearInterval(timer);
  process.exit(0);
}});
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'running', pid: process.pid, activeWork: 0 }} }}) + '\n');
    return;
  }}
  if (msg.method === 'status') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ state: 'running', pid: process.pid, activeWork: 0 }} }}) + '\n');
    return;
  }}
  if (msg.method === 'keys.profilesChanged') {{
    lastRefreshId = msg.id;
    setTimeout(() => {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ ok: true }} }}) + '\n');
    }}, 350);
    return;
  }}
  if (msg.method === 'shutdown') {{
    clearInterval(timer);
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
        dir = serde_json::to_string(&dir.to_string_lossy().into_owned()).unwrap(),
    );
    let spec = write_node_script(dir, "late-reply-host.mjs", &script);
    let contract = BridgeContract::load().expect("contract loads");
    let mut cfg = HostSupervisorConfig::new(spec, contract);
    // Keep post-kill respawn parked well past `supervisor.stop()` so CI thread scheduling cannot respawn a fresh Host before stop verifies unclean kill authority (`stop()` wakes `backoff_wait` via `cv.notify_all()`).
    cfg.initial_backoff = Duration::from_secs(30);
    cfg.max_backoff = Duration::from_secs(30);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_ref = Arc::clone(&observed);
    let supervisor = HostSupervisor::new(
        cfg,
        move |st| observed_ref.lock().expect("obs poisoned").push(st),
        || {},
    );
    supervisor.start();

    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            supervisor.last_state(),
            Some(SupervisedHostState::Running { .. })
        )
    }));
    let initial_status = supervisor
        .call_renderer_forwarded("status", Value::Null)
        .expect("initial status succeeds");
    let initial_pid = initial_status.get("pid").and_then(Value::as_u64).unwrap();

    let timeout_err = supervisor
        .call_shell_to_host_timeout(
            "keys.profilesChanged",
            Value::Null,
            Duration::from_millis(40),
        )
        .expect_err("keys.profilesChanged must time out");
    assert_eq!(timeout_err.code, BridgeErrorCode::CallTimeout);

    // Wait past the Host's delayed reply (~350ms) and prove the same Host stayed alive.
    thread::sleep(Duration::from_millis(550));
    let after_late_reply = supervisor
        .call_renderer_forwarded("status", Value::Null)
        .expect("valid single late reply must keep healthy Host alive");
    assert_eq!(
        after_late_reply.get("pid").and_then(Value::as_u64),
        Some(initial_pid)
    );

    // A duplicate reply after the timed-out tombstone is consumed must still fail closed.
    observed.lock().expect("obs poisoned").clear();
    fs::write(dir.join("send-dup"), b"1").unwrap();
    assert!(wait_until(Duration::from_secs(5), || {
        observed
            .lock()
            .expect("obs poisoned")
            .iter()
            .any(|s| matches!(s, SupervisedHostState::Restarting { .. }))
    }));
    let stop_err = supervisor
        .stop()
        .expect_err("duplicate late reply must kill Host fail-closed");
    assert!(
        stop_err.0.contains("Host exited"),
        "unexpected stop error after duplicate reply kill: {stop_err}"
    );
}

#[test]
fn keys_list_and_s1_recovery_are_mutually_exclusive_in_both_orders() {
    let tmp = TempDir::new("byok-list-s1-mutex");
    let store_path = tmp.path().join("store.json");
    fs::write(&store_path, "initial-store").expect("seed store");
    let list_started = tmp.path().join("list-started");
    let list_release = tmp.path().join("list-release");
    let s1_spawned = tmp.path().join("s1-spawned");

    let contract = BridgeContract::load().expect("contract loads");
    let custody_cmd = contract.host_commands.custody.clone();
    let restore_cmd = contract.host_commands.restore.clone();
    let status_cmd = contract.host_commands.snapshot_status.clone();

    let script = format!(
        r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd] = process.argv.slice(2);
if (subcmd === {custody_cmd}) {{
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {{ input += chunk; }});
  process.stdin.on('end', () => {{
    const req = JSON.parse(input);
    if (req.op !== 'list') {{
      process.stdout.write(JSON.stringify({{ ok: false, code: 'unexpected', message: 'expected list' }}) + '\n');
      process.exit(1);
    }}
    fs.writeFileSync({list_started}, 'started');
    const timer = setInterval(() => {{
      if (fs.existsSync({list_release})) {{
        clearInterval(timer);
        process.stdout.write(JSON.stringify({{
          ok: true,
          statuses: [{{ profile_ref: 'zai-main', display_name: 'GLM', provider_kind: 'zai', adapter: 'pi', auth_mode: 'api_key', model: 'glm-4.7', secret_configured: true, profile_revision: 'r1', enabled: true, capabilities: [] }}],
        }}) + '\n');
        process.exit(0);
      }}
    }}, 10);
  }});
}} else if (subcmd === {restore_cmd} || subcmd === {status_cmd}) {{
  fs.writeFileSync({s1_spawned}, subcmd);
  fs.writeFileSync({store_path}, 'mutated-by-s1');
  process.stdout.write(JSON.stringify({{ ok: true, snapshot: null }}) + '\n');
}} else {{
  const rl = readline.createInterface({{ input: process.stdin }});
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {{
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
      process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'stopped', pid: process.pid, storeRefused: false, reason: 'stopped' }} }}) + '\n');
    }} else if (msg.method === 'keys.profilesChanged') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ ok: true }} }}) + '\n');
    }} else if (msg.method === 'shutdown') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
      process.exit(0);
    }}
  }});
}}
"#,
        custody_cmd = serde_json::to_string(&custody_cmd).unwrap(),
        restore_cmd = serde_json::to_string(&restore_cmd).unwrap(),
        status_cmd = serde_json::to_string(&status_cmd).unwrap(),
        list_started = serde_json::to_string(&list_started.to_string_lossy().into_owned()).unwrap(),
        list_release = serde_json::to_string(&list_release.to_string_lossy().into_owned()).unwrap(),
        s1_spawned = serde_json::to_string(&s1_spawned.to_string_lossy().into_owned()).unwrap(),
        store_path = serde_json::to_string(&store_path.to_string_lossy().into_owned()).unwrap(),
    );

    let spec = write_node_script(tmp.path(), "list-s1-host.mjs", &script);
    let supervisor = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(spec, contract),
        |_| {},
        || {},
    ));
    supervisor.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            supervisor.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));

    let lock = MaintenanceLock::new();
    let router = Arc::new(ShellRouter::new(
        Arc::clone(&supervisor),
        lock.clone(),
        "1.0.0",
    ));

    // Order 1: S1 maintenance active -> keys.list refuses without spawning child or changing store.
    let s1_guard = lock.try_begin().expect("acquire S1 guard");
    let list_err = router
        .dispatch_renderer("keys.list", Value::Null)
        .expect_err("keys.list must refuse while S1 maintenance holds lock");
    assert_eq!(list_err.code, "PROVIDER_CONFIGURATION_BUSY");
    assert!(
        !list_started.exists(),
        "custody child must not spawn under S1 lock"
    );
    assert_eq!(fs::read_to_string(&store_path).unwrap(), "initial-store");
    drop(s1_guard);

    // Order 2: keys.list child active -> S1 restore & lock acquisition refuse until list child exits.
    let router_bg = Arc::clone(&router);
    let list_handle = thread::spawn(move || router_bg.dispatch_renderer("keys.list", Value::Null));
    assert!(
        wait_until(Duration::from_secs(5), || list_started.exists()),
        "custody list child should start"
    );
    assert!(
        lock.is_busy(),
        "MaintenanceLock must stay busy while keys.list child runs"
    );
    assert!(matches!(lock.try_begin(), Err(MaintenanceBusyError)));
    let restore_err = router
        .restore("1.0.0", "2026-11-25T00-00-00.000Z", |_| {})
        .expect_err("S1 restore must refuse while keys.list child is active");
    assert_eq!(restore_err.code, "maintenance_busy");
    assert!(
        !s1_spawned.exists(),
        "S1 command must not spawn while keys.list runs"
    );
    assert_eq!(fs::read_to_string(&store_path).unwrap(), "initial-store");

    fs::write(&list_release, "go").expect("release list child");
    let listed = list_handle
        .join()
        .expect("list thread joins")
        .expect("keys.list succeeds after release");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert!(
        wait_until(Duration::from_secs(3), || !lock.is_busy()),
        "MaintenanceLock must clear once keys.list child exits"
    );
    let _post_guard = lock
        .try_begin()
        .expect("S1 lock succeeds after keys.list exits");
    supervisor.stop().expect("clean shutdown");
}

#[test]
fn quit_waits_for_delayed_custody_submit_and_list_and_preserves_store_intact() {
    let tmp = TempDir::new("byok-quit-custody");
    let store_path = tmp.path().join("store.json");
    let hung_store_path = tmp.path().join("hung-store.json");
    fs::write(&store_path, r#"{"version":1,"profiles":[]}"#).expect("seed store");

    let submit_started = tmp.path().join("submit-started");
    let submit_release = tmp.path().join("submit-release");
    let list_started = tmp.path().join("list-started");
    let list_release = tmp.path().join("list-release");
    let hung_started = tmp.path().join("hung-started");
    let hung_release = tmp.path().join("hung-release");

    let contract = BridgeContract::load().expect("contract loads");
    let custody_cmd = contract.host_commands.custody.clone();

    let script = format!(
        r#"
import fs from 'node:fs';

const [subcmd] = process.argv.slice(2);
if (subcmd !== {custody_cmd}) {{
  process.exit(2);
}}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {{ input += chunk; }});
process.stdin.on('end', () => {{
  const req = JSON.parse(input);
  if (req.op === 'list') {{
    fs.writeFileSync({list_started}, 'started');
    const timer = setInterval(() => {{
      if (fs.existsSync({list_release})) {{
        clearInterval(timer);
        process.stdout.write(JSON.stringify({{
          ok: true,
          statuses: [{{ profile_ref: 'zai-main' }}],
        }}) + '\n');
        process.exit(0);
      }}
    }}, 10);
    return;
  }}
  if (req.profileRef === 'hung-write') {{
    fs.writeFileSync({hung_started}, 'started');
    const timer = setInterval(() => {{
      if (fs.existsSync({hung_release})) {{
        clearInterval(timer);
        fs.writeFileSync({hung_store_path}, 'committed-after-quit-bound');
        process.stdout.write(JSON.stringify({{ ok: true, status: {{ profile_ref: 'hung-write' }} }}) + '\n');
        process.exit(0);
      }}
    }}, 10);
    return;
  }}
  fs.writeFileSync({submit_started}, 'started');
  const timer = setInterval(() => {{
    if (fs.existsSync({submit_release})) {{
      clearInterval(timer);
      const tmpStore = {store_path} + '.tmp';
      fs.writeFileSync(tmpStore, JSON.stringify({{ version: 2, profiles: ['zai-main'] }}));
      fs.renameSync(tmpStore, {store_path});
      process.stdout.write(JSON.stringify({{ ok: true, status: {{ profile_ref: 'zai-main' }} }}) + '\n');
      process.exit(0);
    }}
  }}, 10);
}});
"#,
        custody_cmd = serde_json::to_string(&custody_cmd).unwrap(),
        store_path = serde_json::to_string(&store_path.to_string_lossy().into_owned()).unwrap(),
        hung_store_path =
            serde_json::to_string(&hung_store_path.to_string_lossy().into_owned()).unwrap(),
        submit_started =
            serde_json::to_string(&submit_started.to_string_lossy().into_owned()).unwrap(),
        submit_release =
            serde_json::to_string(&submit_release.to_string_lossy().into_owned()).unwrap(),
        list_started = serde_json::to_string(&list_started.to_string_lossy().into_owned()).unwrap(),
        list_release = serde_json::to_string(&list_release.to_string_lossy().into_owned()).unwrap(),
        hung_started = serde_json::to_string(&hung_started.to_string_lossy().into_owned()).unwrap(),
        hung_release = serde_json::to_string(&hung_release.to_string_lossy().into_owned()).unwrap(),
    );
    let spec = write_node_script(tmp.path(), "quit-custody.mjs", &script);

    // 1. Delayed keys.submit: begin_quit() blocks until CustodyGuard drops and the store commit finishes intact.
    let submit_lock = MaintenanceLock::new();
    let spec_bg = spec.clone();
    let custody_bg = custody_cmd.clone();
    let lock_bg = submit_lock.clone();
    let submit_handle = thread::spawn(move || {
        submit_to_custody(
            &spec_bg,
            &custody_bg,
            SecretBytes::from_string(
                r#"{"op":"replace_secret","profileRef":"zai-main","secret":"sk-test"}"#.to_owned(),
            ),
            Duration::from_secs(10),
            Some(&lock_bg),
            None,
        )
    });

    assert!(
        wait_until(Duration::from_secs(5), || submit_started.exists()),
        "delayed custody submit child should start"
    );
    assert_eq!(submit_lock.active_custody_count(), 1);

    let quit_lock = submit_lock.clone();
    let quit_handle = thread::spawn(move || quit_lock.begin_quit());
    assert!(
        wait_until(Duration::from_secs(2), || submit_lock.is_quitting()),
        "begin_quit should mark lock quitting immediately"
    );

    // While quitting, new custody holders must be refused without spawning.
    let refused_while_quitting = submit_to_custody(
        &spec,
        &custody_cmd,
        SecretBytes::from_string(
            r#"{"op":"replace_secret","profileRef":"other","secret":"sk-2"}"#.to_owned(),
        ),
        Duration::from_secs(1),
        Some(&submit_lock),
        None,
    )
    .expect_err("new custody submit must refuse while quitting");
    assert_eq!(refused_while_quitting.code, "PROVIDER_CONFIGURATION_BUSY");

    thread::sleep(Duration::from_millis(100));
    assert!(
        !quit_handle.is_finished(),
        "begin_quit must not return while delayed keys.submit custody guard is still held"
    );
    assert_eq!(
        fs::read_to_string(&store_path).unwrap(),
        r#"{"version":1,"profiles":[]}"#
    );

    fs::write(&submit_release, "go").expect("release delayed submit child");
    assert_eq!(
        quit_handle.join().expect("quit thread joins"),
        QuitOutcome::Quit
    );
    assert_eq!(
        submit_lock.active_custody_count(),
        0,
        "begin_quit must return only after custody guard drops"
    );
    let submitted = submit_handle
        .join()
        .expect("submit thread joins")
        .expect("delayed keys.submit succeeds");
    assert_eq!(submitted["profile_ref"], json!("zai-main"));
    assert_eq!(
        fs::read_to_string(&store_path).unwrap(),
        r#"{"version":2,"profiles":["zai-main"]}"#,
        "store must be intact after delayed custody write completes before quit returns"
    );

    // 2. Delayed keys.list: begin_quit() also waits for active list custody guard before returning.
    let list_lock = MaintenanceLock::new();
    let spec_bg = spec.clone();
    let custody_bg = custody_cmd.clone();
    let lock_bg = list_lock.clone();
    let list_handle = thread::spawn(move || {
        list_from_custody(
            &spec_bg,
            &custody_bg,
            Duration::from_secs(10),
            Some(&lock_bg),
            None,
        )
    });

    assert!(
        wait_until(Duration::from_secs(5), || list_started.exists()),
        "delayed custody list child should start"
    );
    assert_eq!(list_lock.active_custody_count(), 1);

    let quit_lock = list_lock.clone();
    let quit_handle = thread::spawn(move || quit_lock.begin_quit());
    assert!(wait_until(Duration::from_secs(2), || list_lock.is_quitting()));
    thread::sleep(Duration::from_millis(100));
    assert!(
        !quit_handle.is_finished(),
        "begin_quit must not return while delayed keys.list custody guard is still held"
    );

    fs::write(&list_release, "go").expect("release delayed list child");
    assert_eq!(
        quit_handle.join().expect("quit thread joins"),
        QuitOutcome::Quit
    );
    assert_eq!(list_lock.active_custody_count(), 0);
    let statuses = list_handle
        .join()
        .expect("list thread joins")
        .expect("delayed keys.list succeeds");
    assert_eq!(statuses.len(), 1);

    // 3. Hung keys.submit (kill_on_timeout = false): quit wait is bounded so quit cannot hang
    //    forever, while the detached custody child still finishes writing cleanly without being killed.
    let hung_lock = MaintenanceLock::new();
    let timeout_err = submit_to_custody(
        &spec,
        &custody_cmd,
        SecretBytes::from_string(
            r#"{"op":"replace_secret","profileRef":"hung-write","secret":"sk-hung"}"#.to_owned(),
        ),
        Duration::from_millis(80),
        Some(&hung_lock),
        None,
    )
    .expect_err("hung submit should return custody_timeout while child continues");
    assert_eq!(timeout_err.code, "custody_timeout");
    assert!(
        wait_until(Duration::from_secs(5), || hung_started.exists()),
        "hung custody child should remain alive past submit_to_custody deadline"
    );
    assert_eq!(hung_lock.active_custody_count(), 1);

    let (quit_entered_tx, quit_entered_rx) = mpsc::channel();
    hung_lock.on_quit_requested(move || {
        let _ = quit_entered_tx.send(());
    });
    let (quit_done_tx, quit_done_rx) = mpsc::channel();
    let quit_hung_lock = hung_lock.clone();
    let quit_hung_handle = thread::spawn(move || {
        let outcome = quit_hung_lock.begin_quit_with_custody_wait(Duration::from_millis(50));
        let _ = quit_done_tx.send(outcome);
    });
    quit_entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("begin_quit_with_custody_wait must enter and mark quitting");
    let bounded_outcome = quit_done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("bounded custody wait must return without hanging forever");
    assert_eq!(bounded_outcome, QuitOutcome::Quit);
    quit_hung_handle.join().expect("bounded quit thread joins");
    assert_eq!(
        hung_lock.active_custody_count(),
        1,
        "detached hung custody child is still running when bounded wait returns"
    );
    assert!(
        !hung_store_path.exists(),
        "detached hung custody child must still be blocked before release"
    );
    fs::write(&hung_release, "go").expect("release hung submit child");
    assert!(
        wait_until(Duration::from_secs(5), || hung_lock.active_custody_count()
            == 0),
        "CustodyGuard drop after bounded quit must cleanly decrement active_custody to 0"
    );
    assert_eq!(
        fs::read_to_string(&hung_store_path).unwrap(),
        "committed-after-quit-bound",
        "detached hung submit child must complete its store write cleanly before CustodyGuard drops"
    );

    // 4. Multiple concurrent custody holders: begin_quit() waits until EVERY holder drops.
    let multi_lock = MaintenanceLock::new();
    let g1 = multi_lock.try_begin_custody().expect("first custody guard");
    let g2 = multi_lock
        .try_begin_custody()
        .expect("second custody guard");
    assert_eq!(multi_lock.active_custody_count(), 2);
    let quit_multi_lock = multi_lock.clone();
    let quit_multi = thread::spawn(move || quit_multi_lock.begin_quit());
    assert!(wait_until(Duration::from_secs(2), || multi_lock.is_quitting()));
    drop(g1);
    thread::sleep(Duration::from_millis(80));
    assert!(
        !quit_multi.is_finished(),
        "begin_quit must keep waiting while second custody guard is still held"
    );
    assert_eq!(multi_lock.active_custody_count(), 1);
    drop(g2);
    assert_eq!(
        quit_multi.join().expect("multi quit joins"),
        QuitOutcome::Quit
    );
    assert_eq!(multi_lock.active_custody_count(), 0);
}

#[test]
fn recovery_restore_and_start_fresh_confirm_handover_relaunch_and_recover_keys_list_after_restart()
{
    let tmp = TempDir::new("byok-recovery-restart");
    let contract = BridgeContract::load().expect("contract loads");

    let build_mock_host = |name: &str,
                           store_refused: bool,
                           has_snapshot: bool,
                           fail_start_fresh: bool|
     -> (HostCommandSpec, PathBuf) {
        let shutdown_log = tmp.path().join(format!("{name}-shutdowns.log"));
        let script = format!(
            r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  const snapshot = {has_snapshot} ? {{ version: arg1, target: '/tmp/snapshot-target' }} : null;
  process.stdout.write(JSON.stringify({{ ok: true, snapshot }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  process.stdout.write(JSON.stringify({{ ok: true, asidePath: '/tmp/restored.aside' }}) + '\n');
  process.exit(0);
}}
if (subcmd === {start_fresh_cmd}) {{
  if ({fail_start_fresh}) {{
    process.stdout.write(JSON.stringify({{
      ok: false,
      code: 'clear_failed',
      message: 'simulated enrollment clear refusal',
      movedBack: true,
    }}) + '\n');
    process.exit(1);
  }}
  process.stdout.write(JSON.stringify({{
    ok: true,
    moved: [{{ from: '/tmp/host', to: '/tmp/host.aside' }}],
  }}) + '\n');
  process.exit(0);
}}
if (subcmd === {custody_cmd}) {{
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {{ raw += chunk; }});
  process.stdin.on('end', () => {{
    const req = JSON.parse(raw);
    if (req.op === 'list') {{
      process.stdout.write(JSON.stringify({{
        ok: true,
        statuses: [{{ profile_ref: 'recovered-main', enabled: true }}],
      }}) + '\n');
      process.exit(0);
    }}
    process.stdout.write(JSON.stringify({{ ok: false, code: 'unexpected', message: 'unexpected op' }}) + '\n');
    process.exit(1);
  }});
}} else {{
  const rl = readline.createInterface({{ input: process.stdin }});
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {{
    const msg = JSON.parse(line);
    if (msg.method === 'hello') {{
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
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
            start_fresh_cmd = serde_json::to_string(&contract.host_commands.start_fresh).unwrap(),
            custody_cmd = serde_json::to_string(&contract.host_commands.custody).unwrap(),
            shutdown_log =
                serde_json::to_string(&shutdown_log.to_string_lossy().into_owned()).unwrap(),
        );
        let spec = write_node_script(tmp.path(), &format!("{name}.mjs"), &script);
        (spec, shutdown_log)
    };

    let shutdown_count = |path: &Path| -> usize {
        fs::read_to_string(path)
            .map(|text| text.lines().count())
            .unwrap_or(0)
    };

    // 1. shell.restore: seals MaintenanceLock with confirm(), triggers relaunch, begin_quit() -> HandedOver
    //    without stopping Host twice; old sealed process returns PROVIDER_CONFIGURATION_BUSY on keys.list,
    //    and a fresh restarted process recovers keys.list cleanly.
    let (restore_spec, restore_shutdowns) = build_mock_host("restore-ok", false, true, false);
    let sup_restore = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(restore_spec.clone(), contract.clone()),
        |_| {},
        || {},
    ));
    sup_restore.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            sup_restore.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));

    let lock_restore = MaintenanceLock::new();
    let router_restore = ShellRouter::new(Arc::clone(&sup_restore), lock_restore.clone(), "1.0.0");
    let mut relaunch_calls = 0usize;
    let mut quit_inside_relaunch = None;
    let lock_for_cb = lock_restore.clone();
    let restored = router_restore
        .restore("1.0.0", "2026-11-25T00-00-00.000Z", |err| {
            assert!(err.is_none());
            relaunch_calls += 1;
            assert!(lock_for_cb.is_handed_over());
            quit_inside_relaunch = Some(lock_for_cb.begin_quit());
        })
        .expect("shell.restore succeeds");
    assert_eq!(restored.aside_path, "/tmp/restored.aside");
    assert_eq!(relaunch_calls, 1);
    assert_eq!(quit_inside_relaunch, Some(QuitOutcome::HandedOver));
    assert_eq!(lock_restore.begin_quit(), QuitOutcome::HandedOver);
    assert_eq!(
        shutdown_count(&restore_shutdowns),
        1,
        "Host must be stopped exactly once during restore handover"
    );
    let sealed_err = router_restore
        .dispatch_renderer("keys.list", Value::Null)
        .expect_err("sealed pre-restart process must refuse keys.list");
    assert_eq!(sealed_err.code, "PROVIDER_CONFIGURATION_BUSY");

    // Simulated restarted process (fresh unlocked MaintenanceLock): keys.list recovers.
    let sup_after_restore = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(restore_spec, contract.clone()),
        |_| {},
        || {},
    ));
    let router_after_restore = ShellRouter::new(
        Arc::clone(&sup_after_restore),
        MaintenanceLock::new(),
        "1.0.0",
    );
    let listed_after_restore = router_after_restore
        .dispatch_renderer("keys.list", Value::Null)
        .expect("restarted process keys.list succeeds");
    assert_eq!(listed_after_restore.as_array().map(Vec::len), Some(1));

    // 2. shell.startFresh: same handover + relaunch + single Host stop + post-restart keys.list recovery.
    let (fresh_spec, fresh_shutdowns) = build_mock_host("fresh-ok", true, false, false);
    let sup_fresh = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(fresh_spec.clone(), contract.clone()),
        |_| {},
        || {},
    ));
    sup_fresh.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            sup_fresh.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: true,
                ..
            })
        )
    }));

    let lock_fresh = MaintenanceLock::new();
    let router_fresh = ShellRouter::new(Arc::clone(&sup_fresh), lock_fresh.clone(), "1.0.0");
    let mut fresh_relaunch_calls = 0usize;
    let mut fresh_quit_outcome = None;
    let lock_for_cb = lock_fresh.clone();
    let started_fresh = router_fresh
        .start_fresh("2026-11-25T00-01-00.000Z", |err| {
            assert!(err.is_none());
            fresh_relaunch_calls += 1;
            assert!(lock_for_cb.is_handed_over());
            fresh_quit_outcome = Some(lock_for_cb.begin_quit());
        })
        .expect("shell.startFresh succeeds");
    assert_eq!(started_fresh.moved.len(), 1);
    assert_eq!(fresh_relaunch_calls, 1);
    assert_eq!(fresh_quit_outcome, Some(QuitOutcome::HandedOver));
    assert_eq!(lock_fresh.begin_quit(), QuitOutcome::HandedOver);
    assert_eq!(shutdown_count(&fresh_shutdowns), 1);
    assert_eq!(
        router_fresh
            .dispatch_renderer("keys.list", Value::Null)
            .expect_err("sealed pre-restart process must refuse keys.list")
            .code,
        "PROVIDER_CONFIGURATION_BUSY"
    );

    let sup_after_fresh = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(fresh_spec, contract.clone()),
        |_| {},
        || {},
    ));
    let router_after_fresh = ShellRouter::new(
        Arc::clone(&sup_after_fresh),
        MaintenanceLock::new(),
        "1.0.0",
    );
    let listed_after_fresh = router_after_fresh
        .dispatch_renderer("keys.list", Value::Null)
        .expect("restarted process keys.list succeeds after startFresh");
    assert_eq!(listed_after_fresh.as_array().map(Vec::len), Some(1));

    // 3. Post-stop failure on shell.startFresh still confirms handover and calls relaunch(Some(err)).
    let (fresh_fail_spec, fresh_fail_shutdowns) = build_mock_host("fresh-fail", true, false, true);
    let sup_fresh_fail = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(fresh_fail_spec, contract.clone()),
        |_| {},
        || {},
    ));
    sup_fresh_fail.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            sup_fresh_fail.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: true,
                ..
            })
        )
    }));
    let lock_fail = MaintenanceLock::new();
    let router_fail = ShellRouter::new(Arc::clone(&sup_fresh_fail), lock_fail.clone(), "1.0.0");
    let mut saw_failure = false;
    let err = router_fail
        .start_fresh("2026-11-25T00-02-00.000Z", |failure| {
            saw_failure = failure.is_some();
        })
        .expect_err("startFresh refusal surfaces error code");
    assert_eq!(err.code, "clear_failed");
    assert!(saw_failure);
    assert!(lock_fail.is_handed_over());
    assert_eq!(lock_fail.begin_quit(), QuitOutcome::HandedOver);
    assert_eq!(shutdown_count(&fresh_fail_shutdowns), 1);

    // 4. Pre-stop failure (missing snapshot) leaves lock unsealed, skips relaunch, and keeps keys.list working.
    let (no_snap_spec, no_snap_shutdowns) = build_mock_host("restore-nosnap", false, false, false);
    let sup_no_snap = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(no_snap_spec, contract),
        |_| {},
        || {},
    ));
    sup_no_snap.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            sup_no_snap.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));
    let lock_no_snap = MaintenanceLock::new();
    let router_no_snap = ShellRouter::new(Arc::clone(&sup_no_snap), lock_no_snap.clone(), "1.0.0");
    let mut no_snap_relaunched = false;
    let missing_err = router_no_snap
        .restore("1.0.0", "2026-11-25T00-03-00.000Z", |_| {
            no_snap_relaunched = true;
        })
        .expect_err("missing snapshot must refuse before Host stop");
    assert_eq!(missing_err.code, "missing_snapshot");
    assert!(!no_snap_relaunched);
    assert!(!lock_no_snap.is_handed_over());
    assert_eq!(shutdown_count(&no_snap_shutdowns), 0);
    assert_eq!(
        router_no_snap
            .dispatch_renderer("keys.list", Value::Null)
            .expect("keys.list keeps working after pre-stop refusal")
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    sup_no_snap.stop().expect("clean shutdown");
}

#[test]
fn restart_refuses_while_restore_paused_at_barrier_and_allows_after_precondition_error() {
    let tmp = TempDir::new("byok-restart-guard-barrier");
    let contract = BridgeContract::load().expect("contract loads");

    let count_lines = |path: &Path| -> usize {
        fs::read_to_string(path)
            .map(|text| text.lines().filter(|line| !line.is_empty()).count())
            .unwrap_or(0)
    };

    // 1. Barrier test: pause restore after Host stopped and before stores finish moving;
    //    restart refuses with maintenance_busy and starts no Host. After restore completes,
    //    only the normal handover runs and restart remains refused.
    let store_path = tmp.path().join("store.json");
    let aside_path = tmp.path().join("store.json.aside");
    fs::write(&store_path, "pre-restore-store").expect("seed store");
    let spawns_log = tmp.path().join("restore-spawns.log");
    let shutdowns_log = tmp.path().join("restore-shutdowns.log");
    let restore_entered = tmp.path().join("restore-entered");
    let restore_release = tmp.path().join("restore-release");

    let restore_script = format!(
        r#"
import fs from 'node:fs';
import readline from 'node:readline';

const [subcmd, arg1] = process.argv.slice(2);
if (subcmd === {snapshot_status_cmd}) {{
  process.stdout.write(JSON.stringify({{
    ok: true,
    snapshot: {{ version: arg1, target: '/tmp/snapshot-v1' }},
  }}) + '\n');
  process.exit(0);
}}
if (subcmd === {restore_cmd}) {{
  const enteredTmp = {restore_entered} + '.tmp';
  fs.writeFileSync(enteredTmp, 'entered');
  fs.renameSync(enteredTmp, {restore_entered});
  const timer = setInterval(() => {{
    if (fs.existsSync({restore_release})) {{
      clearInterval(timer);
      fs.renameSync({store_path}, {aside_path});
      const restoredTmp = {store_path} + '.tmp';
      fs.writeFileSync(restoredTmp, 'restored-store');
      fs.renameSync(restoredTmp, {store_path});
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
      process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
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
        restore_entered =
            serde_json::to_string(&restore_entered.to_string_lossy().into_owned()).unwrap(),
        restore_release =
            serde_json::to_string(&restore_release.to_string_lossy().into_owned()).unwrap(),
        store_path = serde_json::to_string(&store_path.to_string_lossy().into_owned()).unwrap(),
        aside_path = serde_json::to_string(&aside_path.to_string_lossy().into_owned()).unwrap(),
        spawns_log = serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
        shutdowns_log =
            serde_json::to_string(&shutdowns_log.to_string_lossy().into_owned()).unwrap(),
    );
    let restore_spec = write_node_script(tmp.path(), "barrier-restore.mjs", &restore_script);
    let supervisor = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(restore_spec, contract.clone()),
        |_| {},
        || {},
    ));
    supervisor.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            supervisor.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));
    assert_eq!(count_lines(&spawns_log), 1);

    let lock = MaintenanceLock::new();
    let router = Arc::new(ShellRouter::new(
        Arc::clone(&supervisor),
        lock.clone(),
        "1.0.0",
    ));
    let relaunch_calls = Arc::new(AtomicUsize::new(0));
    let relaunch_calls_bg = Arc::clone(&relaunch_calls);
    let router_bg = Arc::clone(&router);
    let restore_handle = thread::spawn(move || {
        router_bg.restore("1.0.0", "2026-11-25T00-00-00.000Z", |failure| {
            assert!(failure.is_none());
            relaunch_calls_bg.fetch_add(1, Ordering::SeqCst);
        })
    });

    // Synchronous barrier: restore has stopped the Host and paused before moving stores.
    assert!(
        wait_until(Duration::from_secs(5), || restore_entered.exists()),
        "restore child must reach barrier after Host stop"
    );
    assert_eq!(
        count_lines(&shutdowns_log),
        1,
        "initial Host must already be stopped before restore runs"
    );
    assert_eq!(
        fs::read_to_string(&store_path).unwrap(),
        "pre-restore-store",
        "stores must not have finished moving while paused at barrier"
    );
    assert!(!aside_path.exists());

    let busy_err = supervisor
        .restart(&lock)
        .expect_err("restart must refuse while restore holds MaintenanceLock");
    assert_eq!(busy_err, MaintenanceBusyError);
    assert_eq!(busy_err.code(), "maintenance_busy");
    assert_eq!(
        count_lines(&spawns_log),
        1,
        "refused restart must start no new Host during restore"
    );

    // Release barrier so restore finishes moving stores and confirms handover.
    fs::write(&restore_release, "go").expect("release restore barrier");
    let restored = restore_handle
        .join()
        .expect("restore thread joins")
        .expect("restore succeeds");
    assert_eq!(restored.aside_path, aside_path.to_string_lossy());
    assert_eq!(fs::read_to_string(&store_path).unwrap(), "restored-store");
    assert_eq!(fs::read_to_string(&aside_path).unwrap(), "pre-restore-store");
    assert_eq!(relaunch_calls.load(Ordering::SeqCst), 1);
    assert!(lock.is_handed_over());

    // After successful recovery, only the normal handover runs; restart remains refused.
    let post_handover_err = supervisor
        .restart(&lock)
        .expect_err("restart must stay refused after confirmed handover");
    assert_eq!(post_handover_err.code(), "maintenance_busy");
    assert_eq!(
        count_lines(&spawns_log),
        1,
        "no new Host may start after successful recovery handover"
    );
    assert_eq!(lock.begin_quit(), QuitOutcome::HandedOver);

    // 2. Pending handover and quit also refuse restart and start no Host; recoverable
    //    precondition errors release MaintenanceLock so restart is allowed again.
    let precond_spawns = tmp.path().join("precond-spawns.log");
    let precond_shutdowns = tmp.path().join("precond-shutdowns.log");
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
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
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
        snapshot_status_cmd =
            serde_json::to_string(&contract.host_commands.snapshot_status).unwrap(),
        spawns_log =
            serde_json::to_string(&precond_spawns.to_string_lossy().into_owned()).unwrap(),
        shutdowns_log =
            serde_json::to_string(&precond_shutdowns.to_string_lossy().into_owned()).unwrap(),
    );
    let precond_spec = write_node_script(tmp.path(), "precond-restart.mjs", &precond_script);
    let precond_sup = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(precond_spec, contract.clone()),
        |_| {},
        || {},
    ));
    precond_sup.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            precond_sup.last_state(),
            Some(SupervisedHostState::Stopped {
                store_refused: false,
                ..
            })
        )
    }));
    let first_pid = match precond_sup.last_state() {
        Some(SupervisedHostState::Stopped { pid, .. }) => pid,
        other => panic!("expected stopped host state, got {other:?}"),
    };
    assert_eq!(count_lines(&precond_spawns), 1);

    let precond_lock = MaintenanceLock::new();
    let precond_router = ShellRouter::new(Arc::clone(&precond_sup), precond_lock.clone(), "1.0.0");

    // 2a. Missing snapshot precondition error releases lock; restart is allowed again.
    let missing_err = precond_router
        .restore("1.0.0", "2026-11-25T00-01-00.000Z", |_| {
            panic!("precondition error must not relaunch");
        })
        .expect_err("missing snapshot must refuse");
    assert_eq!(missing_err.code, "missing_snapshot");
    assert!(!precond_lock.is_busy());
    assert!(!precond_lock.is_handed_over());

    precond_sup
        .restart(&precond_lock)
        .expect("restart must succeed after recoverable missing_snapshot precondition error");
    assert!(
        wait_until(Duration::from_secs(5), || {
            matches!(
                precond_sup.last_state(),
                Some(SupervisedHostState::Stopped {
                    pid,
                    store_refused: false,
                    ..
                }) if pid != first_pid
            )
        }),
        "allowed restart must spawn and connect a new Host"
    );
    let second_pid = match precond_sup.last_state() {
        Some(SupervisedHostState::Stopped { pid, .. }) => pid,
        other => panic!("expected restarted host state, got {other:?}"),
    };
    assert_eq!(count_lines(&precond_spawns), 2);
    assert_eq!(count_lines(&precond_shutdowns), 1);

    // 2b. startFresh precondition error (storeRefused=false) also releases lock for restart.
    let fresh_precond_err = precond_router
        .start_fresh("2026-11-25T00-02-00.000Z", |_| {
            panic!("precondition error must not relaunch");
        })
        .expect_err("startFresh without storeRefused must refuse");
    assert_eq!(fresh_precond_err.code, "precondition_failed");
    assert!(!precond_lock.is_busy());

    precond_sup
        .restart(&precond_lock)
        .expect("restart must succeed after recoverable startFresh precondition error");
    assert!(
        wait_until(Duration::from_secs(5), || {
            matches!(
                precond_sup.last_state(),
                Some(SupervisedHostState::Stopped {
                    pid,
                    store_refused: false,
                    ..
                }) if pid != second_pid
            )
        }),
        "allowed restart after startFresh precondition error must spawn and connect a new Host"
    );
    assert_eq!(count_lines(&precond_spawns), 3);
    assert_eq!(count_lines(&precond_shutdowns), 2);

    // 2c. Pending handover and quit refuse restart and spawn no new Host.
    {
        let pending_guard = precond_lock.try_begin().expect("acquire pending guard");
        pending_guard.begin_pending();
        let pending_err = precond_sup
            .restart(&precond_lock)
            .expect_err("restart must refuse during pending handover");
        assert_eq!(pending_err.code(), "maintenance_busy");
        assert_eq!(count_lines(&precond_spawns), 3);
        pending_guard.cancel_pending();
    }

    assert_eq!(precond_lock.begin_quit(), QuitOutcome::Quit);
    let quit_err = precond_sup
        .restart(&precond_lock)
        .expect_err("restart must refuse once quit holds MaintenanceLock");
    assert_eq!(quit_err.code(), "maintenance_busy");
    assert_eq!(count_lines(&precond_spawns), 3);

    precond_sup.stop().expect("clean shutdown");

    // 3. Concurrent begin_quit arriving while restart is shutting down the old Host:
    //    begin_quit waits until restart drops MaintenanceGuard, and restart refuses
    //    without spawning a new Host.
    let slow_spawns = tmp.path().join("slow-quit-spawns.log");
    let slow_shutdown_entered = tmp.path().join("slow-shutdown-entered");
    let slow_shutdown_release = tmp.path().join("slow-shutdown-release");
    let slow_script = format!(
        r#"
import fs from 'node:fs';
import readline from 'node:readline';

fs.appendFileSync({spawns_log}, String(process.pid) + '\n');
const rl = readline.createInterface({{ input: process.stdin }});
rl.on('close', () => process.exit(0));
rl.on('line', line => {{
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 5 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{
      event: 'state',
      state: {{ state: 'running', pid: process.pid, activeWork: 0 }},
    }}) + '\n');
  }} else if (msg.method === 'shutdown') {{
    const tmpMarker = {entered} + '.tmp';
    fs.writeFileSync(tmpMarker, 'entered');
    fs.renameSync(tmpMarker, {entered});
    const timer = setInterval(() => {{
      if (fs.existsSync({release})) {{
        clearInterval(timer);
        process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
        process.exit(0);
      }}
    }}, 10);
  }}
}});
"#,
        spawns_log = serde_json::to_string(&slow_spawns.to_string_lossy().into_owned()).unwrap(),
        entered =
            serde_json::to_string(&slow_shutdown_entered.to_string_lossy().into_owned()).unwrap(),
        release =
            serde_json::to_string(&slow_shutdown_release.to_string_lossy().into_owned()).unwrap(),
    );
    let slow_spec = write_node_script(tmp.path(), "slow-quit-restart.mjs", &slow_script);
    let slow_sup = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(slow_spec, contract),
        |_| {},
        || {},
    ));
    slow_sup.start();
    assert!(wait_until(Duration::from_secs(5), || {
        matches!(
            slow_sup.last_state(),
            Some(SupervisedHostState::Running { .. })
        )
    }));
    assert_eq!(count_lines(&slow_spawns), 1);

    let slow_lock = MaintenanceLock::new();
    let restart_sup = Arc::clone(&slow_sup);
    let restart_lock = slow_lock.clone();
    let restart_handle = thread::spawn(move || restart_sup.restart(&restart_lock));
    assert!(
        wait_until(Duration::from_secs(5), || slow_shutdown_entered.exists()),
        "restart must reach old-Host shutdown barrier"
    );

    let (quit_marked_tx, quit_marked_rx) = mpsc::channel();
    slow_lock.on_quit_requested(move || {
        let _ = quit_marked_tx.send(());
    });
    let quit_lock = slow_lock.clone();
    let quit_handle = thread::spawn(move || quit_lock.begin_quit());
    quit_marked_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("begin_quit marks quitting while restart holds MaintenanceLock");
    assert!(
        !quit_handle.is_finished(),
        "begin_quit must wait while restart holds MaintenanceLock"
    );

    fs::write(&slow_shutdown_release, "go").expect("release old-Host shutdown");
    let mid_quit_err = restart_handle
        .join()
        .expect("restart thread joins")
        .expect_err("restart must refuse instead of unpausing when quit arrived mid-restart");
    assert_eq!(mid_quit_err.code(), "maintenance_busy");
    assert_eq!(
        quit_handle.join().expect("quit thread joins"),
        QuitOutcome::Quit
    );
    assert_eq!(
        count_lines(&slow_spawns),
        1,
        "no new Host may start when quit arrives during restart"
    );
    slow_sup.stop().expect("clean shutdown");
}
