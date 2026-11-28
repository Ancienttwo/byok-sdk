use super::super::tests::TestDir;
use super::*;

const OLD_VERSION: &str = "1.0.0";

fn fixture(dir: &Path) -> InstallLayout {
    let (name, program, host, app) = if cfg!(target_os = "macos") {
        (
            "BYOK.app",
            "Contents/MacOS/byok",
            "Contents/Resources/host/host",
            "Contents/Resources/nsh/app.json",
        )
    } else if cfg!(windows) {
        (
            "BYOK",
            "byok.exe",
            "resources/host/host.exe",
            "nsh/app.json",
        )
    } else {
        ("BYOK", "byok", "resources/host/host", "nsh/app.json")
    };
    let root = dir.join(name);
    let layout = InstallLayout {
        root: root.clone(),
        program: program.into(),
        host: host.into(),
    };
    for path in [&layout.program, &layout.host] {
        let executable = root.join(path);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        if cfg!(target_os = "macos") {
            fs::copy("/usr/bin/true", &executable).unwrap();
        } else {
            fs::write(&executable, b"mock executable").unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let manifest = root.join(app);
    fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    fs::write(
        manifest,
        serde_json::json!({ "id": APP_ID, "version": OLD_VERSION }).to_string(),
    )
    .unwrap();
    if cfg!(target_os = "macos") {
        fs::write(
            root.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{APP_ID}</string>
<key>CFBundleExecutable</key><string>byok</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#
            ),
        )
        .unwrap();
        let out = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    layout
}

#[test]
fn archive_layout_requires_one_matching_top_directory_with_exact_program_and_host_paths() {
    let dir = TestDir::new();
    let layout = fixture(dir.path());
    let archive = dir.path().join("app.tar");
    let root_name = layout.root.file_name().unwrap();
    for defect in [
        None,
        Some("root"),
        Some("program"),
        Some("host"),
        Some("extra"),
    ] {
        let root = if defect == Some("root") {
            Path::new("Renamed")
        } else {
            Path::new(root_name)
        };
        let mut builder = tar::Builder::new(File::create(&archive).unwrap());
        let main = if defect == Some("program") {
            Path::new("different-binary")
        } else {
            &layout.program
        };
        builder
            .append_path_with_name(layout.root.join(&layout.program), root.join(main))
            .unwrap();
        if defect != Some("host") {
            builder
                .append_path_with_name(layout.root.join(&layout.host), root.join(&layout.host))
                .unwrap();
        }
        if defect == Some("extra") {
            builder
                .append_path_with_name(layout.root.join(&layout.program), "other/exe")
                .unwrap();
        }
        builder.finish().unwrap();
        assert_eq!(
            layout.verify_archive(&archive).is_ok(),
            defect.is_none(),
            "{defect:?}"
        );
    }
}

#[test]
fn staged_handle_prevents_new_checks_and_staging_until_discarded() {
    use super::super::{StagedUpdate, UpdateState, check_sync, stage_sync, storage::ArchiveCache};

    let dir = TestDir::new();
    let layout = fixture(dir.path());
    let updates = dir.path().join("updates");
    let install_lock = super::super::storage::lock_install(&updates, &layout.root).unwrap();
    let cache = ArchiveCache::new(&updates, &"0".repeat(64));
    let mut archive = tar::Builder::new(File::create(&cache.archive).unwrap());
    archive
        .append_dir_all(layout.root.file_name().unwrap(), &layout.root)
        .unwrap();
    drop(archive.into_inner().unwrap());
    let installation =
        Installation::directory(&layout.root, &layout.root.join(&layout.program)).unwrap();
    let root = layout.root.clone();
    let installer = layout
        .stage(
            installation,
            &cache.archive,
            &updates,
            OLD_VERSION.to_owned(),
            "2.0.0".into(),
        )
        .unwrap();
    let mut state = UpdateState::Staged(Box::new(StagedUpdate {
        installer,
        install_lock,
        cache,
        current: OLD_VERSION.to_owned(),
        updates: updates.clone(),
    }));
    assert_eq!(
        check_sync(&mut state, None, None).unwrap_err().code,
        "update_in_progress"
    );
    assert_eq!(
        stage_sync(&mut state).unwrap_err().code,
        "update_in_progress"
    );
    assert_eq!(
        super::super::storage::lock_install(&updates, &root)
            .unwrap_err()
            .code,
        "update_in_progress"
    );
    drop(state);
    assert!(super::super::storage::lock_install(&updates, &root).is_ok());
}

#[test]
fn interrupted_or_incomplete_swap_preserves_durable_journal_and_refuses_retry() {
    for failure in [
        "interrupted",
        "directory-rollback-failed",
        "entries-rollback-failed",
        "path-mismatch",
    ] {
        let dir = TestDir::new();
        let layout = fixture(dir.path());
        let updates = dir.path().join("updates");
        let _lock = super::super::storage::lock_install(&updates, &layout.root).unwrap();
        let old_digest = layout.old_install_digest(OLD_VERSION).unwrap();
        let old_program = layout.root.join(&layout.program).canonicalize().unwrap();
        let outside_backup = layout
            .root
            .with_file_name(backup_name(layout.root.file_name().unwrap()));
        let swap = InstallSwap {
            layout,
            old_digest,
            updates,
            current: OLD_VERSION.to_owned(),
            target: "2.0.0".into(),
        };
        let journal = pending_swap(&swap.updates);
        let result = swap.finish(Ok(old_program.clone()), || {
            assert!(
                journal.is_file(),
                "journal persisted before touching the installation"
            );
            let root = &swap.layout.root;
            match failure {
                "interrupted" => fs::rename(root, &outside_backup).unwrap(),
                "directory-rollback-failed" => {
                    fs::rename(root, &outside_backup).unwrap();
                    fs::create_dir(root).unwrap();
                    fs::write(root.join("blocker"), b"directory is occupied").unwrap();
                    assert!(fs::rename(&outside_backup, root).is_err());
                }
                "entries-rollback-failed" => {
                    let host = root.join(&swap.layout.host);
                    fs::rename(
                        &host,
                        host.with_file_name(backup_name(host.file_name().unwrap())),
                    )
                    .unwrap();
                    fs::copy(&old_program, &host).unwrap();
                    fs::OpenOptions::new()
                        .append(true)
                        .open(host)
                        .unwrap()
                        .write_all(b"mixed update")
                        .unwrap();
                }
                "path-mismatch" => return Ok(root.join(&swap.layout.host)),
                _ => unreachable!(),
            }
            Err(io::Error::other(failure))
        });
        assert!(
            matches!(result, SwapOutcome::InstallCorrupted(_)),
            "{result:?}"
        );
        let evidence: Value = serde_json::from_reader(File::open(journal).unwrap()).unwrap();
        assert_eq!(evidence["currentVersion"], OLD_VERSION);
        assert_eq!(evidence["targetVersion"], "2.0.0");
        assert!(evidence["error"].as_str().is_some());
        assert_eq!(
            super::super::storage::refuse_pending_swap(&swap.updates)
                .unwrap_err()
                .code,
            "update_install_corrupted"
        );
    }
}

#[test]
fn only_a_verified_swap_or_verified_rollback_clears_the_journal() {
    let dir = TestDir::new();
    let layout = fixture(dir.path());
    let updates = dir.path().join("updates");
    let _lock = super::super::storage::lock_install(&updates, &layout.root).unwrap();
    let old_digest = layout.old_install_digest(OLD_VERSION).unwrap();
    let program = layout.root.join(&layout.program).canonicalize().unwrap();
    let swap = InstallSwap {
        layout,
        old_digest,
        updates,
        current: OLD_VERSION.to_owned(),
        target: "2.0.0".into(),
    };
    let journal = pending_swap(&swap.updates);
    assert_eq!(
        swap.finish(Ok(program.clone()), || Err(io::Error::other("no takeover"))),
        SwapOutcome::RolledBackVerified("no takeover".into())
    );
    assert!(!journal.exists());
    let archive = swap.updates.join("update.tar");
    let mut tar = tar::Builder::new(File::create(&archive).unwrap());
    tar.append_dir_all(swap.layout.root.file_name().unwrap(), &swap.layout.root)
        .unwrap();
    drop(tar.into_inner().unwrap());
    let staged = Installation::directory(&swap.layout.root, &swap.layout.root.join(&swap.layout.program))
        .unwrap()
        .stage(&archive)
        .unwrap();
    assert_eq!(
        swap.finish(Ok(program.clone()), || staged
            .finish()
            .map_err(io::Error::other)),
        SwapOutcome::Swapped {
            executable: program
        }
    );
    assert!(!journal.exists());
}
