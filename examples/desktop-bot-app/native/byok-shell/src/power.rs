//! Three-OS system sleep inhibition aligned strictly with `docs/host-execution-core.md:286-317`.

use std::fmt;

/// Refusal returned when system sleep inhibition cannot be acquired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PowerError {
    InvalidArgument(&'static str),
    Unavailable {
        backend: &'static str,
        detail: String,
    },
}

impl fmt::Display for PowerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(msg) => write!(f, "invalid keep-awake argument: {msg}"),
            Self::Unavailable { backend, detail } => {
                write!(f, "system sleep inhibitor unavailable ({backend}): {detail}")
            }
        }
    }
}

impl std::error::Error for PowerError {}

/// Linux sleep-inhibitor backend selected from desktop environment variables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxInhibitBackend {
    /// GNOME desktops must use `org.gnome.SessionManager` (`Inhibit` flag 4 = suspend); logind `idle` alone is ignored by `gnome-settings-daemon`.
    GnomeSession,
    /// Other Linux desktops use `org.freedesktop.login1.Manager` `Inhibit("idle", ..., "block")`; `"sleep"` locks are forbidden.
    LogindIdle,
}

/// Selects the authoritative Linux inhibitor backend from `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION`.
pub fn select_linux_backend(
    xdg_current_desktop: Option<&str>,
    desktop_session: Option<&str>,
) -> LinuxInhibitBackend {
    let mentions_gnome = |raw: &str| {
        raw.split([':', ';', ',', ' '])
            .any(|token| token.trim().eq_ignore_ascii_case("gnome") || token.to_ascii_lowercase().contains("gnome"))
    };
    if xdg_current_desktop.is_some_and(mentions_gnome) || desktop_session.is_some_and(mentions_gnome) {
        LinuxInhibitBackend::GnomeSession
    } else {
        LinuxInhibitBackend::LogindIdle
    }
}

/// RAII system sleep inhibitor guard held only while `HostState::Running { active_work > 0 }`.
pub struct KeepAwake {
    #[cfg(target_os = "macos")]
    _inner: macos_impl::MacKeepAwake,
    #[cfg(target_os = "windows")]
    _inner: windows_impl::WinKeepAwake,
    #[cfg(target_os = "linux")]
    _inner: linux_impl::LinuxKeepAwake,
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    _unsupported: (),
}

impl KeepAwake {
    /// Acquires the platform's system-idle sleep assertion (`Drop` releases it cleanly).
    pub fn acquire(who: &str, reason: &str) -> Result<Self, PowerError> {
        if who.trim().is_empty() {
            return Err(PowerError::InvalidArgument("`who` must not be empty"));
        }
        if reason.trim().is_empty() {
            return Err(PowerError::InvalidArgument("`reason` must not be empty"));
        }

        #[cfg(target_os = "macos")]
        {
            let _ = who;
            return macos_impl::acquire(reason).map(|_inner| Self { _inner });
        }
        #[cfg(target_os = "windows")]
        {
            let _ = who;
            return windows_impl::acquire(reason).map(|_inner| Self { _inner });
        }
        #[cfg(target_os = "linux")]
        {
            return linux_impl::acquire(who, reason).map(|_inner| Self { _inner });
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (who, reason);
            Err(PowerError::Unavailable {
                backend: "unsupported-os",
                detail: "no sleep inhibitor implemented for this target OS".to_owned(),
            })
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use std::ffi::{CString, c_char, c_void};

    use super::PowerError;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            assertion_level: u32,
            assertion_name: *const c_void,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    pub struct MacKeepAwake {
        assertion_id: u32,
    }

    pub fn acquire(reason: &str) -> Result<MacKeepAwake, PowerError> {
        let c_type = CString::new("PreventUserIdleSystemSleep")
            .map_err(|_| PowerError::InvalidArgument("assertion type contains NUL"))?;
        let c_reason = CString::new(reason)
            .map_err(|_| PowerError::InvalidArgument("reason contains NUL"))?;

        let mut assertion_id: u32 = 0;
        // SAFETY: C strings are NUL-terminated UTF-8; both CFString objects are checked non-null and released after call.
        unsafe {
            let cf_type =
                CFStringCreateWithCString(std::ptr::null(), c_type.as_ptr(), K_CF_STRING_ENCODING_UTF8);
            if cf_type.is_null() {
                return Err(PowerError::Unavailable {
                    backend: "iokit",
                    detail: "CFStringCreateWithCString failed for assertion type".to_owned(),
                });
            }
            let cf_reason = CFStringCreateWithCString(
                std::ptr::null(),
                c_reason.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            );
            if cf_reason.is_null() {
                CFRelease(cf_type);
                return Err(PowerError::Unavailable {
                    backend: "iokit",
                    detail: "CFStringCreateWithCString failed for reason".to_owned(),
                });
            }
            let status = IOPMAssertionCreateWithName(
                cf_type,
                K_IOPM_ASSERTION_LEVEL_ON,
                cf_reason,
                &mut assertion_id,
            );
            CFRelease(cf_reason);
            CFRelease(cf_type);
            if status != 0 {
                return Err(PowerError::Unavailable {
                    backend: "iokit",
                    detail: format!("IOPMAssertionCreateWithName failed with IOReturn {status}"),
                });
            }
        }
        Ok(MacKeepAwake { assertion_id })
    }

    impl Drop for MacKeepAwake {
        fn drop(&mut self) {
            // SAFETY: assertion_id was created by IOPMAssertionCreateWithName and released once here.
            unsafe {
                let _ = IOPMAssertionRelease(self.assertion_id);
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    use super::PowerError;

    const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

    pub struct WinKeepAwake {
        handle: HANDLE,
    }

    // SAFETY: Win32 PowerRequest HANDLEs are kernel object handles valid across threads until CloseHandle.
    unsafe impl Send for WinKeepAwake {}

    pub fn acquire(reason: &str) -> Result<WinKeepAwake, PowerError> {
        let mut wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let ctx = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: wide.as_mut_ptr(),
            },
        };

        // SAFETY: `wide` stays valid for the duration of PowerCreateRequest.
        let handle = unsafe { PowerCreateRequest(&ctx) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(PowerError::Unavailable {
                backend: "win32-power-request",
                detail: format!(
                    "PowerCreateRequest failed: {}",
                    std::io::Error::last_os_error()
                ),
            });
        }

        // SAFETY: `handle` is a valid PowerCreateRequest handle; closed immediately on PowerSetRequest failure.
        let ok = unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(PowerError::Unavailable {
                backend: "win32-power-request",
                detail: format!("PowerSetRequest(PowerRequestSystemRequired) failed: {err}"),
            });
        }

        Ok(WinKeepAwake { handle })
    }

    impl Drop for WinKeepAwake {
        fn drop(&mut self) {
            // SAFETY: `self.handle` succeeded PowerSetRequest and has not been cleared/closed yet.
            unsafe {
                let _ = PowerClearRequest(self.handle, PowerRequestSystemRequired);
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::time::Duration;

    use rustbus::connection::Timeout;
    use rustbus::connection::ll_conn::force_finish_on_error;
    use rustbus::wire::UnixFd;
    use rustbus::{MessageBuilder, MessageType, RpcConn};

    use super::{LinuxInhibitBackend, PowerError, select_linux_backend};

    const DBUS_TIMEOUT: Timeout = Timeout::Duration(Duration::from_secs(5));
    const GNOME_INHIBIT_FLAG_SUSPEND: u32 = 4;

    pub enum LinuxKeepAwake {
        Gnome { conn: RpcConn, cookie: u32 },
        Logind { _fd: OwnedFd },
    }

    fn format_dbus_error(backend: &'static str, msg: &rustbus::message_builder::MarshalledMessage) -> PowerError {
        let name = msg
            .dynheader
            .error_name
            .as_deref()
            .unwrap_or("org.freedesktop.DBus.Error.Failed");
        let detail = msg
            .body
            .parser()
            .get::<String>()
            .map(|text| format!("{name}: {text}"))
            .unwrap_or_else(|_| name.to_owned());
        PowerError::Unavailable { backend, detail }
    }

    fn acquire_gnome(who: &str, reason: &str) -> Result<LinuxKeepAwake, PowerError> {
        let mut conn = RpcConn::session_conn(DBUS_TIMEOUT).map_err(|err| PowerError::Unavailable {
            backend: "gnome-session",
            detail: err.to_string(),
        })?;
        let mut call = MessageBuilder::new()
            .call("Inhibit")
            .with_interface("org.gnome.SessionManager")
            .on("/org/gnome/SessionManager")
            .at("org.gnome.SessionManager")
            .build();
        call.body
            .push_param4(who, 0u32, reason, GNOME_INHIBIT_FLAG_SUSPEND)
            .map_err(|err| PowerError::Unavailable {
                backend: "gnome-session",
                detail: err.to_string(),
            })?;
        let serial = conn
            .send_message(&mut call)
            .map_err(|err| PowerError::Unavailable {
                backend: "gnome-session",
                detail: err.to_string(),
            })?
            .write(DBUS_TIMEOUT)
            .map_err(force_finish_on_error)
            .map_err(|err| PowerError::Unavailable {
                backend: "gnome-session",
                detail: err.to_string(),
            })?;
        let reply = conn
            .wait_response(serial, DBUS_TIMEOUT)
            .map_err(|err| PowerError::Unavailable {
                backend: "gnome-session",
                detail: err.to_string(),
            })?;
        if reply.typ == MessageType::Error {
            return Err(format_dbus_error("gnome-session", &reply));
        }
        let cookie = reply
            .body
            .parser()
            .get::<u32>()
            .map_err(|err| PowerError::Unavailable {
                backend: "gnome-session",
                detail: format!("unexpected Inhibit reply: {err}"),
            })?;
        Ok(LinuxKeepAwake::Gnome { conn, cookie })
    }

    fn acquire_logind(who: &str, reason: &str) -> Result<LinuxKeepAwake, PowerError> {
        let mut conn = RpcConn::system_conn(DBUS_TIMEOUT).map_err(|err| PowerError::Unavailable {
            backend: "logind-idle",
            detail: err.to_string(),
        })?;
        let mut call = MessageBuilder::new()
            .call("Inhibit")
            .with_interface("org.freedesktop.login1.Manager")
            .on("/org/freedesktop/login1")
            .at("org.freedesktop.login1")
            .build();
        call.body
            .push_param4("idle", who, reason, "block")
            .map_err(|err| PowerError::Unavailable {
                backend: "logind-idle",
                detail: err.to_string(),
            })?;
        let serial = conn
            .send_message(&mut call)
            .map_err(|err| PowerError::Unavailable {
                backend: "logind-idle",
                detail: err.to_string(),
            })?
            .write(DBUS_TIMEOUT)
            .map_err(force_finish_on_error)
            .map_err(|err| PowerError::Unavailable {
                backend: "logind-idle",
                detail: err.to_string(),
            })?;
        let reply = conn
            .wait_response(serial, DBUS_TIMEOUT)
            .map_err(|err| PowerError::Unavailable {
                backend: "logind-idle",
                detail: err.to_string(),
            })?;
        if reply.typ == MessageType::Error {
            return Err(format_dbus_error("logind-idle", &reply));
        }
        let fd = reply
            .body
            .parser()
            .get::<UnixFd>()
            .map_err(|err| PowerError::Unavailable {
                backend: "logind-idle",
                detail: format!("unexpected Inhibit reply fd: {err}"),
            })?;
        let raw_fd = fd.take_raw_fd().ok_or_else(|| PowerError::Unavailable {
            backend: "logind-idle",
            detail: "Inhibit returned already-taken fd".to_owned(),
        })?;
        // SAFETY: `raw_fd` was just exclusively extracted from UnixFd via take_raw_fd().
        let owned = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        Ok(LinuxKeepAwake::Logind { _fd: owned })
    }

    pub fn acquire(who: &str, reason: &str) -> Result<LinuxKeepAwake, PowerError> {
        let xdg = std::env::var("XDG_CURRENT_DESKTOP").ok();
        let session = std::env::var("DESKTOP_SESSION").ok();
        match select_linux_backend(xdg.as_deref(), session.as_deref()) {
            LinuxInhibitBackend::GnomeSession => acquire_gnome(who, reason),
            LinuxInhibitBackend::LogindIdle => acquire_logind(who, reason),
        }
    }

    impl Drop for LinuxKeepAwake {
        fn drop(&mut self) {
            if let Self::Gnome { conn, cookie } = self {
                let mut call = MessageBuilder::new()
                    .call("Uninhibit")
                    .with_interface("org.gnome.SessionManager")
                    .on("/org/gnome/SessionManager")
                    .at("org.gnome.SessionManager")
                    .build();
                if call.body.push_param(*cookie).is_ok()
                    && let Ok(pending) = conn.send_message(&mut call)
                {
                    let _ = pending
                        .write(Timeout::Duration(Duration::from_millis(500)))
                        .map_err(force_finish_on_error);
                }
            }
        }
    }
}
