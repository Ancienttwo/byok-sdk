//! Host child process supervisor, exponential backoff, clean stop authority, and 50 ms hint coalescing.

use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::bridge::{
    BridgeClient, BridgeError, BridgeErrorCode, HostState, StopError, SupervisedHostState,
};
use crate::command::{HostCommandSpec, spawn_host_child};
use crate::contract::BridgeContract;
use crate::maintenance::{MaintenanceBusyError, MaintenanceLock};
use crate::power::{
    DEFAULT_KEEP_AWAKE_REASON, DEFAULT_KEEP_AWAKE_WHO, KeepAwakeBackend, KeepAwakeGuard,
    PowerError, SystemKeepAwakeBackend,
};

type HintCallback = Box<dyn Fn() + Send + Sync>;
type StateCallback = Arc<dyn Fn(SupervisedHostState) + Send + Sync>;
type PowerErrorCallback = Arc<dyn Fn(PowerError) + Send + Sync>;

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
        }
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
}

struct SupervisorInner {
    config: HostSupervisorConfig,
    state: Mutex<SupervisorState>,
    cv: Condvar,
    on_state: StateCallback,
    coalescer: StateHintCoalescer,
    power: KeepAwakeController,
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
            }),
            cv: Condvar::new(),
            on_state: Arc::new(on_state),
            coalescer: StateHintCoalescer::new(hint_window, on_hint),
            power,
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

    /// Starts Host supervision if not already started.
    pub fn start(&self) {
        let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
        guard.stopping = false;
        guard.paused = false;
        self.inner.cv.notify_all();
    }

    /// Restarts supervision under a single [`MaintenanceLock::try_begin`] acquisition so no Host
    /// can start while recovery, handover, custody, or app quit holds the maintenance lock.
    pub fn restart(&self, maintenance: &MaintenanceLock) -> Result<(), MaintenanceBusyError> {
        let _maintenance_guard = maintenance.try_begin()?;
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
        let mut guard = self.inner.state.lock().expect("supervisor lock poisoned");
        if maintenance.is_quitting() {
            return Err(MaintenanceBusyError);
        }
        if guard.destroyed {
            return Ok(());
        }
        guard.attempt = 0;
        guard.stopping = false;
        guard.paused = false;
        guard.stop_authority = StopAuthority::Running;
        self.inner.cv.notify_all();
        Ok(())
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

fn supervisor_loop(inner: Arc<SupervisorInner>) {
    loop {
        let mut guard = inner.state.lock().expect("supervisor lock poisoned");
        while !guard.destroyed && (guard.paused || guard.stopping || guard.client.is_some()) {
            guard = inner.cv.wait(guard).expect("supervisor lock poisoned");
        }
        if guard.destroyed {
            return;
        }
        guard.run_seq = guard.run_seq.saturating_add(1);
        let run_id = guard.run_seq;
        guard.active_run = true;
        guard.connecting = true;
        guard.stop_authority = StopAuthority::Running;
        let expected_version = inner.config.contract.bridge_version;
        let hello_timeout = inner.config.shutdown_grace;
        let command = inner.config.command.clone();
        drop(guard);

        let started_at = Instant::now();
        let state_inner = Arc::clone(&inner);
        let connect_result = spawn_host_child(&command, &[])
            .map_err(|err| {
                BridgeError::new(
                    BridgeErrorCode::HostExited,
                    format!("Failed to spawn Host: {err}"),
                )
            })
            .and_then(|child| {
                BridgeClient::connect_with_hello_timeout(
                    child,
                    expected_version,
                    Some(hello_timeout),
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
                    backoff_wait(&inner, started_at, format!("Host exited with code {exit_code:?}"));
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
