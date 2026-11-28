//! Host child process supervisor, exponential backoff, clean stop authority, and 50 ms hint coalescing.

use std::fmt;
use std::process::Child;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::bridge::{
    BridgeClient, BridgeError, BridgeErrorCode, HostState, StopError, SupervisedHostState,
};
use crate::command::{HostCommandSpec, spawn_host_child};
use crate::contract::BridgeContract;
use crate::maintenance::{HandoverState, MaintenanceBusyError, MaintenanceLock};
use crate::power::{
    DEFAULT_KEEP_AWAKE_REASON, DEFAULT_KEEP_AWAKE_WHO, KeepAwakeBackend, KeepAwakeGuard,
    PowerError, SystemKeepAwakeBackend,
};

type HintCallback = Box<dyn Fn() + Send + Sync>;
type StateCallback = Arc<dyn Fn(SupervisedHostState) + Send + Sync>;
type PowerErrorCallback = Arc<dyn Fn(PowerError) + Send + Sync>;
#[cfg(test)]
type SpawnHook = Arc<dyn Fn(&HostCommandSpec) -> std::io::Result<Child> + Send + Sync>;

/// Coalesces bursts of Host state pushes into a single trailing notification (`50ms` default).
pub struct StateHintCoalescer {
    window: Duration,
    inner: Arc<CoalescerInner>,
    worker: Option<JoinHandle<()>>,
}

struct CoalescerInner {
    state: Mutex<CoalescerState>,
    cv: Condvar,
}

struct CoalescerState {
    deadline: Option<Instant>,
    closed: bool,
}

impl StateHintCoalescer {
    /// Creates a coalescer firing `send` at most once per `window` burst on a dedicated OS thread.
    pub fn new<F>(window: Duration, send: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let inner = Arc::new(CoalescerInner {
            state: Mutex::new(CoalescerState {
                deadline: None,
                closed: false,
            }),
            cv: Condvar::new(),
        });
        let worker_inner = Arc::clone(&inner);
        let send: HintCallback = Box::new(send);
        let worker = thread::Builder::new()
            .name("byok-state-hint".to_owned())
            .spawn(move || {
                let mut guard = worker_inner.state.lock().expect("hint lock poisoned");
                loop {
                    if guard.closed {
                        return;
                    }
                    match guard.deadline {
                        None => {
                            guard = worker_inner.cv.wait(guard).expect("hint lock poisoned");
                        }
                        Some(at) => {
                            let now = Instant::now();
                            if now >= at {
                                guard.deadline = None;
                                drop(guard);
                                send();
                                guard = worker_inner.state.lock().expect("hint lock poisoned");
                            } else {
                                let (next, _) = worker_inner
                                    .cv
                                    .wait_timeout(guard, at.saturating_duration_since(now))
                                    .expect("hint lock poisoned");
                                guard = next;
                            }
                        }
                    }
                }
            })
            .expect("spawn state-hint thread");

        Self {
            window,
            inner,
            worker: Some(worker),
        }
    }

    /// Schedules a trailing hint if none is currently armed for this burst (`window` ms).
    pub fn trigger(&self) {
        let mut guard = self.inner.state.lock().expect("hint lock poisoned");
        if guard.closed {
            return;
        }
        if guard.deadline.is_none() {
            guard.deadline = Some(Instant::now() + self.window);
            self.inner.cv.notify_one();
        }
    }
}

impl Drop for StateHintCoalescer {
    fn drop(&mut self) {
        {
            let mut guard = self.inner.state.lock().expect("hint lock poisoned");
            guard.closed = true;
            guard.deadline = None;
            self.inner.cv.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Configuration for [`HostSupervisor`].
#[derive(Clone)]
pub struct HostSupervisorConfig {
    pub command: HostCommandSpec,
    pub contract: BridgeContract,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub backoff_reset: Duration,
    pub shutdown_grace: Duration,
    pub hint_window: Duration,
    power_backend: Arc<dyn KeepAwakeBackend>,
    on_power_error: PowerErrorCallback,
    keep_awake_who: String,
    keep_awake_reason: String,
    maintenance: Option<MaintenanceLock>,
}

impl fmt::Debug for HostSupervisorConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostSupervisorConfig")
            .field("command", &self.command)
            .field("contract", &self.contract)
            .field("initial_backoff", &self.initial_backoff)
            .field("max_backoff", &self.max_backoff)
            .field("backoff_reset", &self.backoff_reset)
            .field("shutdown_grace", &self.shutdown_grace)
            .field("hint_window", &self.hint_window)
            .field("power_backend", &"<power_backend>")
            .field("on_power_error", &"<on_power_error>")
            .field("keep_awake_who", &self.keep_awake_who)
            .field("keep_awake_reason", &self.keep_awake_reason)
            .field("maintenance_bound", &self.maintenance.is_some())
            .finish()
    }
}

impl HostSupervisorConfig {
    /// Standard production timings (`1s..30s`, `60s` reset, `10s` shutdown grace, `50ms` hint window).
    pub fn new(command: HostCommandSpec, contract: BridgeContract) -> Self {
        Self {
            command,
            contract,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            backoff_reset: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(10),
            hint_window: Duration::from_millis(50),
            power_backend: Arc::new(SystemKeepAwakeBackend),
            on_power_error: Arc::new(|_| {}),
            keep_awake_who: DEFAULT_KEEP_AWAKE_WHO.to_owned(),
            keep_awake_reason: DEFAULT_KEEP_AWAKE_REASON.to_owned(),
            maintenance: None,
        }
    }

    /// Binds a [`MaintenanceLock`] so every Host launch decision synchronizes with recorded quit,
    /// maintenance, and handover state before spawning a replacement child.
    pub fn with_maintenance_lock(mut self, maintenance: MaintenanceLock) -> Self {
        self.maintenance = Some(maintenance);
        self
    }

    /// Overrides the sleep-inhibition backend (defaults to [`SystemKeepAwakeBackend`]).
    pub fn with_power_backend(mut self, backend: Arc<dyn KeepAwakeBackend>) -> Self {
        self.power_backend = backend;
        self
    }

    /// Registers an error observer invoked off-lock when acquiring OS sleep inhibition fails.
    pub fn with_on_power_error<F>(mut self, on_error: F) -> Self
    where
        F: Fn(PowerError) + Send + Sync + 'static,
    {
        self.on_power_error = Arc::new(on_error);
        self
    }

    /// Overrides the `who` and `reason` strings passed to the sleep-inhibition backend.
    pub fn with_keep_awake_identity(
        mut self,
        who: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        self.keep_awake_who = who.into();
        self.keep_awake_reason = reason.into();
        self
    }
}

struct PowerControllerState {
    closed_through: u64,
    busy: bool,
    transition_seq: u64,
    guard: Option<Box<dyn KeepAwakeGuard>>,
    last_error: Option<PowerError>,
}

struct KeepAwakeController {
    backend: Arc<dyn KeepAwakeBackend>,
    on_error: PowerErrorCallback,
    who: String,
    reason: String,
    state: Mutex<PowerControllerState>,
}

impl KeepAwakeController {
    fn new(
        backend: Arc<dyn KeepAwakeBackend>,
        on_error: PowerErrorCallback,
        who: String,
        reason: String,
    ) -> Self {
        Self {
            backend,
            on_error,
            who,
            reason,
            state: Mutex::new(PowerControllerState {
                closed_through: 0,
                busy: false,
                transition_seq: 0,
                guard: None,
                last_error: None,
            }),
        }
    }

    fn sync_for_run(&self, run_id: u64, want_busy: bool) {
        let seq = {
            let mut st = self.state.lock().expect("power controller lock poisoned");
            if run_id <= st.closed_through {
                return;
            }
            if want_busy {
                if st.busy {
                    return;
                }
                st.busy = true;
                st.transition_seq = st.transition_seq.saturating_add(1);
                st.transition_seq
            } else {
                if !st.busy && st.guard.is_none() {
                    return;
                }
                st.busy = false;
                st.transition_seq = st.transition_seq.saturating_add(1);
                let old = st.guard.take();
                drop(st);
                drop(old);
                return;
            }
        };

        let result = self.backend.acquire(&self.who, &self.reason);
        let mut drop_stale: Option<Box<dyn KeepAwakeGuard>> = None;
        let mut notify_err: Option<PowerError> = None;
        {
            let mut st = self.state.lock().expect("power controller lock poisoned");
            let still_current = run_id > st.closed_through && st.busy && st.transition_seq == seq;
            match result {
                Ok(guard) => {
                    if still_current {
                        drop_stale = st.guard.replace(guard);
                        st.last_error = None;
                    } else {
                        drop_stale = Some(guard);
                    }
                }
                Err(err) => {
                    if still_current {
                        st.last_error = Some(err.clone());
                        notify_err = Some(err);
                    }
                }
            }
        }
        drop(drop_stale);
        if let Some(err) = notify_err {
            (self.on_error)(err);
        }
    }

    fn release_through(&self, epoch: u64) {
        let old = {
            let mut st = self.state.lock().expect("power controller lock poisoned");
            st.closed_through = st.closed_through.max(epoch);
            st.busy = false;
            st.transition_seq = st.transition_seq.saturating_add(1);
            st.guard.take()
        };
        drop(old);
    }

    fn last_error(&self) -> Option<PowerError> {
        self.state
            .lock()
            .expect("power controller lock poisoned")
            .last_error
            .clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StopAuthority {
    NeverStarted,
    Running,
    CleanExit,
    Unclean(String),
}

struct SupervisorState {
    run_seq: u64,
    active_run: bool,
    paused: bool,
    stopping: bool,
    destroyed: bool,
    connecting: bool,
    client: Option<Arc<BridgeClient>>,
    last_state: Option<SupervisedHostState>,
    stop_authority: StopAuthority,
    attempt: u32,
    maintenance: Option<MaintenanceLock>,
}

struct SupervisorInner {
    config: HostSupervisorConfig,
    state: Mutex<SupervisorState>,
    cv: Condvar,
    on_state: StateCallback,
    coalescer: StateHintCoalescer,
    power: KeepAwakeController,
    #[cfg(test)]
    before_finish_restart: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    before_launch_reserve: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    in_launch_spawn: Mutex<Option<SpawnHook>>,
    #[cfg(test)]
    before_connect_hello: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl SupervisorInner {
    fn publish_host_state(&self, run_id: u64, host_state: HostState) {
        let next: SupervisedHostState = host_state.into();
        let run_active = {
            let guard = self.state.lock().expect("supervisor lock poisoned");
            guard.run_seq == run_id && guard.active_run && !guard.stopping && !guard.destroyed
        };
        if !run_active {
            return;
        }
        let want_busy = matches!(
            next,
            SupervisedHostState::Running { active_work, .. } if active_work > 0
        );
        self.power.sync_for_run(run_id, want_busy);
        {
            let mut guard = self.state.lock().expect("supervisor lock poisoned");
            if guard.run_seq != run_id || !guard.active_run || guard.stopping || guard.destroyed {
                return;
            }
            guard.last_state = Some(next.clone());
        }
        (self.on_state)(next);
        self.coalescer.trigger();
    }

    fn publish_state(&self, next: SupervisedHostState) {
        {
            let mut guard = self.state.lock().expect("supervisor lock poisoned");
            guard.last_state = Some(next.clone());
        }
        (self.on_state)(next);
        self.coalescer.trigger();
    }
}

/// UI-agnostic supervisor managing the Node/SEA Host child over NDJSON v2.
pub struct HostSupervisor {
    inner: Arc<SupervisorInner>,
    worker: Option<JoinHandle<()>>,
}

impl HostSupervisor {
    /// Creates a supervisor; call [`HostSupervisor::start`] to launch the Host child.
    pub fn new<S, H>(config: HostSupervisorConfig, on_state: S, on_hint: H) -> Self
    where
        S: Fn(SupervisedHostState) + Send + Sync + 'static,
        H: Fn() + Send + Sync + 'static,
    {
        let hint_window = config.hint_window;
        let power = KeepAwakeController::new(
            Arc::clone(&config.power_backend),
            Arc::clone(&config.on_power_error),
            config.keep_awake_who.clone(),
            config.keep_awake_reason.clone(),
        );
        let maintenance = config.maintenance.clone();
        let inner = Arc::new(SupervisorInner {
            config,
            state: Mutex::new(SupervisorState {
                run_seq: 0,
                active_run: false,
                paused: true,
                stopping: false,
                destroyed: false,
                connecting: false,
                client: None,
                last_state: None,
                stop_authority: StopAuthority::NeverStarted,
                attempt: 0,
                maintenance,
            }),
            cv: Condvar::new(),
            on_state: Arc::new(on_state),
            coalescer: StateHintCoalescer::new(hint_window, on_hint),
            power,
            #[cfg(test)]
            before_finish_restart: Mutex::new(None),
            #[cfg(test)]
            before_launch_reserve: Mutex::new(None),
            #[cfg(test)]
            in_launch_spawn: Mutex::new(None),
            #[cfg(test)]
            before_connect_hello: Mutex::new(None),
        });

        let loop_inner = Arc::clone(&inner);
        let worker = thread::Builder::new()
            .name("byok-host-supervisor".to_owned())
            .spawn(move || supervisor_loop(loop_inner))
            .expect("spawn host supervisor thread");

        Self {
            inner,
            worker: Some(worker),
        }
    }

    /// Returns the embedded bridge contract governing allowlisted calls.
    pub fn contract(&self) -> &BridgeContract {
        &self.inner.config.contract
    }

    /// Returns the Host spawn specification (used by recovery/custody callers reusing the same Host executable).
    pub fn command_spec(&self) -> &HostCommandSpec {
        &self.inner.config.command
    }

    /// Starts Host supervision if not already started, respecting any bound [`MaintenanceLock`].
    pub fn start(&self) {
        let maintenance = {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            if let Some(lock) = guard.maintenance.clone() {
                lock
            } else {
                guard.stopping = false;
                guard.paused = false;
                self.inner.cv.notify_all();
                return;
            }
        };
        maintenance.with_launch_state(|gate| {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            if guard.destroyed {
                return;
            }
            if gate.quitting || gate.handover != HandoverState::None {
                guard.paused = true;
                guard.stopping = true;
                self.inner.cv.notify_all();
                return;
            }
            guard.stopping = false;
            guard.paused = false;
            self.inner.cv.notify_all();
        });
    }

    /// Restarts supervision under a single [`MaintenanceLock::try_begin`] acquisition so no Host
    /// can start while recovery, handover, custody, or app quit holds the maintenance lock.
    pub fn restart(&self, maintenance: &MaintenanceLock) -> Result<(), MaintenanceBusyError> {
        let maintenance_guard = maintenance.try_begin()?;
        let (existing_client, mut release_epoch) = {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            guard.stopping = true;
            guard.paused = true;
            self.inner.cv.notify_all();
            (guard.client.take(), guard.run_seq)
        };
        let shutdown_res = existing_client
            .map(|client| client.shutdown_and_wait(self.inner.config.shutdown_grace));
        let settle_deadline = Instant::now() + self.inner.config.shutdown_grace;
        {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            while guard.active_run && !guard.destroyed {
                let Some(remaining) = settle_deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                let (next, _) = self
                    .inner
                    .cv
                    .wait_timeout(guard, remaining)
                    .expect("supervisor lock poisoned");
                guard = next;
            }
            if let Some(res) = shutdown_res {
                guard.stop_authority = match res {
                    Ok(()) => StopAuthority::CleanExit,
                    Err(err) => StopAuthority::Unclean(err.0),
                };
            }
            release_epoch = release_epoch.max(guard.run_seq);
        }
        self.inner.power.release_through(release_epoch);
        #[cfg(test)]
        {
            let hook = self
                .inner
                .before_finish_restart
                .lock()
                .expect("test hook lock poisoned")
                .clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        // Canonical lock order (`MaintenanceLock` -> `HostSupervisor`): check `!quitting`,
        // bind the maintenance lock for worker launch-time checks, unpause supervision, and
        // release `busy` in one critical section so a recorded quit always vetoes the launch.
        maintenance_guard.finish_if_not_quitting(|| {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            guard.maintenance = Some(maintenance.clone());
            if guard.destroyed {
                return;
            }
            guard.attempt = 0;
            guard.stopping = false;
            guard.paused = false;
            self.inner.cv.notify_all();
        })
    }

    /// Returns the most recently observed Host state.
    pub fn last_state(&self) -> Option<SupervisedHostState> {
        self.inner
            .state
            .lock()
            .expect("supervisor lock poisoned")
            .last_state
            .clone()
    }

    /// Returns the most recent OS sleep-inhibition acquire failure recorded while active, if any.
    pub fn last_power_error(&self) -> Option<PowerError> {
        self.inner.power.last_error()
    }

    /// Forwards one renderer-allowlisted method (`status` or domain Host method) to the running Host.
    ///
    /// Note: caller/router checks `contract.allows_renderer_method` before choosing local vs Host forwarding.
    pub fn call_renderer_forwarded(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        if !self
            .inner
            .config
            .contract
            .allows_renderer_forwarded_host_method(method)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnauthorizedMethod,
                format!("Method `{method}` is not an allowed renderer-to-Host call"),
            ));
        }
        self.call_active_client(method, params, None)
    }

    /// Calls a shell-only Host method (e.g., `keys.profilesChanged`) permitted by `shellToHostMethods`.
    pub fn call_shell_to_host(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        if !self.inner.config.contract.allows_shell_to_host_method(method) {
            return Err(BridgeError::new(
                BridgeErrorCode::UnauthorizedMethod,
                format!("Method `{method}` is not an allowed shell-to-Host call"),
            ));
        }
        self.call_active_client(method, params, None)
    }

    /// Calls a shell-only Host method with an explicit RPC timeout (`catalog_refresh_timeout`).
    pub fn call_shell_to_host_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        if !self.inner.config.contract.allows_shell_to_host_method(method) {
            return Err(BridgeError::new(
                BridgeErrorCode::UnauthorizedMethod,
                format!("Method `{method}` is not an allowed shell-to-Host call"),
            ));
        }
        self.call_active_client(method, params, Some(timeout))
    }

    fn call_active_client(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, BridgeError> {
        let client = {
            let guard = self.inner.state.lock().expect("supervisor lock poisoned");
            guard.client.clone()
        };
        let Some(client) = client else {
            return Err(BridgeError::new(
                BridgeErrorCode::HostExited,
                "No Host is running",
            ));
        };
        client.call_raw_timeout(method, params, timeout)
    }

    /// Stops the Host cleanly (`shutdown` RPC + exit `0`). Fails closed if stop fails OR if no clean exit occurred.
    pub fn stop(&self) -> Result<(), StopError> {
        let shutdown_grace = self.inner.config.shutdown_grace;
        let deadline = Instant::now() + shutdown_grace;

        let (client, mut release_epoch) = {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            guard.stopping = true;
            guard.paused = true;
            self.inner.cv.notify_all();

            while guard.connecting {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    let msg = "Host never finished hello before shutdown grace elapsed".to_owned();
                    guard.stop_authority = StopAuthority::Unclean(msg.clone());
                    let release_epoch = guard.run_seq;
                    drop(guard);
                    self.inner.power.release_through(release_epoch);
                    return Err(StopError(msg));
                };
                let (next, _) = self
                    .inner
                    .cv
                    .wait_timeout(guard, remaining)
                    .expect("supervisor lock poisoned");
                guard = next;
            }

            if let Some(client) = guard.client.take() {
                (client, guard.run_seq)
            } else {
                // Wait briefly if supervisor loop is settling exit authority.
                while guard.active_run {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    let (next, _) = self
                        .inner
                        .cv
                        .wait_timeout(guard, remaining)
                        .expect("supervisor lock poisoned");
                    guard = next;
                }
                let release_epoch = guard.run_seq;
                let res = match &guard.stop_authority {
                    StopAuthority::NeverStarted | StopAuthority::CleanExit => Ok(()),
                    StopAuthority::Unclean(reason) => Err(StopError(reason.clone())),
                    StopAuthority::Running => {
                        let msg = "Host process exited without clean stop confirmation".to_owned();
                        guard.stop_authority = StopAuthority::Unclean(msg.clone());
                        Err(StopError(msg))
                    }
                };
                drop(guard);
                self.inner.power.release_through(release_epoch);
                return res;
            }
        };

        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        let res = client.shutdown_and_wait(remaining);
        let res = {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            while guard.active_run {
                let (next, _) = self
                    .inner
                    .cv
                    .wait_timeout(guard, Duration::from_millis(200))
                    .expect("supervisor lock poisoned");
                guard = next;
            }
            release_epoch = release_epoch.max(guard.run_seq);
            match &res {
                Ok(()) => {
                    guard.stop_authority = StopAuthority::CleanExit;
                    self.inner.cv.notify_all();
                }
                Err(err) => {
                    guard.stop_authority = StopAuthority::Unclean(err.0.clone());
                    self.inner.cv.notify_all();
                }
            }
            res
        };
        self.inner.power.release_through(release_epoch);
        res
    }
}

impl Drop for HostSupervisor {
    fn drop(&mut self) {
        let (client, release_epoch) = {
            let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
            guard.destroyed = true;
            guard.stopping = true;
            guard.paused = true;
            self.inner.cv.notify_all();
            (guard.client.take(), guard.run_seq)
        };
        if let Some(client) = client {
            let _ = client.shutdown_and_wait(Duration::from_millis(500));
        }
        self.inner.power.release_through(release_epoch);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let final_epoch = self
            .inner
            .state
            .lock()
            .expect("supervisor lock poisoned")
            .run_seq;
        self.inner.power.release_through(final_epoch);
    }
}

fn compute_backoff(attempt: u32, initial: Duration, max: Duration) -> Duration {
    let shift = attempt.min(20);
    let factor = 1u32 << shift;
    initial.saturating_mul(factor).min(max)
}

struct SpawnedLaunch {
    run_id: u64,
    expected_version: u32,
    hello_timeout: Duration,
    spawn_result: std::io::Result<Child>,
}

enum LaunchDecision {
    Launch(SpawnedLaunch),
    RetryWait,
    WaitBusy,
}

fn spawn_host(inner: &SupervisorInner) -> std::io::Result<Child> {
    #[cfg(test)]
    {
        let hook = inner
            .in_launch_spawn
            .lock()
            .expect("test hook lock poisoned")
            .clone();
        if let Some(hook) = hook {
            return hook(&inner.config.command);
        }
    }
    spawn_host_child(&inner.config.command, &[])
}

#[cfg(test)]
fn run_before_connect_hello(inner: &SupervisorInner) {
    let hook = inner
        .before_connect_hello
        .lock()
        .expect("test hook lock poisoned")
        .clone();
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(not(test))]
fn run_before_connect_hello(_inner: &SupervisorInner) {}

fn reserve_and_spawn(guard: &mut SupervisorState, inner: &SupervisorInner) -> LaunchDecision {
    if guard.destroyed || guard.paused || guard.stopping || guard.client.is_some() {
        return LaunchDecision::RetryWait;
    }
    let spawn_result = spawn_host(inner);
    guard.run_seq = guard.run_seq.saturating_add(1);
    let run_id = guard.run_seq;
    guard.active_run = true;
    guard.connecting = true;
    guard.stop_authority = StopAuthority::Running;
    LaunchDecision::Launch(SpawnedLaunch {
        run_id,
        expected_version: inner.config.contract.bridge_version,
        hello_timeout: inner.config.shutdown_grace,
        spawn_result,
    })
}

fn decide_launch(inner: &SupervisorInner, maintenance: Option<&MaintenanceLock>) -> LaunchDecision {
    match maintenance {
        Some(lock) => lock.with_launch_state(|gate| {
            let mut guard = inner.state.lock().expect("supervisor lock poisoned");
            if guard.destroyed || guard.paused || guard.stopping || guard.client.is_some() {
                return LaunchDecision::RetryWait;
            }
            if gate.quitting || gate.handover != HandoverState::None {
                guard.paused = true;
                guard.stopping = true;
                inner.cv.notify_all();
                return LaunchDecision::RetryWait;
            }
            if gate.busy {
                return LaunchDecision::WaitBusy;
            }
            reserve_and_spawn(&mut guard, inner)
        }),
        None => {
            let mut guard = inner.state.lock().expect("supervisor lock poisoned");
            reserve_and_spawn(&mut guard, inner)
        }
    }
}

fn wait_for_next_launch(inner: &SupervisorInner) -> Option<SpawnedLaunch> {
    loop {
        let maintenance = {
            let mut guard = inner.state.lock().expect("supervisor lock poisoned");
            while !guard.destroyed && (guard.paused || guard.stopping || guard.client.is_some()) {
                guard = inner.cv.wait(guard).expect("supervisor lock poisoned");
            }
            if guard.destroyed {
                return None;
            }
            guard.maintenance.clone()
        };

        #[cfg(test)]
        {
            let hook = inner
                .before_launch_reserve
                .lock()
                .expect("test hook lock poisoned")
                .clone();
            if let Some(hook) = hook {
                hook();
            }
        }

        // Canonical lock order (`MaintenanceLock` -> `HostSupervisor`): check maintenance state,
        // reserve the run, and spawn the Host child under one `MaintenanceLock::with_launch_state`
        // acquisition so a recorded quit cannot slip between reservation and process creation;
        // the lock is released before `BridgeClient::connect_with_hello_timeout`.
        match decide_launch(inner, maintenance.as_ref()) {
            LaunchDecision::Launch(launch) => return Some(launch),
            LaunchDecision::RetryWait => continue,
            LaunchDecision::WaitBusy => {
                let guard = inner.state.lock().expect("supervisor lock poisoned");
                if !guard.destroyed && !guard.paused && !guard.stopping && guard.client.is_none() {
                    let _ = inner
                        .cv
                        .wait_timeout(guard, Duration::from_millis(10))
                        .expect("supervisor lock poisoned");
                }
            }
        }
    }
}

fn supervisor_loop(inner: Arc<SupervisorInner>) {
    while let Some(launch) = wait_for_next_launch(&inner) {
        let run_id = launch.run_id;
        let started_at = Instant::now();
        let state_inner = Arc::clone(&inner);
        let connect_result = launch
            .spawn_result
            .map_err(|err| {
                BridgeError::new(
                    BridgeErrorCode::HostExited,
                    format!("Failed to spawn Host: {err}"),
                )
            })
            .and_then(|child| {
                run_before_connect_hello(&inner);
                BridgeClient::connect_with_hello_timeout(
                    child,
                    launch.expected_version,
                    Some(launch.hello_timeout),
                    move |host_state| {
                        state_inner.publish_host_state(run_id, host_state);
                    },
                )
            });

        match connect_result {
            Ok(client) => {
                let client = Arc::new(client);
                let mut should_shutdown_immediately = false;
                {
                    let mut guard = inner.state.lock().expect("supervisor lock poisoned");
                    guard.connecting = false;
                    if guard.stopping || guard.destroyed {
                        should_shutdown_immediately = true;
                    } else {
                        guard.client = Some(Arc::clone(&client));
                    }
                    inner.cv.notify_all();
                }

                if should_shutdown_immediately {
                    let res = client.shutdown_and_wait(inner.config.shutdown_grace);
                    inner.power.release_through(run_id);
                    let mut guard = inner.state.lock().expect("supervisor lock poisoned");
                    guard.active_run = false;
                    guard.stop_authority = match res {
                        Ok(()) => StopAuthority::CleanExit,
                        Err(err) => StopAuthority::Unclean(err.0),
                    };
                    inner.cv.notify_all();
                    continue;
                }

                let exit_code = loop {
                    if let Some(code) = client.wait_exit(Duration::from_secs(3600)) {
                        break code;
                    }
                    let guard = inner.state.lock().expect("supervisor lock poisoned");
                    if guard.destroyed || guard.stopping {
                        break client.exit_code().flatten();
                    }
                };

                inner.power.release_through(run_id);
                let was_stopping = {
                    let mut guard = inner.state.lock().expect("supervisor lock poisoned");
                    guard.client = None;
                    guard.active_run = false;
                    let stopping = guard.stopping || guard.destroyed;
                    if !stopping {
                        guard.stop_authority = StopAuthority::Unclean(format!(
                            "Host exited unexpectedly with code {exit_code:?}"
                        ));
                    }
                    inner.cv.notify_all();
                    stopping
                };

                if !was_stopping {
                    backoff_wait(
                        &inner,
                        started_at,
                        format!("Host exited with code {exit_code:?}"),
                    );
                }
            }
            Err(err) => {
                inner.power.release_through(run_id);
                let is_mismatch = err.code == BridgeErrorCode::BridgeVersionMismatch;
                let was_stopping = {
                    let mut guard = inner.state.lock().expect("supervisor lock poisoned");
                    guard.connecting = false;
                    guard.active_run = false;
                    guard.stop_authority = StopAuthority::Unclean(err.message.clone());
                    if is_mismatch {
                        guard.paused = true;
                    }
                    inner.cv.notify_all();
                    guard.stopping || guard.destroyed
                };

                if is_mismatch {
                    inner.publish_state(SupervisedHostState::Failed {
                        reason: err.message,
                    });
                } else if !was_stopping {
                    backoff_wait(&inner, started_at, err.message);
                }
            }
        }
    }
}

fn backoff_wait(inner: &Arc<SupervisorInner>, started_at: Instant, reason: String) {
    let delay = {
        let mut guard = inner.state.lock().expect("supervisor lock poisoned");
        if guard.stopping || guard.paused || guard.destroyed {
            return;
        }
        if started_at.elapsed() >= inner.config.backoff_reset {
            guard.attempt = 0;
        }
        let wait = compute_backoff(
            guard.attempt,
            inner.config.initial_backoff,
            inner.config.max_backoff,
        );
        guard.attempt = guard.attempt.saturating_add(1);
        wait
    };

    inner.publish_state(SupervisedHostState::Restarting {
        in_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        reason,
    });

    let deadline = Instant::now() + delay;
    let mut guard = inner.state.lock().expect("supervisor lock poisoned");
    while !guard.destroyed && !guard.stopping && !guard.paused {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return;
        };
        let (next, _) = inner
            .cv
            .wait_timeout(guard, remaining)
            .expect("supervisor lock poisoned");
        guard = next;
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::maintenance::QuitOutcome;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(prefix: &str) -> Self {
            static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create test dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if pred() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        pred()
    }

    fn count_lines(path: &Path) -> usize {
        fs::read_to_string(path)
            .map(|text| text.lines().filter(|line| !line.is_empty()).count())
            .unwrap_or(0)
    }

    fn write_mock_host(dir: &Path, name: &str, spawns_log: &Path, exit_on_second_hello: bool) -> PathBuf {
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
    if ({exit_immediately}) {{
      setTimeout(() => process.exit(1), 25);
    }}
  }} else if (msg.method === 'shutdown') {{
    process.stdout.write(JSON.stringify({{ id: msg.id, result: null }}) + '\n');
    process.exit(0);
  }}
}});
"#,
            spawns_log = serde_json::to_string(&spawns_log.to_string_lossy().into_owned()).unwrap(),
            exit_immediately = if exit_on_second_hello { "true" } else { "false" },
        );
        let path = dir.join(format!("{name}.mjs"));
        fs::write(&path, script).expect("write mock host");
        path
    }

    fn one_shot_barrier() -> (Arc<dyn Fn() + Send + Sync>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(Some((entered_tx, release_rx))));
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let pair = state.lock().expect("barrier lock poisoned").take();
            if let Some((tx, rx)) = pair {
                let _ = tx.send(());
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
        });
        (hook, entered_rx, release_tx)
    }

    #[test]
    fn restart_vetoes_launch_when_quit_recorded_after_old_host_stops_before_unpause() {
        let tmp = TestDir::new("byok-host-restart-quit-before-unpause");
        let spawns_log = tmp.path().join("spawns.log");
        let script = write_mock_host(tmp.path(), "host", &spawns_log, false);
        let contract = BridgeContract::load().expect("contract loads");
        let lock = MaintenanceLock::new();

        let sup = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(HostCommandSpec::dev_node_host(script), contract)
                .with_maintenance_lock(lock.clone()),
            |_| {},
            || {},
        ));
        sup.start();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(sup.last_state(), Some(SupervisedHostState::Stopped { .. }))
        }));
        assert_eq!(count_lines(&spawns_log), 1);

        let (hook, entered_rx, release_tx) = one_shot_barrier();
        *sup.inner.before_finish_restart.lock().unwrap() = Some(hook);

        let sup_bg = Arc::clone(&sup);
        let lock_bg = lock.clone();
        let restart_handle = thread::spawn(move || sup_bg.restart(&lock_bg));

        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("restart must reach post-stop pre-unpause barrier after old Host exits");
        assert!(
            !sup.inner.state.lock().unwrap().active_run,
            "old Host must already be completely stopped and settled at barrier"
        );

        let (quit_marked_tx, quit_marked_rx) = mpsc::channel();
        lock.on_quit_requested(move || {
            let _ = quit_marked_tx.send(());
        });
        let quit_lock = lock.clone();
        let quit_handle = thread::spawn(move || quit_lock.begin_quit());
        quit_marked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("begin_quit must mark quitting while restart is at pre-unpause barrier");

        release_tx.send(()).expect("release pre-unpause barrier");

        assert_eq!(
            restart_handle.join().unwrap(),
            Err(MaintenanceBusyError),
            "restart must refuse once quit is recorded before unpausing"
        );
        assert_eq!(quit_handle.join().unwrap(), QuitOutcome::Quit);
        assert_eq!(
            count_lines(&spawns_log),
            1,
            "refused restart must not launch a replacement Host"
        );
        sup.stop().expect("supervisor stop stays clean");
    }

    #[test]
    fn worker_vetoes_replacement_launch_when_quit_recorded_after_restart_unpauses_before_stop() {
        let tmp = TestDir::new("byok-host-restart-quit-before-reserve");
        let spawns_log = tmp.path().join("spawns.log");
        let script = write_mock_host(tmp.path(), "host", &spawns_log, false);
        let contract = BridgeContract::load().expect("contract loads");
        let lock = MaintenanceLock::new();

        // Notice: constructed WITHOUT `with_maintenance_lock` to prove `restart(&lock)` itself
        // binds `MaintenanceLock` for the worker's launch reservation check.
        let sup = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(HostCommandSpec::dev_node_host(script), contract),
            |_| {},
            || {},
        ));
        sup.start();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(sup.last_state(), Some(SupervisedHostState::Stopped { .. }))
        }));
        assert_eq!(count_lines(&spawns_log), 1);

        // Pause the supervisor worker right after restart() unpauses it, before launch reservation.
        let (hook, entered_rx, release_tx) = one_shot_barrier();
        *sup.inner.before_launch_reserve.lock().unwrap() = Some(hook);

        sup.restart(&lock)
            .expect("restart completes before quit is requested");

        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker must wake from restart() and reach pre-reserve barrier");

        // Record quit WITHOUT calling sup.stop() yet — simulates the race window between
        // MaintenanceLock::begin_quit() and HostSupervisor::stop().
        assert_eq!(lock.begin_quit(), QuitOutcome::Quit);

        release_tx.send(()).expect("release pre-reserve barrier");

        assert!(
            wait_until(Duration::from_secs(5), || {
                let guard = sup.inner.state.lock().unwrap();
                guard.paused && guard.stopping && !guard.active_run
            }),
            "worker must veto launch and return to paused/stopping when quit is recorded"
        );
        assert_eq!(
            count_lines(&spawns_log),
            1,
            "recorded quit must veto replacement Host launch before sup.stop() runs"
        );
        sup.stop()
            .expect("stop() after vetoed replacement launch must stay clean");
        assert_eq!(count_lines(&spawns_log), 1);
    }

    #[test]
    fn bound_maintenance_lock_vetoes_backoff_respawn_after_quit_and_allows_restart_without_quit() {
        let tmp = TestDir::new("byok-host-quit-veto-control");
        let contract = BridgeContract::load().expect("contract loads");

        // 1. Control: releasing pre-reserve barrier WITHOUT quit launches replacement Host normally.
        let control_spawns = tmp.path().join("control-spawns.log");
        let control_script = write_mock_host(tmp.path(), "control", &control_spawns, false);
        let control_lock = MaintenanceLock::new();
        let control_sup = HostSupervisor::new(
            HostSupervisorConfig::new(
                HostCommandSpec::dev_node_host(control_script),
                contract.clone(),
            )
            .with_maintenance_lock(control_lock.clone()),
            |_| {},
            || {},
        );
        control_sup.start();
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                control_sup.last_state(),
                Some(SupervisedHostState::Stopped { .. })
            )
        }));
        let first_pid = match control_sup.last_state() {
            Some(SupervisedHostState::Stopped { pid, .. }) => pid,
            other => panic!("expected stopped state, got {other:?}"),
        };
        assert_eq!(count_lines(&control_spawns), 1);

        let (hook, entered_rx, release_tx) = one_shot_barrier();
        *control_sup.inner.before_launch_reserve.lock().unwrap() = Some(hook);
        control_sup
            .restart(&control_lock)
            .expect("control restart succeeds");
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker reaches pre-reserve barrier");
        release_tx.send(()).expect("release barrier without quit");
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                control_sup.last_state(),
                Some(SupervisedHostState::Stopped { pid, .. }) if pid != first_pid
            )
        }));
        assert_eq!(count_lines(&control_spawns), 2);
        control_sup.stop().expect("control stop succeeds");

        // 2. Sibling path: crash-backoff respawn is also vetoed when quit is recorded before launch.
        let crash_spawns = tmp.path().join("crash-spawns.log");
        let crash_script = write_mock_host(tmp.path(), "crash", &crash_spawns, true);
        let crash_lock = MaintenanceLock::new();
        let mut crash_cfg = HostSupervisorConfig::new(
            HostCommandSpec::dev_node_host(crash_script),
            contract,
        )
        .with_maintenance_lock(crash_lock.clone());
        crash_cfg.initial_backoff = Duration::from_millis(30);
        crash_cfg.max_backoff = Duration::from_millis(60);

        let crash_sup = HostSupervisor::new(crash_cfg, |_| {}, || {});
        // Skip first launch (allow it), pause on the second launch (the crash-backoff respawn).
        let (respawn_entered_tx, respawn_entered_rx) = mpsc::channel();
        let (respawn_release_tx, respawn_release_rx) = mpsc::channel();
        let seen = Arc::new(AtomicUsize::new(0));
        let release_rx = Arc::new(Mutex::new(Some(respawn_release_rx)));
        *crash_sup.inner.before_launch_reserve.lock().unwrap() = Some(Arc::new(move || {
            if seen.fetch_add(1, Ordering::SeqCst) == 1 {
                let _ = respawn_entered_tx.send(());
                if let Some(rx) = release_rx.lock().unwrap().take() {
                    let _ = rx.recv_timeout(Duration::from_secs(5));
                }
            }
        }));

        crash_sup.start();
        respawn_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker must reach pre-reserve barrier after crash backoff");
        assert_eq!(count_lines(&crash_spawns), 1);

        // Record quit via mark_quitting() (e.g., while begin_quit waits on a custody child)
        // before supervisor.stop() runs.
        crash_lock.mark_quitting();
        respawn_release_tx.send(()).expect("release respawn barrier");

        assert!(
            wait_until(Duration::from_secs(5), || {
                let guard = crash_sup.inner.state.lock().unwrap();
                guard.paused && guard.stopping && !guard.active_run
            }),
            "crash-backoff respawn must be vetoed once quit is recorded"
        );
        assert_eq!(
            count_lines(&crash_spawns),
            1,
            "recorded quit must veto backoff respawn as well"
        );

        // 3. Sibling path: start() with a bound MaintenanceLock defers while transient `busy` is
        //    held, spawns once `busy` releases cleanly, and vetoes start() once quit/handover is set.
        let busy_spawns = tmp.path().join("busy-spawns.log");
        let busy_script = write_mock_host(tmp.path(), "busy", &busy_spawns, false);
        let busy_lock = MaintenanceLock::new();
        let busy_guard = busy_lock.try_begin().expect("hold transient maintenance");
        let busy_sup = HostSupervisor::new(
            HostSupervisorConfig::new(
                HostCommandSpec::dev_node_host(busy_script.clone()),
                BridgeContract::load().expect("contract loads"),
            )
            .with_maintenance_lock(busy_lock.clone()),
            |_| {},
            || {},
        );
        busy_sup.start();
        thread::sleep(Duration::from_millis(60));
        assert_eq!(
            count_lines(&busy_spawns),
            0,
            "supervisor must not launch a Host while transient MaintenanceGuard is held"
        );
        drop(busy_guard);
        assert!(wait_until(Duration::from_secs(5), || {
            matches!(
                busy_sup.last_state(),
                Some(SupervisedHostState::Stopped { .. })
            )
        }));
        assert_eq!(count_lines(&busy_spawns), 1);
        busy_sup.stop().expect("busy supervisor stops cleanly");

        let veto_spawns = tmp.path().join("veto-start-spawns.log");
        let veto_script = write_mock_host(tmp.path(), "veto-start", &veto_spawns, false);
        let veto_lock = MaintenanceLock::new();
        veto_lock.mark_quitting();
        let veto_sup = HostSupervisor::new(
            HostSupervisorConfig::new(
                HostCommandSpec::dev_node_host(veto_script),
                BridgeContract::load().expect("contract loads"),
            )
            .with_maintenance_lock(veto_lock),
            |_| {},
            || {},
        );
        veto_sup.start();
        assert!(
            wait_until(Duration::from_secs(5), || {
                let guard = veto_sup.inner.state.lock().unwrap();
                guard.paused && guard.stopping && !guard.active_run
            }),
            "start() must be vetoed when bound MaintenanceLock already recorded quit"
        );
        assert_eq!(count_lines(&veto_spawns), 0);
    }

    fn is_pid_alive(pid: u32) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: kill(pid, 0) probes process existence without delivering a signal.
            unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
        }
        #[cfg(windows)]
        {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output();
            match out {
                Ok(res) => String::from_utf8_lossy(&res.stdout).contains(&format!(",\"{pid}\",")),
                Err(_) => false,
            }
        }
    }

    fn read_logged_pids(path: &Path) -> Vec<u32> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect()
    }

    fn write_mock_host_with_shutdown_log(
        dir: &Path,
        name: &str,
        spawns_log: &Path,
        shutdowns_log: &Path,
    ) -> PathBuf {
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
        let path = dir.join(format!("{name}.mjs"));
        fs::write(&path, script).expect("write mock host");
        path
    }

    fn wait_state_cond(
        inner: &SupervisorInner,
        timeout: Duration,
        mut pred: impl FnMut(&SupervisorState) -> bool,
        context: &str,
    ) {
        let deadline = Instant::now() + timeout;
        let mut guard = inner.state.lock().expect("supervisor lock poisoned");
        while !pred(&guard) {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("timed out waiting for supervisor state: {context}"));
            let (next, res) = inner
                .cv
                .wait_timeout(guard, remaining)
                .expect("supervisor lock poisoned");
            guard = next;
            if res.timed_out() && !pred(&guard) {
                panic!("timed out waiting for supervisor state: {context}");
            }
        }
    }

    fn wait_for_stopped_pid(
        state_rx: &mpsc::Receiver<SupervisedHostState>,
        timeout: Duration,
    ) -> u32 {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("timed out waiting for SupervisedHostState::Stopped");
            match state_rx.recv_timeout(remaining) {
                Ok(SupervisedHostState::Stopped { pid, .. }) => return pid,
                Ok(_) => continue,
                Err(err) => panic!("failed waiting for SupervisedHostState::Stopped: {err}"),
            }
        }
    }

    #[test]
    fn launch_held_before_with_launch_state_never_spawns_when_quit_recorded() {
        let tmp = TestDir::new("byok-host-launch-before-lock-quit");
        let spawns_log = tmp.path().join("spawns.log");
        let shutdowns_log = tmp.path().join("shutdowns.log");
        let script =
            write_mock_host_with_shutdown_log(tmp.path(), "host", &spawns_log, &shutdowns_log);
        let contract = BridgeContract::load().expect("contract loads");
        let lock = MaintenanceLock::new();
        let spawn_calls = Arc::new(AtomicUsize::new(0));

        let sup = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(HostCommandSpec::dev_node_host(script), contract)
                .with_maintenance_lock(lock.clone()),
            |_| {},
            || {},
        ));

        let spawn_calls_hook = Arc::clone(&spawn_calls);
        *sup.inner.in_launch_spawn.lock().unwrap() = Some(Arc::new(move |command| {
            spawn_calls_hook.fetch_add(1, Ordering::SeqCst);
            spawn_host_child(command, &[])
        }));

        let (pre_hook, pre_entered_rx, pre_release_tx) = one_shot_barrier();
        *sup.inner.before_launch_reserve.lock().unwrap() = Some(pre_hook);

        sup.start();
        pre_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker must pause before entering with_launch_state");
        assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);

        // MaintenanceLock is not held at the pre-reserve barrier, so begin_quit records quit cleanly.
        assert_eq!(lock.begin_quit(), QuitOutcome::Quit);

        pre_release_tx
            .send(())
            .expect("release pre-with_launch_state barrier");

        wait_state_cond(
            &sup.inner,
            Duration::from_secs(5),
            |st| st.paused && st.stopping && !st.active_run && !st.connecting,
            "worker vetoes launch on recorded quit",
        );

        assert_eq!(
            spawn_calls.load(Ordering::SeqCst),
            0,
            "spawn_host_child must never be called after quit is recorded"
        );
        assert_eq!(count_lines(&spawns_log), 0);
        assert_eq!(
            sup.restart(&lock),
            Err(MaintenanceBusyError),
            "restart must return the existing maintenance_busy outcome after quit"
        );
        assert_eq!(
            MaintenanceBusyError.code(),
            crate::maintenance::MAINTENANCE_BUSY_CODE
        );
        assert_eq!(
            sup.stop(),
            Ok(()),
            "stop after vetoed launch must remain clean"
        );
        assert_eq!(spawn_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn quit_during_in_lock_spawn_blocks_then_drains_child_without_orphan() {
        let tmp = TestDir::new("byok-host-quit-during-in-lock-spawn");
        let spawns_log = tmp.path().join("spawns.log");
        let shutdowns_log = tmp.path().join("shutdowns.log");
        let script =
            write_mock_host_with_shutdown_log(tmp.path(), "host", &spawns_log, &shutdowns_log);
        let contract = BridgeContract::load().expect("contract loads");
        let lock = MaintenanceLock::new();

        // Register quit observer before launch holds MaintenanceLock to avoid locking during the barrier.
        let (quit_marked_tx, quit_marked_rx) = mpsc::channel();
        lock.on_quit_requested(move || {
            let _ = quit_marked_tx.send(());
        });

        let (state_tx, state_rx) = mpsc::channel();
        let sup = Arc::new(HostSupervisor::new(
            HostSupervisorConfig::new(HostCommandSpec::dev_node_host(script), contract)
                .with_maintenance_lock(lock.clone()),
            move |state| {
                let _ = state_tx.send(state);
            },
            || {},
        ));

        sup.start();
        let first_pid = wait_for_stopped_pid(&state_rx, Duration::from_secs(5));
        assert_eq!(read_logged_pids(&spawns_log), vec![first_pid]);

        // Hold the replacement spawn inside MaintenanceLock::with_launch_state, then pause again
        // after the lock is released and before BridgeClient::connect_with_hello_timeout.
        let (spawn_entered_tx, spawn_entered_rx) = mpsc::channel::<u32>();
        let (spawn_release_tx, spawn_release_rx) = mpsc::channel::<()>();
        let spawn_barrier_state = Arc::new(Mutex::new(Some((spawn_entered_tx, spawn_release_rx))));
        *sup.inner.in_launch_spawn.lock().unwrap() = Some(Arc::new(move |command| {
            let child = spawn_host_child(command, &[])?;
            if let Some((tx, rx)) = spawn_barrier_state.lock().unwrap().take() {
                let _ = tx.send(child.id());
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
            Ok(child)
        }));

        let (connect_hook, connect_entered_rx, connect_release_tx) = one_shot_barrier();
        *sup.inner.before_connect_hello.lock().unwrap() = Some(connect_hook);

        sup.restart(&lock)
            .expect("restart succeeds before quit is requested");

        let spawned_pid = spawn_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replacement launch must pause inside spawn_host_child with MaintenanceLock held");
        assert_ne!(spawned_pid, first_pid);

        let (quit_started_tx, quit_started_rx) = mpsc::channel();
        let (quit_lock_done_tx, quit_lock_done_rx) = mpsc::channel();
        let quit_lock = lock.clone();
        let quit_sup = Arc::clone(&sup);
        let quit_handle = thread::spawn(move || {
            let _ = quit_started_tx.send(());
            let outcome = quit_lock.begin_quit();
            let _ = quit_lock_done_tx.send(outcome);
            let stop_res = quit_sup.stop();
            (outcome, stop_res)
        });

        quit_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("quit drain thread must start");
        assert_eq!(
            quit_marked_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty),
            "begin_quit must block while spawn_host_child holds MaintenanceLock"
        );
        assert_eq!(
            quit_lock_done_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty),
            "begin_quit must not complete while spawn_host_child holds MaintenanceLock"
        );

        // Release spawn barrier: with_launch_state returns Child and drops MaintenanceLock before hello.
        spawn_release_tx
            .send(())
            .expect("release in-lock spawn barrier");

        connect_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("worker must reach pre-hello hook after releasing MaintenanceLock");
        quit_marked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("begin_quit must acquire MaintenanceLock once spawn releases it");
        assert_eq!(
            quit_lock_done_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("begin_quit must finish before BridgeClient::connect_with_hello_timeout"),
            QuitOutcome::Quit
        );

        // Ensure quit drain has entered sup.stop() while the spawned child is still connecting.
        wait_state_cond(
            &sup.inner,
            Duration::from_secs(5),
            |st| st.stopping && st.paused && st.connecting && st.active_run,
            "quit drain enters sup.stop() before hello finishes",
        );

        connect_release_tx
            .send(())
            .expect("release pre-hello barrier so worker hands child to immediate shutdown");

        let (outcome, stop_res) = quit_handle.join().expect("quit thread joins cleanly");
        assert_eq!(outcome, QuitOutcome::Quit);
        assert_eq!(
            stop_res,
            Ok(()),
            "quit drain must take over and cleanly stop the spawned child"
        );

        assert!(
            !is_pid_alive(first_pid),
            "first Host process must not remain alive"
        );
        assert!(
            !is_pid_alive(spawned_pid),
            "spawned replacement Host must not remain an orphan process"
        );
        assert_eq!(read_logged_pids(&spawns_log), vec![first_pid, spawned_pid]);
        assert_eq!(
            read_logged_pids(&shutdowns_log),
            vec![first_pid, spawned_pid]
        );
        {
            let guard = sup.inner.state.lock().unwrap();
            assert!(guard.paused && guard.stopping && !guard.active_run && !guard.connecting);
            assert!(guard.client.is_none());
        }
        assert_eq!(sup.restart(&lock), Err(MaintenanceBusyError));
    }
}
