//! Process-wide Host supervisor singleton and engine-thread event fan-out for NSH Mixed.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use byok_shell::{
    BridgeContract, HostCommandSpec, HostSupervisor, HostSupervisorConfig, MaintenanceLock,
    ShellRouter,
};
use nsh_core::JsonValue;
use nsh_core::element::{Local, blocking};
use nsh_core::prelude::*;

/// Single process-wide runtime shell (survives TSX hot reloads and holds one MaintenanceLock per storage root).
#[derive(Clone)]
pub(crate) struct RuntimeShell {
    pub supervisor: Arc<HostSupervisor>,
    pub maintenance: MaintenanceLock,
    pub router: Arc<ShellRouter>,
    pub app_version: String,
}

static RUNTIME_SHELL: OnceLock<Mutex<Option<RuntimeShell>>> = OnceLock::new();
static EVENT_HUB: OnceLock<Arc<EventHub>> = OnceLock::new();

fn shell_slot() -> &'static Mutex<Option<RuntimeShell>> {
    RUNTIME_SHELL.get_or_init(|| Mutex::new(None))
}

pub(crate) fn event_hub() -> &'static Arc<EventHub> {
    EVENT_HUB.get_or_init(|| {
        Arc::new(EventHub::with_quitting_hook(|| {
            if let Some(shell) = active_shell() {
                shell.maintenance.mark_quitting();
            }
        }))
    })
}

pub(crate) fn active_shell() -> Option<RuntimeShell> {
    shell_slot()
        .lock()
        .expect("runtime shell lock poisoned")
        .clone()
}

/// Cross-thread event broadcast from `HostSupervisor` / quit hooks to per-VM engine listeners.
#[derive(Debug, Clone)]
pub(crate) enum ShellEvent {
    State(JsonValue),
    StateHint,
    PowerError(JsonValue),
    Quitting,
}

pub(crate) struct EventHub {
    next_id: AtomicU64,
    subscribers: Mutex<HashMap<u64, mpsc::Sender<ShellEvent>>>,
    on_quitting: Option<Box<dyn Fn() + Send + Sync>>,
}

impl EventHub {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            subscribers: Mutex::new(HashMap::new()),
            on_quitting: None,
        }
    }

    pub(crate) fn with_quitting_hook<F>(on_quitting: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        Self {
            next_id: AtomicU64::new(1),
            subscribers: Mutex::new(HashMap::new()),
            on_quitting: Some(Box::new(on_quitting)),
        }
    }

    pub(crate) fn subscribe(&self) -> (u64, mpsc::Receiver<ShellEvent>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.subscribers
            .lock()
            .expect("event hub lock poisoned")
            .insert(id, tx);
        (id, rx)
    }

    pub(crate) fn unsubscribe(&self, id: u64) {
        self.subscribers
            .lock()
            .expect("event hub lock poisoned")
            .remove(&id);
    }

    pub(crate) fn publish(&self, event: ShellEvent) {
        let is_quitting = matches!(event, ShellEvent::Quitting);
        {
            let mut subscribers = self.subscribers.lock().expect("event hub lock poisoned");
            subscribers.retain(|_, tx| tx.send(event.clone()).is_ok());
        }
        // Mirror `begin_graceful_quit` / `fallback_app_quit_cleanup` into the active shell's
        // `MaintenanceLock` synchronously on the engine thread before the blocking drain task
        // runs so pending recovery-refusal dialogs and Host restarts observe quit immediately.
        if is_quitting && let Some(on_quitting) = &self.on_quitting {
            on_quitting();
        }
    }
}

/// Per-VM callback registry stored in `sys.locals` so test VMs and reloads never leak stale callbacks.
#[derive(Default)]
pub(crate) struct LocalHub {
    state_listeners: RefCell<Vec<(u64, Callback<JsonValue>)>>,
    hint_listeners: RefCell<Vec<(u64, Callback<()>)>>,
    power_error_listeners: RefCell<Vec<(u64, Callback<JsonValue>)>>,
    quitting_listeners: RefCell<Vec<(u64, Callback<()>)>>,
    next_listener_id: Cell<u64>,
    hub_subscription_id: Cell<Option<u64>>,
}

impl LocalHub {
    fn next_id(&self) -> u64 {
        let id = self.next_listener_id.get().wrapping_add(1);
        self.next_listener_id.set(id);
        id
    }

    fn is_empty(&self) -> bool {
        self.state_listeners.borrow().is_empty()
            && self.hint_listeners.borrow().is_empty()
            && self.power_error_listeners.borrow().is_empty()
            && self.quitting_listeners.borrow().is_empty()
    }

    fn stop_pump_if_idle(&self) {
        if self.is_empty()
            && let Some(sub_id) = self.hub_subscription_id.take()
        {
            event_hub().unsubscribe(sub_id);
        }
    }

    fn dispatch(&self, event: ShellEvent) {
        match event {
            ShellEvent::State(value) => {
                let list = self.state_listeners.borrow().clone();
                for (_, cb) in list {
                    cb.post(value.clone());
                }
            }
            ShellEvent::StateHint => {
                let list = self.hint_listeners.borrow().clone();
                for (_, cb) in list {
                    cb.post(());
                }
            }
            ShellEvent::PowerError(value) => {
                let list = self.power_error_listeners.borrow().clone();
                for (_, cb) in list {
                    cb.post(value.clone());
                }
            }
            ShellEvent::Quitting => {
                let list = self.quitting_listeners.borrow().clone();
                for (_, cb) in list {
                    cb.post(());
                }
            }
        }
    }
}

impl Local for LocalHub {
    fn close(&self) {
        self.state_listeners.borrow_mut().clear();
        self.hint_listeners.borrow_mut().clear();
        self.power_error_listeners.borrow_mut().clear();
        self.quitting_listeners.borrow_mut().clear();
        if let Some(sub_id) = self.hub_subscription_id.take() {
            event_hub().unsubscribe(sub_id);
        }
    }
}

fn ensure_pump(locals: &std::rc::Rc<LocalHub>, cx: CallCx<'_>) {
    if locals.hub_subscription_id.get().is_some() {
        return;
    }
    let (sub_id, mut rx) = event_hub().subscribe();
    locals.hub_subscription_id.set(Some(sub_id));
    let weak = std::rc::Rc::downgrade(locals);
    cx.start(async move {
        loop {
            let received = blocking(move || rx.recv().ok().map(|event| (event, rx)))
                .await
                .ok()
                .flatten();
            let Some((event, next_rx)) = received else {
                break;
            };
            rx = next_rx;
            let Some(hub) = weak.upgrade() else {
                break;
            };
            hub.dispatch(event);
        }
    });
}

fn register_stop<T: Clone + 'static>(
    locals: &std::rc::Rc<LocalHub>,
    cx: CallCx<'_>,
    add: impl FnOnce(&LocalHub, u64),
    remove: impl FnOnce(&LocalHub, u64) + 'static,
) -> Stop {
    let id = locals.next_id();
    add(locals, id);
    ensure_pump(locals, cx);
    let weak = std::rc::Rc::downgrade(locals);
    Stop::new(move || {
        if let Some(hub) = weak.upgrade() {
            remove(&hub, id);
            hub.stop_pump_if_idle();
        }
    })
}

pub(crate) fn subscribe_state(sys: &System, cx: CallCx<'_>, listener: Callback<JsonValue>) -> Stop {
    let locals = sys.locals.get::<LocalHub>();
    register_stop::<JsonValue>(
        &locals,
        cx,
        |hub, id| hub.state_listeners.borrow_mut().push((id, listener)),
        |hub, id| {
            hub.state_listeners
                .borrow_mut()
                .retain(|(entry, _)| *entry != id)
        },
    )
}

pub(crate) fn subscribe_state_hint(sys: &System, cx: CallCx<'_>, listener: Callback<()>) -> Stop {
    let locals = sys.locals.get::<LocalHub>();
    register_stop::<()>(
        &locals,
        cx,
        |hub, id| hub.hint_listeners.borrow_mut().push((id, listener)),
        |hub, id| {
            hub.hint_listeners
                .borrow_mut()
                .retain(|(entry, _)| *entry != id)
        },
    )
}

pub(crate) fn subscribe_power_error(
    sys: &System,
    cx: CallCx<'_>,
    listener: Callback<JsonValue>,
) -> Stop {
    let locals = sys.locals.get::<LocalHub>();
    register_stop::<JsonValue>(
        &locals,
        cx,
        |hub, id| hub.power_error_listeners.borrow_mut().push((id, listener)),
        |hub, id| {
            hub.power_error_listeners
                .borrow_mut()
                .retain(|(entry, _)| *entry != id);
        },
    )
}

pub(crate) fn subscribe_quitting(sys: &System, cx: CallCx<'_>, listener: Callback<()>) -> Stop {
    let locals = sys.locals.get::<LocalHub>();
    register_stop::<()>(
        &locals,
        cx,
        |hub, id| hub.quitting_listeners.borrow_mut().push((id, listener)),
        |hub, id| {
            hub.quitting_listeners
                .borrow_mut()
                .retain(|(entry, _)| *entry != id)
        },
    )
}

pub(crate) fn packaged_host_candidates(exe_dir: &Path) -> [PathBuf; 2] {
    let bin = if cfg!(windows) { "host.exe" } else { "host" };
    [
        exe_dir.join("resources").join("host").join(bin),
        exe_dir
            .parent()
            .unwrap_or(exe_dir)
            .join("Resources")
            .join("host")
            .join(bin),
    ]
}

fn find_dev_host_bundle() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("BYOK_DEV_HOST_BUNDLE") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut search_roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        search_roots.push(cwd);
    }
    search_roots.push(manifest_dir);
    for root in search_roots {
        for ancestor in root.ancestors() {
            let direct = ancestor.join("dist").join("host").join("host.cjs");
            if direct.is_file() {
                return Some(direct);
            }
            let workspace = ancestor
                .join("examples")
                .join("desktop-bot-app")
                .join("dist")
                .join("host")
                .join("host.cjs");
            if workspace.is_file() {
                return Some(workspace);
            }
        }
    }
    None
}

/// Resolves the Host executable strictly in Rust (packaged `resources/host/host[.exe]` or `BYOK_DEV_HOST_BUNDLE` / workspace dev bundle).
pub(crate) fn resolve_host_command_spec() -> Result<HostCommandSpec, JsError> {
    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        for candidate in packaged_host_candidates(exe_dir) {
            if candidate.is_file() {
                return Ok(HostCommandSpec::packaged_host(candidate));
            }
        }
    }
    if let Some(bundle) = find_dev_host_bundle() {
        return Ok(HostCommandSpec::dev_node_host(bundle));
    }
    Err(JsError::Error(
        "No packaged Host binary (`resources/host/host`) or dev Host bundle (`dist/host/host.cjs`) found"
            .to_owned(),
    )
    .with_code("host_exited"))
}

pub(crate) fn serialize_host_state(state: &byok_shell::SupervisedHostState) -> JsonValue {
    serde_json::to_value(state).unwrap_or(JsonValue::Null)
}

pub(crate) fn serialize_power_error(error: &byok_shell::PowerError) -> JsonValue {
    serde_json::json!({ "message": error.to_string() })
}

pub(crate) fn build_runtime_shell(
    command: HostCommandSpec,
    app_version: &str,
    start: bool,
) -> Result<RuntimeShell, JsError> {
    let contract = BridgeContract::load()
        .map_err(|err| JsError::Error(err.to_string()).with_code("contract_error"))?;
    let hub = Arc::clone(event_hub());
    let hint_hub = Arc::clone(&hub);
    let power_hub = Arc::clone(&hub);
    let maintenance = MaintenanceLock::new();

    let config = HostSupervisorConfig::new(command, contract)
        .with_maintenance_lock(maintenance.clone())
        .with_on_power_error(move |err| {
            power_hub.publish(ShellEvent::PowerError(serialize_power_error(&err)));
        });

    let supervisor = Arc::new(HostSupervisor::new(
        config,
        move |state| {
            hub.publish(ShellEvent::State(serialize_host_state(&state)));
        },
        move || {
            hint_hub.publish(ShellEvent::StateHint);
        },
    ));
    let router = Arc::new(ShellRouter::new(
        Arc::clone(&supervisor),
        maintenance.clone(),
        app_version,
    ));
    if start {
        supervisor.start();
    }
    Ok(RuntimeShell {
        supervisor,
        maintenance,
        router,
        app_version: app_version.to_owned(),
    })
}

fn create_shell_with_spec(
    command: HostCommandSpec,
    app_version: &str,
) -> Result<RuntimeShell, JsError> {
    build_runtime_shell(command, app_version, true)
}

pub(crate) fn ensure_started(app_version: Option<String>) -> Result<JsonValue, JsError> {
    let version = nsh_core::element::app_info()
        .filter(|info| !info.development)
        .and_then(|info| info.version)
        .or(app_version)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let mut slot = shell_slot().lock().expect("runtime shell lock poisoned");
    if let Some(existing) = slot.as_ref() {
        let current = existing
            .supervisor
            .last_state()
            .map(|state| serialize_host_state(&state))
            .unwrap_or(JsonValue::Null);
        return Ok(
            serde_json::json!({ "started": true, "alreadyStarted": true, "state": current }),
        );
    }

    let command = resolve_host_command_spec()?;
    let shell = create_shell_with_spec(command, &version)?;
    let current = shell
        .supervisor
        .last_state()
        .map(|state| serialize_host_state(&state))
        .unwrap_or(JsonValue::Null);
    *slot = Some(shell);
    Ok(serde_json::json!({ "started": true, "alreadyStarted": false, "state": current }))
}

pub(crate) fn restart_shell_sync(shell: &RuntimeShell) -> Result<(), JsError> {
    shell
        .supervisor
        .restart(&shell.maintenance)
        .map_err(|err| JsError::Error(err.to_string()).with_code(err.code()))
}

pub(crate) async fn restart_supervisor() -> Result<(), JsError> {
    crate::updater::check_host_restart()?;
    let shell = active_shell().ok_or_else(|| {
        JsError::Error("Host supervisor is not started".to_owned()).with_code("host_exited")
    })?;
    blocking(move || restart_shell_sync(&shell))
        .await
        .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?
}

pub(crate) fn current_state() -> Option<JsonValue> {
    active_shell()
        .and_then(|shell| shell.supervisor.last_state())
        .map(|state| serialize_host_state(&state))
}

pub(crate) fn current_power_error() -> Option<JsonValue> {
    active_shell()
        .and_then(|shell| shell.supervisor.last_power_error())
        .map(|err| serialize_power_error(&err))
}
