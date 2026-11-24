//! Process-wide mutual exclusion lock across update, recovery, custody submit, and app quit draining.

use std::fmt;
use std::sync::{Arc, Condvar, Mutex};

/// Error raised when a second maintenance action attempts to enter while one is active or handed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceBusyError;

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
    handover: HandoverState,
    quitting: bool,
    listeners: Vec<QuitListener>,
}

/// Shared mutex coordinating `update`, `shell.restore`, `shell.startFresh`, `keys.submit`, and app quit.
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
        if guard.busy || guard.handover != HandoverState::None || guard.quitting {
            return Err(MaintenanceBusyError);
        }
        guard.busy = true;
        Ok(MaintenanceGuard {
            inner: Arc::clone(&self.inner),
            released: false,
        })
    }

    /// Returns whether maintenance is currently active, handed over, or quitting (blocks new `keys.submit`).
    pub fn is_busy(&self) -> bool {
        let guard = self.inner.state.lock().expect("maintenance lock poisoned");
        guard.busy || guard.handover != HandoverState::None || guard.quitting
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

    /// Marks app quit requested, notifies listeners, and blocks until any in-flight maintenance finishes.
    pub fn begin_quit(&self) -> QuitOutcome {
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
        let mut guard = self.inner.state.lock().expect("maintenance lock poisoned");
        while guard.busy {
            guard = self.inner.cv.wait(guard).expect("maintenance lock poisoned");
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
