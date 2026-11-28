use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use byok_shell::update::{SwapOutcome, UpdateInstaller};
use flate2::read::GzDecoder;
use nsh_core::restart::{program_path, remember_program};
use nsh_updater::install::{Installation, Staged};
use serde::Serialize;
use serde_json::Value;

use super::APP_ID;
use super::storage::{OLD, STAGED, pending_swap};

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;

pub(super) fn install_root(program: &Path) -> Option<&Path> {
    let parent = program.parent()?;
    if cfg!(target_os = "macos") {
        let root = parent.parent()?.parent()?;
        (root.extension()? == "app").then_some(root)
    } else {
        parent.file_name()?;
        Some(parent)
    }
}

pub(super) struct InstallLayout {
    pub root: PathBuf,
    pub program: PathBuf,
    host: PathBuf,
}

impl InstallLayout {
    pub fn new(root: &Path, program: &Path) -> io::Result<Self> {
        let executable = program
            .strip_prefix(root)
            .map_err(io::Error::other)?
            .to_owned();
        let exe_dir = program.parent().expect("program has parent");
        let host = super::super::supervisor::packaged_host_candidates(exe_dir)
            .into_iter()
            .find(|host| host.is_file())
            .ok_or_else(|| io::Error::other("Packaged Host executable is missing"))?;
        let host = host
            .strip_prefix(root)
            .map_err(io::Error::other)?
            .to_owned();
        Ok(Self {
            root: root.to_owned(),
            program: executable,
            host,
        })
    }

    pub fn verify_archive(&self, archive: &Path) -> io::Result<()> {
        let mut file = File::open(archive)?;
        let mut magic = [0; 2];
        file.read_exact(&mut magic)?;
        file.rewind()?;
        let mut layout = ArchiveLayout {
            name: self.root.file_name().expect("installation root has a name"),
            main: &self.program,
            host: &self.host,
            main_present: false,
            host_present: false,
        };
        match &magic {
            b"PK" => {
                let mut zip = zip::ZipArchive::new(file).map_err(io::Error::other)?;
                for index in 0..zip.len() {
                    let entry = zip.by_index(index).map_err(io::Error::other)?;
                    let path = entry
                        .enclosed_name()
                        .ok_or_else(|| io::Error::other("Invalid ZIP path"))?;
                    layout.entry(
                        &path,
                        entry.is_file() && !entry.is_symlink(),
                        entry.is_dir(),
                    )?;
                }
            }
            [0x1f, 0x8b] => layout.read_tar(GzDecoder::new(file))?,
            _ => layout.read_tar(file)?,
        }
        if !layout.main_present || !layout.host_present {
            return Err(io::Error::other(
                "Archive must contain the existing executable and packaged Host paths",
            ));
        }
        Ok(())
    }

    fn old_install_digest(&self, version: &str) -> io::Result<String> {
        self.verify_programs(&self.root)?;
        let app_json = if cfg!(target_os = "macos") {
            self.root.join("Contents/Resources/nsh/app.json")
        } else {
            self.root.join("nsh/app.json")
        };
        let app: Value =
            serde_json::from_reader(File::open(app_json)?).map_err(io::Error::other)?;
        if app.get("id").and_then(Value::as_str) != Some(APP_ID)
            || app.get("version").and_then(Value::as_str) != Some(version)
        {
            return Err(io::Error::other(
                "The running id and version do not match the old installation",
            ));
        }
        if cfg!(target_os = "macos")
            && !std::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&self.root)
                .status()?
                .success()
        {
            return Err(io::Error::other(
                "The old bundle did not pass strict code signature verification",
            ));
        }
        nsh_updater::delta::tree(&self.root, io::sink()).map_err(io::Error::other)
    }

    fn verify_programs(&self, root: &Path) -> io::Result<()> {
        let root = root.canonicalize()?;
        for relative in [&self.program, &self.host] {
            let program = root.join(relative).canonicalize()?;
            if !program.starts_with(&root) || !is_executable(&program)? {
                return Err(io::Error::other(format!(
                    "Invalid executable {}",
                    relative.display()
                )));
            }
        }
        Ok(())
    }

    pub fn stage(
        self,
        installation: Installation,
        archive: &Path,
        updates: &Path,
        current: String,
        target: String,
    ) -> io::Result<NativeInstaller> {
        self.verify_archive(archive)?;
        let old_digest = self.old_install_digest(&current)?;
        let name = self.root.file_name().expect("installation root has a name");
        let mut scratch_name = std::ffi::OsString::from(format!("{STAGED}{}-", std::process::id()));
        scratch_name.push(name);
        let scratch = self.root.with_file_name(scratch_name);
        match fs::symlink_metadata(&scratch) {
            // Pinned stage() deletes this exact name unconditionally. Keep an
            // unproven leftover intact instead of letting upstream remove it.
            Ok(_) => {
                return Err(io::Error::other(
                    "This process's staging path already exists",
                ));
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => (),
            Err(err) => return Err(err),
        }
        let staged = installation.stage(archive).map_err(io::Error::other)?;
        self.verify_programs(&scratch.join(name))?;
        Ok(NativeInstaller {
            staged,
            layout: self,
            old_digest,
            updates: updates.to_owned(),
            current,
            target,
        })
    }
}

fn is_executable(path: &Path) -> io::Result<bool> {
    let meta = fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(windows)]
    {
        Ok(meta.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")))
    }
}

struct ArchiveLayout<'a> {
    name: &'a std::ffi::OsStr,
    main: &'a Path,
    host: &'a Path,
    main_present: bool,
    host_present: bool,
}

impl ArchiveLayout<'_> {
    fn read_tar(&mut self, reader: impl Read) -> io::Result<()> {
        let mut tar = tar::Archive::new(reader);
        for entry in tar.entries()? {
            let entry = entry?;
            let path = entry.path()?;
            // NSH's tar extractor excludes AppleDouble entries.
            if path
                .file_name()
                .is_some_and(|name| name.as_encoded_bytes().starts_with(b"._"))
            {
                continue;
            }
            let kind = entry.header().entry_type();
            self.entry(&path, kind.is_file(), kind.is_dir())?;
        }
        Ok(())
    }

    fn entry(&mut self, path: &Path, file: bool, dir: bool) -> io::Result<()> {
        let mut components = path.components();
        if components.clone().next() == Some(Component::CurDir) {
            components.next();
        }
        if components.next() != Some(Component::Normal(self.name)) {
            return Err(io::Error::other(
                "Archive must have exactly one directory matching the installation name",
            ));
        }
        let relative = components.as_path();
        if (relative.as_os_str().is_empty() && !dir)
            || components.any(|component| match component {
                Component::Normal(name) => name.as_encoded_bytes().starts_with(b".nsh-updater-"),
                _ => true,
            })
        {
            return Err(io::Error::other("Archive contains an invalid app path"));
        }
        for (expected, seen) in [
            (self.main, &mut self.main_present),
            (self.host, &mut self.host_present),
        ] {
            if relative == expected {
                if *seen || !file {
                    return Err(io::Error::other(
                        "The archive must have one regular file per executable path",
                    ));
                }
                *seen = true;
            }
        }
        Ok(())
    }
}

pub(super) struct NativeInstaller {
    staged: Staged,
    layout: InstallLayout,
    old_digest: String,
    updates: PathBuf,
    current: String,
    target: String,
}

impl NativeInstaller {
    pub fn matches_host(&self, program: &Path) -> bool {
        program.canonicalize().is_ok_and(|actual| {
            self.layout
                .root
                .join(&self.layout.host)
                .canonicalize()
                .is_ok_and(|expected| actual == expected)
        })
    }
}

impl UpdateInstaller for NativeInstaller {
    fn swap(self) -> SwapOutcome {
        remember_program();
        let Self {
            staged,
            layout,
            old_digest,
            updates,
            current,
            target,
        } = self;
        let expected = program_path().and_then(|program| program.canonicalize());
        let swap = InstallSwap {
            layout,
            old_digest,
            updates,
            current,
            target,
        };
        swap.finish(expected, || staged.finish().map_err(io::Error::other))
    }
}

struct InstallSwap {
    layout: InstallLayout,
    old_digest: String,
    updates: PathBuf,
    current: String,
    target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSwap<'a> {
    root: &'a Path,
    backups: Vec<PathBuf>,
    current_version: &'a str,
    target_version: &'a str,
    error: Option<&'a str>,
}

impl InstallSwap {
    fn verify_old(&self) -> io::Result<()> {
        let actual = self.layout.old_install_digest(&self.current)?;
        if actual != self.old_digest {
            return Err(io::Error::other(
                "Old installation files differ from the pre-swap inventory",
            ));
        }
        Ok(())
    }

    fn finish(
        &self,
        expected: io::Result<PathBuf>,
        finish: impl FnOnce() -> io::Result<PathBuf>,
    ) -> SwapOutcome {
        let prepared = (|| {
            let expected = expected?;
            if expected != self.layout.root.join(&self.layout.program).canonicalize()? {
                return Err(io::Error::other("Restart program changed since staging"));
            }
            let backups = self.backups()?;
            for backup in &backups {
                match fs::symlink_metadata(backup) {
                    Ok(_) => {
                        return Err(io::Error::other(format!(
                            "Backup path already exists: {}",
                            backup.display()
                        )));
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => (),
                    Err(err) => return Err(err),
                }
            }
            let journal = PendingSwap {
                root: &self.layout.root,
                backups,
                current_version: &self.current,
                target_version: &self.target,
                error: None,
            };
            self.write_journal(&pending_swap(&self.updates), &journal)?;
            Ok((expected, journal))
        })();
        let (expected, mut journal) = match prepared {
            Ok(prepared) => prepared,
            Err(err) => {
                return match self.verify_old() {
                    Ok(()) => SwapOutcome::RolledBackVerified(err.to_string()),
                    Err(verify) => SwapOutcome::InstallCorrupted(format!(
                        "{err}; old installation verification failed: {verify}"
                    )),
                };
            }
        };

        let error = match finish() {
            Ok(executable) => {
                let verified = executable.canonicalize().and_then(|actual| {
                    if actual != expected {
                        return Err(io::Error::other(
                            "Installed executable differs from the restart program",
                        ));
                    }
                    self.layout.verify_programs(&self.layout.root)?;
                    self.clear_journal()?;
                    Ok(actual)
                });
                match verified {
                    Ok(executable) => return SwapOutcome::Swapped { executable },
                    Err(err) => err.to_string(),
                }
            }
            Err(err) => {
                let verified = self.verify_old().and_then(|()| {
                    for backup in &journal.backups {
                        match fs::symlink_metadata(backup) {
                            Err(err) if err.kind() == io::ErrorKind::NotFound => (),
                            Err(err) => return Err(err),
                            Ok(_) => {
                                return Err(io::Error::other("Unrestored updater backup remains"));
                            }
                        }
                    }
                    self.clear_journal()
                });
                match verified {
                    Ok(()) => return SwapOutcome::RolledBackVerified(err.to_string()),
                    Err(verify) => format!("{err}; old installation verification failed: {verify}"),
                }
            }
        };
        journal.error = Some(&error);
        let temp = self
            .updates
            .join(format!("pending-swap-{}.tmp", std::process::id()));
        if let Err(err) = self
            .write_journal(&temp, &journal)
            .and_then(|()| fs::rename(&temp, pending_swap(&self.updates)))
            .and_then(|()| sync_directory(&self.updates))
        {
            log::error!("Could not persist the swap failure in the install journal: {err}");
        }
        SwapOutcome::InstallCorrupted(error)
    }

    fn backups(&self) -> io::Result<Vec<PathBuf>> {
        if cfg!(windows) {
            fs::read_dir(&self.layout.root)?
                .filter_map(|entry| match entry {
                    Ok(entry) if entry.file_name().to_string_lossy().contains(OLD) => None,
                    Ok(entry) => Some(Ok(entry
                        .path()
                        .with_file_name(backup_name(&entry.file_name())))),
                    Err(err) => Some(Err(err)),
                })
                .collect()
        } else {
            let name = self
                .layout
                .root
                .file_name()
                .expect("installation root has a name");
            Ok(vec![self.layout.root.with_file_name(backup_name(name))])
        }
    }

    fn write_journal(&self, path: &Path, journal: &PendingSwap<'_>) -> io::Result<()> {
        let json = serde_json::to_vec(journal).map_err(io::Error::other)?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(&json)?;
        file.sync_all()?;
        sync_directory(&self.updates)
    }

    fn clear_journal(&self) -> io::Result<()> {
        fs::remove_file(pending_swap(&self.updates))?;
        if let Err(err) = sync_directory(&self.updates) {
            log::warn!("Could not sync removal of the completed swap journal: {err}");
        }
        Ok(())
    }
}

fn backup_name(name: &std::ffi::OsStr) -> std::ffi::OsString {
    let mut backup = std::ffi::OsString::from(format!("{OLD}{}-", std::process::id()));
    backup.push(name);
    backup
}

#[cfg(unix)]
fn sync_directory(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_dir: &Path) -> io::Result<()> {
    // Windows cannot FlushFileBuffers on a directory handle. The journal's
    // own FlushFileBuffers is completed before the directory swap begins.
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn eligible_install_root(root: &Path, _program: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    if root
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return false;
    }
    let Ok(path) = std::ffi::CString::new(root.as_os_str().as_bytes()) else {
        return false;
    };
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: statfs fills the buffer on success, and path is NUL-terminated.
    unsafe {
        libc::statfs(path.as_ptr(), info.as_mut_ptr()) == 0
            && info.assume_init().f_flags & libc::MNT_RDONLY as u32 == 0
    }
}

#[cfg(windows)]
pub(super) fn eligible_install_root(root: &Path, _program: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
    };

    std::env::var_os("LOCALAPPDATA")
        .and_then(|path| PathBuf::from(path).canonicalize().ok())
        .is_some_and(|local| root != local && root.starts_with(local))
        && OpenOptions::new()
            .access_mode(FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(root)
            .is_ok()
}

#[cfg(target_os = "linux")]
pub(super) fn eligible_install_root(root: &Path, program: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    if std::env::var_os("APPIMAGE").is_some()
        || std::env::var_os("APPDIR").is_some()
        || root.starts_with("/usr")
        || root.starts_with("/opt")
    {
        return false;
    }
    let Ok(path) = std::ffi::CString::new(root.as_os_str().as_bytes()) else {
        return false;
    };
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: statfs fills the buffer on success, and path is NUL-terminated.
    let local_directory = unsafe {
        libc::statfs(path.as_ptr(), info.as_mut_ptr()) == 0
            && info.assume_init().f_type != libc::FUSE_SUPER_MAGIC
            && libc::access(path.as_ptr(), libc::W_OK) == 0
    };
    local_directory
        && match std::process::Command::new("/usr/bin/dpkg-query")
            .args(["--search", "--"])
            .arg(program)
            .output()
        {
            Ok(result) => result.status.code() == Some(1),
            Err(err) => err.kind() == io::ErrorKind::NotFound,
        }
}
