use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use nsh_core::runtime::UpdaterSink;

use super::*;

pub(super) struct TestDir(PathBuf);

impl TestDir {
    pub(super) fn new() -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "byok-updater-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

// RFC 8032 section 7.1 test vector, used only to sign synthetic manifests.
const TEST_SEED: &str = "nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=";
const TEST_PUBLIC: &str = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";

fn config() -> Config {
    Config::parse(
        &serde_json::to_vec(&json!({
            "id": APP_ID,
            "version": "1.0.0",
            "url": "https://example.test/latest.json",
            "publicKey": TEST_PUBLIC,
        }))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn manifest_requires_signature_id_and_no_package_field() {
    let config = config();
    let manifest = json!({
        "id": APP_ID,
        "version": "2.0.0",
        "platforms": { platform(): { "url": "app.zip", "sha256": "00".repeat(32), "size": 3 } },
    });
    let validated = |manifest: &JsonValue| {
        let bytes = serde_json::to_vec(manifest).unwrap();
        let signature = nsh_updater::sign(TEST_SEED, &bytes).unwrap();
        verify_manifest(&config, &bytes, signature.as_bytes())
    };
    assert_eq!(validated(&manifest).unwrap().unwrap().version, "2.0.0");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert_eq!(
        verify_manifest(&config, &bytes, b"").unwrap_err().code,
        "update_verify_failed"
    );

    let mut foreign = manifest.clone();
    foreign["id"] = json!("other.app");
    assert_eq!(
        validated(&foreign).unwrap_err().code,
        "update_verify_failed"
    );
    let mut package = manifest.clone();
    package["package"] = json!(null);
    assert_eq!(
        validated(&package).unwrap_err().code,
        "update_verify_failed"
    );
    let mut current = manifest;
    current["version"] = json!("1.0.0");
    assert!(validated(&current).unwrap().is_none());
}

#[test]
fn unresolved_pending_swap_refuses_check_without_touching_journal() {
    let dir = TestDir::new();
    let updates = dir.path().join("updates");
    fs::create_dir(&updates).unwrap();
    let pending = storage::pending_swap(&updates);
    // Even a torn write from an interrupted process is unresolved.
    fs::write(&pending, b"{").unwrap();
    let failure =
        check_sync(&mut UpdateState::Idle, None, Some(dir.path().to_owned())).unwrap_err();
    assert_eq!(failure.code, "update_install_corrupted");
    assert_eq!(fs::read(&pending).unwrap(), b"{");
}

#[test]
fn operation_gate_rejects_concurrent_work() {
    let state = Mutex::new(UpdateState::Idle);
    let operation = begin(&state).unwrap();
    std::thread::scope(|scope| {
        scope
            .spawn(|| assert_eq!(begin(&state).err().unwrap().code, "update_in_progress"))
            .join()
            .unwrap();
    });
    drop(operation);
    assert!(begin(&state).is_ok());
}

#[test]
fn child_process_cannot_take_install_or_partial_download_lock() {
    const CHILD_DIR: &str = "BYOK_TEST_UPDATER_LOCK_DIRECTORY";
    let hash = "0".repeat(64);
    if let Some(dir) = std::env::var_os(CHILD_DIR) {
        let dir = PathBuf::from(dir);
        let install = lock_install(&dir, &dir.join("app")).unwrap_err();
        let download = ArchiveCache::new(&dir, &hash).lock().unwrap_err();
        assert_eq!(install.code, "update_in_progress");
        assert_eq!(download.code, "update_in_progress");
        assert!(lock_install(&dir, &dir.join("other-app")).is_ok());
        return;
    }
    let dir = TestDir::new();
    let _install = lock_install(dir.path(), &dir.path().join("app")).unwrap();
    let _download = ArchiveCache::new(dir.path(), &hash).lock().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "updater::tests::child_process_cannot_take_install_or_partial_download_lock",
        ])
        .env(CHILD_DIR, dir.path())
        .output()
        .unwrap();
    let log = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && log.contains("1 passed"), "{log}");
}

struct Body<'a> {
    expected_offset: u64,
    response_offset: u64,
    bytes: &'a [u8],
}

impl UpdaterHost for Body<'static> {
    fn config(&self) -> Option<Vec<u8>> {
        None
    }

    fn get(&self, _: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
        assert_eq!(from, self.expected_offset);
        sink(
            self.response_offset,
            self.bytes,
            Some(self.response_offset + self.bytes.len() as u64),
        )
    }
}

#[test]
fn partial_download_streams_and_publishes_only_the_signed_size_and_hash() {
    let payload = b"BYOK updater";
    let hash = nsh_updater::sha256(payload);
    let size = payload.len() as u64;
    for (offset, bytes) in [(4, &payload[4..]), (0, payload.as_slice())] {
        let dir = TestDir::new();
        let part = dir.path().join(format!("download-{hash}.part"));
        fs::write(&part, &payload[..4]).unwrap();
        let cache = ArchiveCache::new(dir.path(), &hash);
        let _lock = cache.lock().unwrap();
        let host = Body {
            expected_offset: 4,
            response_offset: offset,
            bytes,
        };
        cache
            .download(&host, "https://example.test/app.zip", &hash, size)
            .unwrap();
        assert!(!part.exists());
        assert_eq!(fs::read(cache.archive).unwrap(), payload);
    }
    for bytes in [b"too short".as_slice(), b"some garbage"] {
        let dir = TestDir::new();
        let cache = ArchiveCache::new(dir.path(), &hash);
        let _lock = cache.lock().unwrap();
        let host = Body {
            expected_offset: 0,
            response_offset: 0,
            bytes,
        };
        assert_eq!(
            cache
                .download(&host, "https://example.test/app.zip", &hash, size)
                .unwrap_err()
                .code,
            "update_verify_failed"
        );
        assert!(!cache.archive.exists());
    }
}

#[test]
fn download_refuses_a_partial_file_link_to_another_file() {
    let dir = TestDir::new();
    let other = dir.path().join("existing-file");
    fs::write(&other, b"never rewrite").unwrap();
    let hash = nsh_updater::sha256(b"abc");
    let part = dir.path().join(format!("download-{hash}.part"));
    let cache = ArchiveCache::new(dir.path(), &hash);
    let _lock = cache.lock().unwrap();
    let host = Body {
        expected_offset: 0,
        response_offset: 0,
        bytes: b"abc",
    };
    fs::hard_link(&other, &part).unwrap();
    assert_eq!(
        cache
            .download(&host, "https://example.test/app.zip", &hash, 3)
            .unwrap_err()
            .code,
        "update_download_failed"
    );
    assert_eq!(fs::read(&other).unwrap(), b"never rewrite");
    #[cfg(unix)]
    {
        fs::remove_file(&part).unwrap();
        std::os::unix::fs::symlink(&other, &part).unwrap();
        assert_eq!(
            cache
                .download(&host, "https://example.test/app.zip", &hash, 3)
                .unwrap_err()
                .code,
            "update_download_failed"
        );
        assert_eq!(fs::read(&other).unwrap(), b"never rewrite");
    }
}

#[test]
fn stale_cache_cleanup_respects_download_lock_and_active_hash() {
    let dir = TestDir::new();
    let _install = lock_install(dir.path(), &dir.path().join("app")).unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(10 * 24 * 60 * 60);
    let caches: Vec<_> = ['a', 'b', 'c']
        .into_iter()
        .map(|c| {
            let hash = c.to_string().repeat(64);
            let cache = ArchiveCache::new(dir.path(), &hash);
            File::create(&cache.archive)
                .unwrap()
                .set_modified(old)
                .unwrap();
            (cache, hash)
        })
        .collect();
    let _busy = caches[0].0.lock().unwrap();
    cleanup_downloads(dir.path(), Some(&caches[1].1)).unwrap();
    assert!(caches[0].0.archive.exists());
    assert!(caches[1].0.archive.exists());
    assert!(!caches[2].0.archive.exists());
}

#[cfg(unix)]
#[test]
fn stale_install_cleanup_preserves_the_staged_directory_of_a_live_process() {
    let dir = TestDir::new();
    let root = dir.path().join("app");
    fs::create_dir(&root).unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(10 * 24 * 60 * 60);
    let live = dir
        .path()
        .join(format!("{}{}-app", storage::STAGED, std::process::id()));
    let dead = dir
        .path()
        .join(format!("{}{id}-app", storage::STAGED, id = i32::MAX));
    for path in [&live, &dead] {
        fs::create_dir(path).unwrap();
        File::open(path).unwrap().set_modified(old).unwrap();
    }
    let _install = lock_install(&dir.path().join("updates"), &root).unwrap();
    cleanup_install(&root).unwrap();
    assert!(live.exists());
    assert!(!dead.exists());
}
