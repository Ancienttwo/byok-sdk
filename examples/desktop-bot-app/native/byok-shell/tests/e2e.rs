use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use byok_shell::{
    BridgeContract, BridgeErrorCode, FOREIGN_RUNTIME_VARIABLES, HostCommandSpec,
    HostSupervisor, HostSupervisorConfig, KeepAwake, LinuxInhibitBackend, LoginItemBackend,
    LoginItemView, MaintenanceLock, PowerError, QuitOutcome, SecretBytes, ShellRouteError,
    ShellRouter, SupervisedHostState, UnsupportedLoginItemBackend, filter_env_pairs,
    list_from_custody, run_restore, run_snapshot, run_snapshot_status, select_linux_backend,
    shell_restore, shell_start_fresh, spawn_host_child, submit_to_custody,
};
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

fn real_host_bundle() -> PathBuf {
    let bundle = app_root().join("dist/host/host.cjs");
    assert!(
        bundle.exists(),
        "real Host bundle missing at {} — run `bun run --filter @byok-sdk/example-desktop-bot-app build:host`",
        bundle.display()
    );
    bundle
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
        .with_env("LOCALAPPDATA", local_app_data.to_string_lossy().into_owned())
        .with_env("APPDATA", roaming_app_data.to_string_lossy().into_owned())
        .with_env("XDG_DATA_HOME", xdg_data_home.to_string_lossy().into_owned())
}

fn real_host_spec_with_temp_home(home: &Path) -> HostCommandSpec {
    with_temp_home_env(HostCommandSpec::dev_node_host(real_host_bundle()), home)
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
    let tmp = TempDir::new("byok-s1-e2e");
    let home = tmp.path();
    let contract = BridgeContract::load().expect("contract loads");
    let spec = real_host_spec_with_temp_home(home);

    let store_dir = home.join(".byok/byok-desktop-bots");
    let host_dir = host_storage_root_for(home).join("host");
    fs::create_dir_all(&store_dir).expect("create store dir");
    fs::create_dir_all(&host_dir).expect("create host dir");
    fs::write(store_dir.join("device.json"), b"v1-store-data").expect("write device.json");
    fs::write(host_dir.join("settings.json"), b"v1-host-settings").expect("write settings.json");

    assert_eq!(
        run_snapshot_status(&spec, &contract.host_commands, "1.0.0", Some(Duration::from_secs(15)))
            .expect("status query"),
        None
    );

    let snap_target =
        run_snapshot(&spec, &contract.host_commands, "1.0.0", Some(Duration::from_secs(15)))
            .expect("snapshot succeeds");
    let canon_home = fs::canonicalize(home).expect("canonical home");
    let canon_target = fs::canonicalize(&snap_target).expect("canonical snapshot target");
    assert!(
        canon_target.starts_with(&canon_home),
        "snapshot target {} must reside inside temp home {}",
        canon_target.display(),
        canon_home.display()
    );

    let status =
        run_snapshot_status(&spec, &contract.host_commands, "1.0.0", Some(Duration::from_secs(15)))
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
        Some(Duration::from_secs(15)),
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
    let tmp = TempDir::new("byok-real-proto");
    let spec = real_host_spec_with_temp_home(tmp.path());

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
        stdin.write_all(b"not-valid-json\n").expect("write malformed");
        stdin.flush().expect("flush");
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait real host");
    assert!(!output.status.success(), "real Host must exit non-zero on malformed frame");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(stdout.trim()).expect("id:0 JSON error reply");
    assert_eq!(parsed["id"].as_u64(), Some(0));
    assert_eq!(parsed["error"]["code"].as_str(), Some("invalid_message"));
}

#[test]
fn real_host_custody_invalid_json_never_leaks_secret_in_receipt() {
    let tmp = TempDir::new("byok-custody-real");
    let contract = BridgeContract::load().expect("contract loads");
    let spec = real_host_spec_with_temp_home(tmp.path());
    let sentinel = "sk-super-secret-do-not-echo-998877";
    let malformed = SecretBytes::from_string(format!("{{\"op\":\"configure\",\"secret\":\"{sentinel}\""));
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
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 2 }} }}) + '\n');
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
    let h_slow = thread::spawn(move || sup_a.call_renderer_forwarded("k8.view", json!({ "botId": "slow" })));
    thread::sleep(Duration::from_millis(15));
    let h_fast = thread::spawn(move || sup_b.call_renderer_forwarded("k8.view", json!({ "botId": "fast" })));

    assert_eq!(h_fast.join().unwrap().unwrap(), json!({ "ok": "fast" }));
    assert_eq!(h_slow.join().unwrap().unwrap(), json!({ "ok": "slow" }));

    // Renderer cannot call shellToHost (`keys.profilesChanged`), while shell_to_host can.
    let unauthorized = supervisor
        .call_renderer_forwarded("keys.profilesChanged", Value::Null)
        .expect_err("renderer must not call shellToHost");
    assert_eq!(unauthorized.code, BridgeErrorCode::UnauthorizedMethod);

    supervisor.stop().expect("clean shutdown exits 0");
    // Repeated stop after clean exit remains idempotent Ok.
    supervisor.stop().expect("repeat stop after clean exit is Ok");
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
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 2 } }) + '\n');
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
            Some(SupervisedHostState::Stopped { store_refused: true, .. })
        )
    }));

    // First stop fails because Host ignores shutdown within grace and had to be terminated.
    supervisor.stop().expect_err("stuck shutdown must fail");
    // Critical P2-2 fix: a second stop attempt MUST NOT silently treat prior forced termination as Ok!
    supervisor
        .stop()
        .expect_err("retry stop after unclean termination must still refuse");

    let maintenance = MaintenanceLock::new();
    let start_fresh_res = shell_start_fresh(&supervisor, &maintenance, "2026-01-01", None, |_| {});
    assert_eq!(
        start_fresh_res.expect_err("must not run S1 start-fresh after failed stop").code,
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

    // 1. Submit times out cleanly at 100ms WITHOUT killing child; child completes at 350ms without EPIPE.
    let sentinel = "sk-custody-e2e-keep-lock";
    let err = submit_to_custody(
        &spec,
        &contract.host_commands.custody,
        SecretBytes::from_string(format!("{{\"op\":\"replace_secret\",\"profileRef\":\"w\",\"secret\":\"{sentinel}\"}}")),
        Duration::from_millis(100),
        None,
        None,
    )
    .expect_err("submit must time out at 100ms");
    assert_eq!(err.code, "custody_timeout");
    assert!(!err.message.contains(sentinel));

    assert!(
        wait_until(Duration::from_secs(3), || marker.exists()),
        "custody child must finish writing after timeout"
    );
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "committed-cleanly-without-epipe"
    );

    // 2. List times out at 100ms AND kills child so delayed work never finishes.
    let list_err = list_from_custody(
        &spec,
        &contract.host_commands.custody,
        Duration::from_millis(100),
        None,
    )
    .expect_err("list must time out");
    assert_eq!(list_err.code, "custody_timeout");
    thread::sleep(Duration::from_millis(1700));
    assert!(!list_marker.exists(), "list timeout must kill child");

    // 3. MaintenanceLock blocks concurrent submit and begin_quit drains in-flight maintenance.
    let lock = MaintenanceLock::new();
    let guard = lock.try_begin().expect("acquire maintenance lock");
    let busy_err = submit_to_custody(
        &spec,
        &contract.host_commands.custody,
        SecretBytes::from_string(r#"{"op":"replace_secret","profileRef":"w","secret":"s"}"#.to_owned()),
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
}

#[test]
fn router_routes_main_methods_and_rejects_shell_only_methods_from_renderer() {
    struct FakeLogin;
    impl LoginItemBackend for FakeLogin {
        fn get(&self) -> Result<LoginItemView, ShellRouteError> {
            Ok(LoginItemView {
                supported: true,
                enabled: false,
            })
        }
        fn set(&self, enabled: bool) -> Result<LoginItemView, ShellRouteError> {
            Ok(LoginItemView {
                supported: true,
                enabled,
            })
        }
    }

    let tmp = TempDir::new("byok-router");
    let script = r#"
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 2 } }) + '\n');
    return;
  }
  if (msg.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: null }) + '\n');
    process.exit(0);
  }
  if (msg.method === 'keys.profilesChanged') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: null }) + '\n');
    return;
  }
  if (msg.method === 'k8.view') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { botId: msg.params?.botId ?? null } }) + '\n');
  }
});
"#;
    let spec = write_node_script(tmp.path(), "router-host.mjs", script);
    let contract = BridgeContract::load().expect("contract loads");
    let supervisor = Arc::new(HostSupervisor::new(
        HostSupervisorConfig::new(spec, contract),
        |_| {},
        || {},
    ));
    supervisor.start();

    assert!(wait_until(Duration::from_secs(3), || {
        supervisor.call_renderer_forwarded("k8.view", json!({ "botId": "b1" })).is_ok()
    }));

    let router = ShellRouter::new(
        Arc::clone(&supervisor),
        MaintenanceLock::new(),
        Box::new(FakeLogin),
        "0.0.1",
    );
    assert_eq!(
        router.dispatch_renderer("settings.loginItem", Value::Null).unwrap(),
        json!({ "supported": true, "enabled": false })
    );
    assert_eq!(
        router.dispatch_renderer("settings.setLoginItem", json!({ "enabled": true })).unwrap(),
        json!({ "supported": true, "enabled": true })
    );
    let blocked = router
        .dispatch_renderer("keys.profilesChanged", Value::Null)
        .expect_err("renderer must never invoke shellToHostMethods");
    assert_eq!(blocked.code, "unknown_method");
    assert!(UnsupportedLoginItemBackend.set(true).is_err());

    supervisor.stop().expect("clean shutdown");
}

#[test]
fn router_shell_state_and_shell_restore_run_host_stopped_order_and_confirm_handover() {
    let tmp = TempDir::new("byok-restore-e2e");
    let home = tmp.path();
    let spec = real_host_spec_with_temp_home(home);
    let contract = BridgeContract::load().expect("contract loads");

    // Populate temp home stores and capture real snapshot v1.0.0 before starting a stopped mock Host.
    let store_dir = home.join(".byok/byok-desktop-bots");
    let host_dir = host_storage_root_for(home).join("host");
    fs::create_dir_all(&store_dir).unwrap();
    fs::create_dir_all(&host_dir).unwrap();
    fs::write(store_dir.join("device.json"), b"snapshot-v1").unwrap();
    fs::write(host_dir.join("settings.json"), b"host-v1").unwrap();
    run_snapshot(&spec, &contract.host_commands, "1.0.0", Some(Duration::from_secs(15)))
        .expect("snapshot v1.0.0");
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
    process.stdout.write(JSON.stringify({{ id: msg.id, result: {{ bridgeVersion: 2 }} }}) + '\n');
    process.stdout.write(JSON.stringify({{ event: 'state', state: {{ state: 'stopped', pid: process.pid, reason: 'halted', storeRefused: false }} }}) + '\n');
    return;
  }}
  if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
        real_host = serde_json::to_string(&real_host_bundle().to_string_lossy().into_owned()).unwrap()
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
            Some(SupervisedHostState::Stopped { store_refused: false, .. })
        )
    }));

    let maintenance = MaintenanceLock::new();
    let router = ShellRouter::new(
        Arc::clone(&supervisor),
        maintenance.clone(),
        Box::new(UnsupportedLoginItemBackend),
        "1.0.0",
    )
    .with_deadlines(Duration::from_secs(10), Some(Duration::from_secs(15)));

    let view = router.state("1.0.0");
    assert_eq!(view.restore_error, None);
    assert_eq!(view.restore.map(|r| r.version), Some("1.0.0".to_owned()));
    let routed_state = router
        .dispatch_renderer("shell.state", Value::Null)
        .expect("dispatch_renderer shell.state uses configured app_version");
    assert_eq!(routed_state["restore"]["version"], json!("1.0.0"));

    let mut relaunched_with_err = None;
    let ok = shell_restore(
        &supervisor,
        &maintenance,
        "1.0.0",
        "2026-11-24T12-30-00.000Z",
        Some(Duration::from_secs(15)),
        |err| relaunched_with_err = Some(err.is_some()),
    )
    .expect("shell_restore succeeds");

    assert_eq!(relaunched_with_err, Some(false));
    assert!(maintenance.is_handed_over());
    assert!(fs::canonicalize(&ok.aside_path).unwrap().starts_with(fs::canonicalize(home).unwrap()));
    assert_eq!(fs::read_to_string(store_dir.join("device.json")).unwrap(), "snapshot-v1");
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
        HostCommandSpec::dev_node_host(real_host_bundle())
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
    process.stdout.write(JSON.stringify({ id: msg.id, result: { bridgeVersion: 2 } }) + '\n');
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
            if let SupervisedHostState::Running { pid, .. } | SupervisedHostState::Stopped { pid, .. } =
                state
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
    assert!(is_pid_alive(host_pid), "Host must be running before shell kill");

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
    let spec = HostCommandSpec::dev_node_host(real_host_bundle());
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
    supervisor.stop().expect("clean shutdown against live Host must succeed");

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
