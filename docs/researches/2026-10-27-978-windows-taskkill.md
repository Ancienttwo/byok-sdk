# Step 6 on Windows: `taskkill /F` recovery (#978)

Issue: [#978](https://github.com/Ancienttwo/byok-sdk/issues/978), the Windows
half of step 6 in [the 0.30.2 Host upgrade checklist](../releases/host-upgrade-0.30.2.md#checklist).
A daemon that has claimed a task is killed with `taskkill /F /PID <pid>` and
started again. Pass means exactly one terminal, `task.fail` with reason
`daemon_interrupted` and `retryable: false`, and no second runtime start.

Owner decisions (2026-10-27): run it on a GitHub `windows-latest` runner, as
#608 did; use a hanging runtime that calls no model; run one script against
both versions; record 0.30.2 on an aliased store path as a failure with its
cause.

## Two checks

- **Shared smoke script.** AiphaBee's macOS `kill9-smoke.ts` from #978, on
  the public API of `@byok-sdk/client`, `server` and `protocol`, with
  `taskkill /F` on Windows. Daemon children run under Node with file-backed
  device credentials. It ran once per version from temporary CI jobs, which
  were reverted before merge. Wire v4 changed two inputs, so the script reads
  `PROTOCOL_VERSION`: on v4 it omits `DaemonConfig.workspaceRoot` and selects
  `session: { mode: 'fresh' }`. Store paths are the same on both versions:
  under `os.tmpdir()`, which on the runner is the 8.3 short name
  `C:\Users\RUNNER~1\AppData\Local\Temp`.
- **Permanent test.** `execution-recovery-kill.test.ts`, describe
  "compiled daemon taskkill /F execution recovery on Windows", in the
  Windows leg of the CI job `execution-recovery-native`. The daemon is the
  Bun-compiled fixture with the default store, the default journal and
  Windows Credential Manager custody. The test also counts terminal rows on
  the cloud wire and confirmed journal terminals.

## Runs

Runner image `windows-2025-vs2026` 20261021.278.1, Node v24.22.1, Bun 1.4.2
(not used by the 0.30.2 job).

| Run, job | Code | Check | Result |
| --- | --- | --- | --- |
| 40466155115, 122061933009 | published 0.30.2 | shared smoke | **Fail.** Second start exits with `retention_root_identity_invalid`; no terminal |
| 40514487294, 122224731090 | published 0.30.2 | shared smoke | **Fail**, same error |
| 40514487294, 122224731181 | branch on main `5d0e3702` (with #1032) | shared smoke | **Pass.** `taskkill` exit 1; one accepted `task.fail` (v4, `daemon_interrupted`, `retryable: false`); runtime starts 1 before, 0 after |
| 40466155115, 122062032139 | branch on main `e8648382` | permanent test | **Fail.** Restart exits with `retention_root_identity_invalid` |
| 40533270421, 122292652457 | branch on main `5d0e3702` | permanent test | **Pass.** One `task.fail`, one wire terminal, one confirmed journal terminal, one runtime start |

## 0.30.2: fails on an aliased store path

The kill and the pre-restart state are as expected: the task is `Running`
with no terminal, and `taskkill` ends the daemon with exit code 1. The
restarted daemon then fails its startup retention sweep. `existingDirectory`
requires `realpath(dir) === dir`, and 0.30.2 keeps the configured store
spelling on Windows. After a task has created `<scratch>\exec`, an 8.3 short
name or a letter-case variant in the store path fails that check, so the
daemon cannot start and sends no recovery terminal. This is
[#1030](https://github.com/Ancienttwo/byok-sdk/issues/1030); #1032 folds
name aliases of the configured store once, and 0.31.0 carries the fix. No
0.30.2 run on a store path without an alias is part of this evidence.

## Pairing time on Windows

The permanent test first failed on main `5d0e3702` because the first daemon
did not report ready within the test's 10 s default. A diagnostic run
(40533270421) timed it: `daemon.pair()` with Credential Manager custody took
9.2 s, then `start()` opened in under 0.3 s. A restart without pairing opened
in 0.85 s. The test now waits 30 s for ready on Windows only.

## Not covered

- An AiphaBee device, and checklist steps 1–3.
- A real runtime or model.
- The shared smoke uses file-backed device credentials; Credential Manager
  custody is covered by the permanent test only.
- One runner image.
