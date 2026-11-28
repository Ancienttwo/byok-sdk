use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use byok_shell::update::UpdateFailure;
use nsh_core::runtime::UpdaterHost;
use nsh_updater::{Download, sha256};

use super::{check_failed, download_failed, install_corrupted, verify_failed};

const CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub(super) const OLD: &str = ".nsh-updater-old-";
pub(super) const STAGED: &str = ".nsh-updater-staged-";

pub(super) fn pending_swap(updates: &Path) -> PathBuf {
    updates.join("pending-swap.json")
}

pub(super) fn refuse_pending_swap(updates: &Path) -> Result<(), UpdateFailure> {
    match fs::symlink_metadata(pending_swap(updates)) {
        Ok(_) => Err(install_corrupted(
            "An earlier update left an unresolved install journal",
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(check_failed(err.to_string())),
    }
}

pub(super) fn try_lock(path: &Path) -> Result<File, TryLockError> {
    // The file name stays reserved across operations. Unlinking a lock file could
    // let another process open and lock a different inode at the same path.
    let file = open_regular(
        path,
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    )
    .map_err(TryLockError::Error)?;
    file.try_lock()?;
    Ok(file)
}

pub(super) fn lock_install(updates: &Path, root: &Path) -> Result<File, UpdateFailure> {
    fs::create_dir_all(updates).map_err(|err| check_failed(err.to_string()))?;
    if !fs::symlink_metadata(updates)
        .map_err(|err| check_failed(err.to_string()))?
        .is_dir()
    {
        return Err(check_failed(
            "Updates path must be an application data directory".into(),
        ));
    }
    let hash = sha256(root.as_os_str().as_encoded_bytes());
    let lock = try_lock(&updates.join(format!("install-{hash}.lock")))
        .map_err(|err| lock_failure(err, check_failed))?;
    refuse_pending_swap(updates)?;
    Ok(lock)
}

fn lock_failure(err: TryLockError, failed: fn(String) -> UpdateFailure) -> UpdateFailure {
    match err {
        TryLockError::WouldBlock => super::in_progress(),
        TryLockError::Error(err) => failed(err.to_string()),
    }
}

fn open_regular(path: &Path, options: &mut OpenOptions) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || !has_one_link(&file)? {
        return Err(io::Error::other(
            "Updater cache entry must be a private regular file",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn has_one_link(file: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink() == 1)
}

#[cfg(windows)]
fn has_one_link(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: this open file owns the handle, and the API initializes info on success.
    unsafe {
        if GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info.assume_init().nNumberOfLinks == 1)
    }
}

pub(super) struct ArchiveCache {
    pub archive: PathBuf,
    part: PathBuf,
    lock: PathBuf,
}

impl ArchiveCache {
    pub fn new(updates: &Path, hash: &str) -> Self {
        let name = format!("download-{hash}");
        Self {
            archive: updates.join(&name),
            part: updates.join(format!("{name}.part")),
            lock: updates.join(format!("{name}.part.lock")),
        }
    }

    pub fn lock(&self) -> Result<File, UpdateFailure> {
        try_lock(&self.lock).map_err(|err| lock_failure(err, download_failed))
    }

    pub fn remove_consumed(&self) {
        if let Ok(_lock) = try_lock(&self.lock)
            && let Err(err) = fs::remove_file(&self.archive)
            && err.kind() != io::ErrorKind::NotFound
        {
            log::warn!("Could not remove the consumed update archive: {err}");
        }
    }

    pub fn download(
        &self,
        host: &dyn UpdaterHost,
        url: &str,
        sha256: &str,
        size: u64,
    ) -> Result<(), UpdateFailure> {
        let download_error = |err: io::Error| download_failed(err.to_string());
        match open_regular(&self.archive, OpenOptions::new().read(true)) {
            Ok(mut archive) => {
                if verify_prefix(&mut archive, sha256, size)
                    .is_ok_and(|(_, verified)| verified.finish().is_ok())
                {
                    return Ok(());
                }
                drop(archive);
                fs::remove_file(&self.archive).map_err(download_error)?;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => (),
            Err(err) => return Err(download_error(err)),
        }

        let mut file = open_regular(
            &self.part,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false),
        )
        .map_err(download_error)?;
        if file.metadata().map_err(download_error)?.len() > size {
            file.set_len(0).map_err(download_error)?;
        }
        let (mut at, mut verifier) =
            verify_prefix(&mut file, sha256, size).map_err(download_error)?;
        if at < size {
            let mut verification_error = None;
            let transport = host.get(url, at, &mut |offset, bytes, total| {
                if offset == 0 && at > 0 {
                    file.set_len(0).map_err(|err| err.to_string())?;
                    file.rewind().map_err(|err| err.to_string())?;
                    verifier = Download::new(sha256, Some(size));
                    at = 0;
                }
                if offset != at {
                    return Err("Update response offset is not contiguous".into());
                }
                if total.is_some_and(|total| total != size) {
                    let message =
                        "Update response size differs from the signed manifest".to_owned();
                    verification_error = Some(message.clone());
                    return Err(message);
                }
                at = verifier.update(bytes).map_err(|err| {
                    let message = err.to_string();
                    verification_error = Some(message.clone());
                    message
                })?;
                file.write_all(bytes).map_err(|err| err.to_string())
            });
            if let Some(error) = verification_error {
                return Err(verify_failed(error));
            }
            transport.map_err(download_failed)?;
        }
        if let Err(err) = verifier.finish() {
            if at == size {
                file.set_len(0).map_err(download_error)?;
            }
            return Err(verify_failed(err.to_string()));
        }
        file.sync_all().map_err(download_error)?;
        drop(file);
        fs::rename(&self.part, &self.archive).map_err(download_error)
    }
}

fn verify_prefix(file: &mut File, hash: &str, size: u64) -> io::Result<(u64, Download)> {
    let mut verifier = Download::new(hash, Some(size));
    let mut bytes = [0; 64 * 1024];
    let mut at = 0;
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            return Ok((at, verifier));
        }
        at = verifier.update(&bytes[..count]).map_err(io::Error::other)?;
    }
}

fn expired(meta: &fs::Metadata) -> bool {
    meta.modified()
        .and_then(|modified| modified.elapsed().map_err(io::Error::other))
        .is_ok_and(|age| age >= CACHE_MAX_AGE)
}

fn reserved_pid<'a>(name: &'a str, prefix: &str) -> Option<(u32, &'a str)> {
    let (pid, suffix) = name.strip_prefix(prefix)?.split_once('-')?;
    Some((pid.parse().ok()?, suffix))
}

pub(super) fn cleanup_install(root: &Path) -> io::Result<()> {
    let Some(root_name) = root.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let parent = root.parent().expect("installation root has a parent");
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let stale_stage = reserved_pid(name, STAGED)
            .is_some_and(|(pid, suffix)| suffix == root_name && process_is_gone(pid));
        let stale_backup = !cfg!(windows)
            && reserved_pid(name, OLD)
                .is_some_and(|(pid, suffix)| suffix == root_name && process_is_gone(pid));
        if !stale_stage && !stale_backup {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_dir() && (stale_backup || expired(&meta)) {
            fs::remove_dir_all(entry.path())?;
        }
    }
    #[cfg(windows)]
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if name
            .to_str()
            .and_then(|name| reserved_pid(name, OLD))
            .is_some_and(|(pid, _)| process_is_gone(pid))
        {
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else if meta.is_file() {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

pub(super) fn cleanup_downloads(updates: &Path, active_hash: Option<&str>) -> io::Result<()> {
    for entry in fs::read_dir(updates)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(rest) = name
            .to_str()
            .and_then(|name| name.strip_prefix("download-"))
        else {
            continue;
        };
        let hash = rest.strip_suffix(".part").unwrap_or(rest);
        if Some(hash) == active_hash
            || hash.len() != 64
            || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        {
            continue;
        }
        let cache = ArchiveCache::new(updates, hash);
        let Ok(_lock) = try_lock(&cache.lock) else {
            continue;
        };
        match fs::symlink_metadata(entry.path()) {
            Ok(meta) if meta.is_file() && expired(&meta) => fs::remove_file(entry.path())?,
            Ok(_) => (),
            Err(err) if err.kind() == io::ErrorKind::NotFound => (),
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_is_gone(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks whether this positive PID exists.
    pid > 0
        && unsafe { libc::kill(pid, 0) } == -1
        && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_is_gone(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    // SAFETY: the handle is queried with a zero wait and closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return pid != 0
                && io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_INVALID_PARAMETER as i32);
        }
        let exited = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
        CloseHandle(process);
        exited
    }
}
