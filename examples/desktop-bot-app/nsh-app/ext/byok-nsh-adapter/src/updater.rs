//! Rust-only orchestration of NSH whole-application updates (ADR-052 D5).

mod install;
mod storage;
#[cfg(test)]
mod tests;

use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

use byok_shell::update::{HandoverOutcome, UpdateFailure, handover};
use nsh_core::JsonValue;
use nsh_core::element::{JsError, System, blocking, desktop};
use nsh_core::restart::program_path;
use nsh_core::runtime::UpdaterHost;
use nsh_updater::{Available, Config, platform, verify};
use serde_json::json;

use crate::supervisor::{RuntimeShell, active_shell};
use install::{InstallLayout, NativeInstaller, eligible_install_root, install_root};
use nsh_updater::install::Installation;
use storage::{
    ArchiveCache, cleanup_downloads, cleanup_install, lock_install, refuse_pending_swap,
};

const APP_ID: &str = "io.byok-sdk.byok-desktop-bots";
const MANIFEST_MAX_BYTES: usize = 1024 * 1024;
const SIGNATURE_MAX_BYTES: usize = 1024;

struct CheckedUpdate {
    host: Arc<dyn UpdaterHost>,
    installation: Installation,
    layout: InstallLayout,
    updates: PathBuf,
    current: String,
    available: Available,
    hash: String,
    size: u64,
}

struct StagedUpdate {
    // Field order keeps the installation lock held through Staged::drop().
    installer: NativeInstaller,
    install_lock: File,
    cache: ArchiveCache,
    current: String,
    updates: PathBuf,
}

#[derive(Default)]
enum UpdateState {
    #[default]
    Idle,
    Checked(Box<CheckedUpdate>),
    Staged(Box<StagedUpdate>),
    HandedOver,
    Corrupted,
}

static UPDATE: Mutex<UpdateState> = Mutex::new(UpdateState::Idle);

fn begin(state: &Mutex<UpdateState>) -> Result<MutexGuard<'_, UpdateState>, UpdateFailure> {
    match state.try_lock() {
        Ok(guard) if matches!(*guard, UpdateState::HandedOver) => Err(in_progress()),
        Ok(guard) if matches!(*guard, UpdateState::Corrupted) => {
            Err(install_corrupted("The application directory needs repair"))
        }
        Ok(guard) => Ok(guard),
        Err(TryLockError::WouldBlock) => Err(in_progress()),
        Err(TryLockError::Poisoned(_)) => Err(check_failed("Updater state was interrupted".into())),
    }
}

fn in_progress() -> UpdateFailure {
    UpdateFailure::new(
        "update_in_progress",
        "An update operation is already in progress",
    )
}

fn check_failed(message: String) -> UpdateFailure {
    UpdateFailure::new("update_check_failed", message)
}

fn verify_failed(message: String) -> UpdateFailure {
    UpdateFailure::new("update_verify_failed", message)
}

fn download_failed(message: String) -> UpdateFailure {
    UpdateFailure::new("update_download_failed", message)
}

fn stage_failed(message: impl Into<String>) -> UpdateFailure {
    UpdateFailure::new("update_stage_failed", message)
}

fn install_corrupted(message: impl Into<String>) -> UpdateFailure {
    UpdateFailure::new("update_install_corrupted", message)
}

fn js_error(mut failure: UpdateFailure) -> JsError {
    if failure.code == "update_install_corrupted" {
        failure.message.push_str(". Reinstall the application to repair the installation. User data and snapshots are separate from the installation.");
    }
    let mut error = JsError::Error(failure.message)
        .with_code(failure.code)
        .with("hostRecovered", failure.host_recovered);
    if let Some(code) = failure.recovery_code {
        error = error.with("recoveryCode", code);
    }
    error
}

fn get_small(host: &dyn UpdaterHost, url: &str, limit: usize) -> Result<Vec<u8>, UpdateFailure> {
    if !url.starts_with("https://") {
        return Err(verify_failed(
            "Update feed and signature require HTTPS".into(),
        ));
    }
    let mut body = Vec::new();
    host.get(url, 0, &mut |at, bytes, _| {
        if at != body.len() as u64 || bytes.len() > limit - body.len() {
            return Err("Invalid update feed response".into());
        }
        body.extend_from_slice(bytes);
        Ok(())
    })
    .map_err(check_failed)?;
    Ok(body)
}

fn verify_manifest(
    config: &Config,
    manifest: &[u8],
    signature: &[u8],
) -> Result<Option<Available>, UpdateFailure> {
    let key = config
        .public_key
        .as_deref()
        .ok_or_else(|| verify_failed("Update public key is required".into()))?;
    verify(key, manifest, signature).map_err(|err| verify_failed(err.to_string()))?;
    // Inspect the signed JSON itself: NSH's Option<PackageAsset> also accepts
    // `package: null`, which is a forbidden field in a BYOK feed.
    let manifest_fields: JsonValue =
        serde_json::from_slice(manifest).map_err(|err| verify_failed(err.to_string()))?;
    if manifest_fields.get("id").and_then(JsonValue::as_str) != Some(APP_ID) {
        return Err(verify_failed(
            "Manifest app id does not match this application".into(),
        ));
    }
    if manifest_fields.get("package").is_some() {
        return Err(verify_failed("Package OTA updates are disabled".into()));
    }
    config
        .check(manifest, Some(signature), &platform())
        .map_err(|err| verify_failed(err.to_string()))
}

fn check_sync(
    state: &mut UpdateState,
    host: Option<Arc<dyn UpdaterHost>>,
    data_dir: Option<PathBuf>,
) -> Result<JsonValue, UpdateFailure> {
    if matches!(state, UpdateState::Staged(_)) {
        return Err(in_progress());
    }
    *state = UpdateState::Idle;
    let updates = data_dir.map(|dir| dir.join("updates"));
    let Some((host, bytes)) = host.and_then(|host| host.config().map(|bytes| (host, bytes))) else {
        if let Some(updates) = &updates {
            refuse_pending_swap(updates)?;
        }
        return Ok(JsonValue::Null);
    };
    let program = program_path()
        .and_then(|path| path.canonicalize())
        .map_err(|err| check_failed(err.to_string()))?;
    let root = install_root(&program);
    let _lock = match (root, updates.as_deref()) {
        (Some(root), Some(updates)) => Some(lock_install(updates, root)?),
        (None, Some(updates)) => {
            refuse_pending_swap(updates)?;
            None
        }
        (_, None) => None,
    };
    let config = Config::parse(&bytes).map_err(|err| verify_failed(err.to_string()))?;
    if config.id != APP_ID || !config.package_roots().is_empty() {
        return Err(verify_failed(
            "Invalid app id or package OTA roots in update configuration".into(),
        ));
    }
    let signature_url = config
        .signature_url()
        .ok_or_else(|| verify_failed("Update public key is required".into()))?;
    let eligible = root.zip(updates.as_deref()).and_then(|(root, updates)| {
        let updates = updates.canonicalize().ok()?;
        if updates.starts_with(root) || !eligible_install_root(root, &program) {
            return None;
        }
        let installation =
            Installation::of(&program, APP_ID, &bytes).filter(Installation::can_install)?;
        Some((root, updates, installation))
    });
    if let Some((root, _, _)) = &eligible {
        cleanup_install(root).map_err(|err| check_failed(err.to_string()))?;
    }
    let manifest = get_small(&*host, &config.manifest_url(), MANIFEST_MAX_BYTES)?;
    let signature = get_small(&*host, &signature_url, SIGNATURE_MAX_BYTES)?;
    let available = verify_manifest(&config, &manifest, &signature)?;
    let hash = available
        .as_ref()
        .and_then(|update| update.sha256.as_deref())
        .map(str::to_ascii_lowercase);
    if let Some((_, updates, _)) = &eligible {
        cleanup_downloads(updates, hash.as_deref()).map_err(|err| check_failed(err.to_string()))?;
    }
    let Some(available) = available else {
        return Ok(JsonValue::Null);
    };
    if !available.url.starts_with("https://") {
        return Err(verify_failed("Update archive URL requires HTTPS".into()));
    }
    let view = json!({
        "canInstall": eligible.is_some(),
        "version": available.version,
        "notes": available.notes,
        "releasePageUrl": null,
    });
    if let Some((root, updates, installation)) = eligible {
        let hash = hash
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| verify_failed("Update archive SHA-256 is missing or invalid".into()))?;
        let size = available
            .size
            .filter(|size| *size > 0)
            .ok_or_else(|| verify_failed("Update archive size is missing or invalid".into()))?;
        let layout =
            InstallLayout::new(root, &program).map_err(|err| check_failed(err.to_string()))?;
        *state = UpdateState::Checked(Box::new(CheckedUpdate {
            host,
            installation,
            layout,
            updates,
            current: config.version,
            available,
            hash,
            size,
        }));
    }
    Ok(view)
}

fn stage_sync(state: &mut UpdateState) -> Result<(), UpdateFailure> {
    let checked = match state {
        UpdateState::Checked(checked) => checked,
        UpdateState::Staged(_) => return Err(in_progress()),
        _ => return Err(stage_failed("Check for an installable update first")),
    };
    let lock = lock_install(&checked.updates, &checked.layout.root)?;
    let cache = ArchiveCache::new(&checked.updates, &checked.hash);
    let download_lock = cache.lock()?;
    cache.download(
        &*checked.host,
        &checked.available.url,
        &checked.hash,
        checked.size,
    )?;
    let UpdateState::Checked(checked) = std::mem::take(state) else {
        unreachable!()
    };
    let installer = checked
        .layout
        .stage(
            checked.installation,
            &cache.archive,
            &checked.updates,
            checked.current.clone(),
            checked.available.version,
        )
        .map_err(|err| stage_failed(err.to_string()))?;
    drop(download_lock);
    *state = UpdateState::Staged(Box::new(StagedUpdate {
        installer,
        install_lock: lock,
        cache,
        current: checked.current,
        updates: checked.updates,
    }));
    Ok(())
}

fn handover_sync(
    state: &mut UpdateState,
    shell: &RuntimeShell,
) -> Result<HandoverOutcome, UpdateFailure> {
    let UpdateState::Staged(staged) = state else {
        return Err(stage_failed("Download and stage an update first"));
    };
    refuse_pending_swap(&staged.updates)?;
    if shell.app_version != staged.current
        || !staged
            .installer
            .matches_host(&shell.supervisor.command_spec().program)
    {
        return Err(verify_failed(
            "Running Host does not match the staged update's old installation".into(),
        ));
    }
    let UpdateState::Staged(staged) = std::mem::take(state) else {
        unreachable!()
    };
    let StagedUpdate {
        installer,
        install_lock,
        cache,
        current,
        ..
    } = *staged;
    let result = handover(&shell.maintenance, &shell.supervisor, &current, installer);
    match &result {
        Ok(HandoverOutcome::Swapped { .. }) => {
            *state = UpdateState::HandedOver;
            cache.remove_consumed();
        }
        Err(err) if err.code == "update_install_corrupted" => *state = UpdateState::Corrupted,
        _ => (),
    }
    drop(install_lock);
    result
}

pub(crate) async fn check(sys: System) -> Result<JsonValue, JsError> {
    let System {
        updater, data_dir, ..
    } = sys;
    blocking(move || check_sync(&mut *begin(&UPDATE)?, updater, data_dir))
        .await
        .map_err(|err| js_error(check_failed(err.to_string())))?
        .map_err(js_error)
}

pub(crate) async fn stage() -> Result<(), JsError> {
    blocking(move || stage_sync(&mut *begin(&UPDATE)?))
        .await
        .map_err(|err| js_error(stage_failed(err.to_string())))?
        .map_err(js_error)
}

pub(crate) fn discard() -> Result<(), JsError> {
    *begin(&UPDATE).map_err(js_error)? = UpdateState::Idle;
    Ok(())
}

pub(crate) async fn install() -> Result<(), JsError> {
    let outcome = blocking(move || {
        let mut state = begin(&UPDATE)?;
        let shell = active_shell().ok_or_else(|| stage_failed("Host supervisor is not started"))?;
        handover_sync(&mut state, &shell)
    })
    .await
    .map_err(|err| js_error(stage_failed(err.to_string())))?
    .map_err(js_error)?;
    if matches!(outcome, HandoverOutcome::Swapped { .. }) {
        desktop::restart();
    }
    Ok(())
}

pub(crate) fn check_host_restart() -> Result<(), JsError> {
    if matches!(UPDATE.try_lock().as_deref(), Ok(UpdateState::Corrupted)) {
        return Err(js_error(install_corrupted(
            "The application directory needs repair",
        )));
    }
    Ok(())
}
