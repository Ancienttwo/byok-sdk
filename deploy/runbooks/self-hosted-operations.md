# Self-Hosted Agent Operations Runbook

Status: CURRENT for `byok-agent` foreground and OS-service deployments.

## Daily operator path

1. `byok-agent status --config <path>` shows persisted history plus a clearly marked live section when the authenticated control socket is reachable.
2. `byok-agent doctor --config <path>` performs read-only config, runtime, control, health, journal and quarantine checks. JSON output is available with `--json`.
3. `byok-agent support-bundle --output <new-path> --config <path>` writes one bounded JSON artifact (0600 on POSIX; restrictive owner/SYSTEM/Administrators DACL on Windows). The command refuses to overwrite an existing file and prints its redaction policy.

The support bundle includes system version, bounded runtime presence/capability facts, aggregate live/storage-presence state, health metadata, quarantine hashes/sizes and bounded closed-enum audit kind/timestamps. It excludes runtime version output/identifiers, server host/path/query, local paths, control/provider credentials, task ids and prompt/tool/approval bodies.

## Corrupt state

- A malformed/invalid-shape `operational-health.json` is reported as confirmed corrupt and left byte-identical by ordinary status/doctor runs. Open、permission、special-file or concurrent-change failures are reported as unavailable and are not eligible for fix.
- Stop the daemon, retain a copy if local policy requires it, then run `byok-agent doctor --fix --yes --config <path>`. This is the only shipped fix: it must acquire the same cross-process store mutation lease held until auth renewal and every other daemon writer stop, re-confirm corruption through a no-follow/non-blocking open handle, refuse unavailable/symlink/non-regular evidence, synchronously copy the exact bounded bytes into a separate evidence inode inside a pinned `quarantine/` directory, hash that copy, revalidate the unchanged source, remove only its source name, and write a manifest containing reason, source path, size and SHA-256. It does not create a healthy replacement.
- `daemon.db` corruption follows the existing `JournalCorruptError` quarantine path. There is no doctor rebuild or SQLite fallback. Inspect/recover the quarantined database outside the SDK before re-pairing or accepting new work.
- Quarantine is never automatically deleted. Retention is an explicit operator policy and must preserve incident/legal requirements.

## Pressure and recovery

- `hard-pressure` declines new ordinary work retryably while terminal/truth flush, export, doctor and recovery remain allowed.
- `emergency` refuses to acknowledge data it cannot durably append.
- Never delete unacked envelopes, live/approval tasks, unconfirmed terminals, recovery-marked records, user workspaces, credentials or quarantine evidence.
- Restart through launchd/systemd/WinSW. The SDK daemon does not implement a second supervisor.
