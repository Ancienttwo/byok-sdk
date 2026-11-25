//! Process-wide mutual exclusion lock across update, recovery, custody operations, and app quit draining.

use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Default maximum time [`MaintenanceLock::begin_quit`] waits for in-flight custody children
/// (`keys.submit` / `keys.list`) to exit before proceeding with app quit (`35s`).
///
/// Exceeds `DEFAULT_CUSTODY_DEADLINE` (`30s`) plus `list_from_custody`'s 2s force-kill reap
/// margin so every `keys.list` and every normal `keys.submit` finishes before quit returns,
/// while preventing a `keys.submit` child blocked indefinitely on an unanswered OS keychain
/// unlock prompt (`kill_on_timeout = false`) from wedging app quit forever.
pub const DEFAULT_CUSTODY_QUIT_WAIT: Duration = Duration::from_secs(35);

/// Bridge error code emitted when an operation is refused because [`MaintenanceLock`] is busy, handed over, or quitting.
pub const MAINTENANCE_BUSY_CODE: &str = "maintenance_busy";

/// Error raised when a second maintenance action attempts to enter while one is active or handed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceBusyError;

impl MaintenanceBusyError {
    /// Returns the existing bridge error code (`"maintenance_busy"`) for maintenance-lock refusals.
    pub const fn code(&self) -> &'static str {
        MAINTENANCE_BUSY_CODE
    }
}

impl fmt::Display for MaintenanceBusyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Another recovery action is running")
    }
}

impl std::error::Error for MaintenanceBusyError {}

/// Lifecycle stage of terminal maintenance handover (`none -> pending -> confirmed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoverState {
    None,
    Pending,
    Confirmed,
}

/// Outcome returned by [`MaintenanceLock::begin_quit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitOutcome {
    Quit,
    HandedOver,
}

type QuitListener = Box<dyn Fn() + Send + Sync>;

struct Inner {
    state: Mutex<LockState>,
    cv: Condvar,
}

struct LockState {
    busy: bool,
    active_custody: usize,
    handover: HandoverState,
    quitting: bool,
    listeners: Vec<QuitListener>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LaunchGateState {
    pub quitting: bool,
    pub busy: bool,
    pub handover: HandoverState,
}

/// Shared mutex coordinating `update`, `shell.restore`, `shell.startFresh`, `keys.submit`, `keys.list`, and app quit.
#[derive(Clone)]
pub struct MaintenanceLock {
    inner: Arc<Inner>,
}

impl Default for MaintenanceLock {
    fn default() -> Self {
        Self::new()
    }
}

impl MaintenanceLock {
    /// Creates an unlocked `MaintenanceLock`.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(LockState {
                    busy: false,
                    active_custody: 0,
                    handover: HandoverState::None,
                    quitting: false,
                    listeners: Vec::new(),
                }),
                cv: Condvar::new(),
            }),
        }
    }

    /// Enters an exclusive maintenance window, returning an RAII guard that releases or seals on drop.
    pub fn try_begin(&self) -> Result<MaintenanceGuard, MaintenanceBusyError> {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.busy
            || guard.active_custody > 0
            || guard.handover != HandoverState::None
            || guard.quitting
        {
            return Err(MaintenanceBusyError);
        }
        guard.busy = true;
        Ok(MaintenanceGuard {
            inner: Arc::clone(&self.inner),
            released: false,
        })
    }

    /// Atomically reserves custody write exclusion against S1 maintenance until child exit.
    pub fn try_begin_custody(&self) -> Result<CustodyGuard, MaintenanceBusyError> {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.busy || guard.handover != HandoverState::None || guard.quitting {
            return Err(MaintenanceBusyError);
        }
        guard.active_custody = guard.active_custody.saturating_add(1);
        Ok(CustodyGuard {
            inner: Arc::clone(&self.inner),
            released: false,
        })
    }

    /// Returns whether maintenance or custody write is currently active, handed over, or quitting.
    pub fn is_busy(&self) -> bool {
        let guard = self.inner.state.lock().expect("maintenance lock poisoned");
        guard.busy
            || guard.active_custody > 0
            || guard.handover != HandoverState::None
            || guard.quitting
    }

    /// Returns the number of active custody child guards currently held.
    pub fn active_custody_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("maintenance lock poisoned")
            .active_custody
    }

    /// Returns whether terminal handover (`Confirmed`) has permanently sealed the lock.
    pub fn is_handed_over(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("maintenance lock poisoned")
            .handover
            == HandoverState::Confirmed
    }

    /// Returns whether app quit has already been requested.
    pub fn is_quitting(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("maintenance lock poisoned")
            .quitting
    }

    /// Registers a listener fired on quit request (or immediately if quit already began).
    pub fn on_quit_requested<F>(&self, listener: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.quitting {
            drop(guard);
            listener();
            return;
        }
        guard.listeners.push(Box::new(listener));
    }

    /// Marks app quit requested and notifies registered quit listeners off-lock without waiting
    /// for in-flight maintenance or custody guards to drain. Safe to call repeatedly; subsequent
    /// [`Self::begin_quit`] calls still wait for active work and report the handover outcome.
    pub fn mark_quitting(&self) {
        let listeners = {
            let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
            if guard.quitting {
                Vec::new()
            } else {
                guard.quitting = true;
                std::mem::take(&mut guard.listeners)
            }
        };
        for listener in listeners {
            listener();
        }
    }

    /// Evaluates a Host launch decision while holding `MaintenanceLock`'s state mutex so a
    /// recorded quit, maintenance window, or handover cannot slip between the check and launch
    /// reservation. Callers must preserve canonical lock order (`MaintenanceLock` -> `HostSupervisor`).
    pub(crate) fn with_launch_state<F, R>(&self, f: F) -> R
    where
        F: FnOnce(LaunchGateState) -> R,
    {
        let guard = self.inner.state.lock().expect("maintenance lock poisoned");
        f(LaunchGateState {
            quitting: guard.quitting,
            busy: guard.busy,
            handover: guard.handover,
        })
    }

    /// Marks app quit requested, notifies listeners, waits unconditionally for any in-flight
    /// exclusive maintenance window, and waits up to [`DEFAULT_CUSTODY_QUIT_WAIT`] for active
    /// custody children (`keys.submit` / `keys.list`) to drop their guards before returning.
    pub fn begin_quit(&self) -> QuitOutcome {
        self.begin_quit_with_custody_wait(DEFAULT_CUSTODY_QUIT_WAIT)
    }

    /// Marks app quit requested, notifies listeners, waits unconditionally for any in-flight
    /// exclusive maintenance window, and waits up to `max_custody_wait` for active custody
    /// holders to finish before returning.
    pub fn begin_quit_with_custody_wait(&self, max_custody_wait: Duration) -> QuitOutcome {
        self.mark_quitting();
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        let mut custody_deadline: Option<Instant> = None;
        while guard.busy || guard.active_custody > 0 {
            if guard.busy {
                guard = self
                    .inner
                    .cv
                    .wait(guard)
                    .expect("maintenance lock poisoned");
                continue;
            }
            let deadline =
                *custody_deadline.get_or_insert_with(|| Instant::now() + max_custody_wait);
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            if remaining.is_zero() {
                break;
            }
            let (next, _) = self
                .inner
                .cv
                .wait_timeout(guard, remaining)
                .expect("maintenance lock poisoned");
            guard = next;
        }
        if guard.handover == HandoverState::Confirmed {
            QuitOutcome::HandedOver
        } else {
            QuitOutcome::Quit
        }
    }
}

/// Active maintenance guard controlling pending vs confirmed handover state before drop.
pub struct MaintenanceGuard {
    inner: Arc<Inner>,
    released: bool,
}

impl MaintenanceGuard {
    /// Marks external installer takeover as pending (blocks peers without releasing on drop unless confirmed).
    pub fn begin_pending(&self) {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.handover == HandoverState::None {
            guard.handover = HandoverState::Pending;
        }
    }

    /// Cancels a pending handover when the external installer did not take over.
    pub fn cancel_pending(&self) {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.handover == HandoverState::Pending {
            guard.handover = HandoverState::None;
        }
    }

    /// Permanently confirms terminal handover (`QuitOutcome::HandedOver`) and keeps lock sealed forever.
    pub fn confirm(&self) {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        guard.handover = HandoverState::Confirmed;
    }

    /// Atomically checks under `MaintenanceLock`'s state mutex that app quit has not been
    /// recorded, executes `on_allow` while holding that mutex (preserving `MaintenanceLock` ->
    /// `HostSupervisor` lock order), and releases `busy` in the same critical section.
    pub(crate) fn finish_if_not_quitting<F, R>(
        mut self,
        on_allow: F,
    ) -> Result<R, MaintenanceBusyError>
    where
        F: FnOnce() -> R,
    {
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        let result = if guard.quitting {
            Err(MaintenanceBusyError)
        } else {
            Ok(on_allow())
        };
        self.released = true;
        if guard.handover != HandoverState::Confirmed {
            guard.handover = HandoverState::None;
        }
        guard.busy = false;
        self.inner.cv.notify_all();
        result
    }

    fn release_inner(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        if guard.handover != HandoverState::Confirmed {
            guard.handover = HandoverState::None;
        }
        guard.busy = false;
        self.inner.cv.notify_all();
    }
}

impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// Active custody write exclusion guard held until the custody child process exits.
pub struct CustodyGuard {
    inner: Arc<Inner>,
    released: bool,
}

impl Drop for CustodyGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        guard.active_custody = guard.active_custody.saturating_sub(1);
        self.inner.cv.notify_all();
    }
}
