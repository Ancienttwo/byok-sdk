//! Desktop quit coordination: `on_quit_request` + 10s graceful Host shutdown + `MaintenanceLock` wait.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;

use byok_shell::{HostSupervisor, MaintenanceLock, QuitOutcome};
#[cfg(target_os = "macos")]
use nsh_core::desktop::QuitRequestOptions;
use nsh_core::desktop::QuitMode;
use nsh_core::element::desktop::{on_app_quit, on_quit_request, quit, set_quit_mode};
#[cfg(target_os = "macos")]
use nsh_core::element::desktop::set_quit_request_options;
use nsh_core::element::{Local, blocking, create_root, spawn};
use nsh_core::prelude::*;

use crate::supervisor::{RuntimeShell, ShellEvent, active_shell, event_hub};

/// Waits for active `MaintenanceLock` work, then stops `supervisor` with its 10s shutdown grace unless handed over.
pub(crate) fn drain_for_quit(
    maintenance: &MaintenanceLock,
    supervisor: &HostSupervisor,
) -> QuitOutcome {
    let outcome = maintenance.begin_quit();
    if outcome == QuitOutcome::HandedOver {
        return outcome;
    }
    if let Err(err) = supervisor.stop() {
        log::warn!("Host supervisor unclean stop during app quit: {err}");
    }
    outcome
}

fn drain_active_shell(shell: &RuntimeShell) {
    drain_for_quit(&shell.maintenance, &shell.supervisor);
}

/// Runs the graceful quit sequence on the engine thread (`MaintenanceLock` + `HostSupervisor::stop`), then calls `desktop::quit()`.
pub(crate) fn begin_graceful_quit(quitting: &AtomicBool) {
    if quitting.swap(true, Ordering::AcqRel) {
        return;
    }
    event_hub().publish(ShellEvent::Quitting);
    let Some(shell) = active_shell() else {
        quit();
        return;
    };
    spawn(async move {
        let _ = blocking(move || drain_active_shell(&shell)).await;
        quit();
    });
}

async fn fallback_app_quit_cleanup(quitting: Arc<AtomicBool>) {
    if quitting.swap(true, Ordering::AcqRel) {
        return;
    }
    event_hub().publish(ShellEvent::Quitting);
    if let Some(shell) = active_shell() {
        let _ = blocking(move || drain_active_shell(&shell)).await;
    }
}

/// Per-VM quit-hook ownership stored in `sys.locals` so `on_quit_request` and its re-entrancy guard stay isolated per VM.
/// Dropping `stop_tx` signals the `Core`-owned task to dispose its `Owner` inside an entered reactive runtime.
#[derive(Default)]
pub(crate) struct QuitHooksState {
    stop_tx: RefCell<Option<Sender<()>>>,
    generation: Cell<u64>,
    quitting: Arc<AtomicBool>,
}

impl QuitHooksState {
    fn stop_current(&self) {
        let _ = self.stop_tx.borrow_mut().take();
    }
}

impl Local for QuitHooksState {
    fn close(&self) {
        self.stop_current();
    }
}

/// Installs desktop quit hooks inside a detached reactive `Owner` kept alive on a `Core` task.
pub(crate) fn install_quit_hooks(sys: &System, cx: CallCx<'_>) -> Stop {
    let state = sys.locals.get::<QuitHooksState>();
    let generation = state.generation.get().wrapping_add(1);
    state.generation.set(generation);
    state.stop_current();

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    *state.stop_tx.borrow_mut() = Some(stop_tx);

    let weak = Rc::downgrade(&state);
    cx.start(async move {
        let owner = {
            let Some(state) = weak.upgrade() else {
                return;
            };
            if state.generation.get() != generation {
                return;
            }
            let quitting_for_request = Arc::clone(&state.quitting);
            let quitting_for_app_quit = Arc::clone(&state.quitting);
            let (owner, ()) = create_root(|| {
                set_quit_mode(QuitMode::Explicit);
                #[cfg(target_os = "macos")]
                set_quit_request_options(QuitRequestOptions::default().system(true));
                on_quit_request(move || begin_graceful_quit(&quitting_for_request));
                on_app_quit(move || {
                    fallback_app_quit_cleanup(Arc::clone(&quitting_for_app_quit))
                });
            });
            owner
        };
        let _ = blocking(move || {
            let _ = stop_rx.recv();
        })
        .await;
        owner.dispose();
    });

    let stop_weak = Rc::downgrade(&state);
    Stop::new(move || {
        if let Some(state) = stop_weak.upgrade()
            && state.generation.get() == generation
        {
            state.stop_current();
        }
    })
}

pub(crate) fn request_quit(sys: &System, cx: CallCx<'_>) {
    let quitting = Arc::clone(&sys.locals.get::<QuitHooksState>().quitting);
    cx.start(async move {
        begin_graceful_quit(&quitting);
    });
}
