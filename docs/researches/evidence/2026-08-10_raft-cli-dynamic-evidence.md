# RAFT Computer CLI dynamic evidence

> Captured: 2026-08-10
> Target: locally installed `raft-computer` 1.0.15
> Scope: unauthenticated, unattached, offline CLI observation only
> Provenance: consolidated from the original case-local journal so this report remains available in a fresh clone

This appendix preserves the bounded observations behind
`../2026-08-10_research-raft-cli-dynamic-report.md`. It does not ship the
third-party executable or its extracted bundle. E-001 through E-007 are
replayable when the same executable is installed. E-008 is a retained
hash-bound observation; its original `/tmp/raft-probe` bundle is no longer
available, so it must not be presented as independently replayable from this
repository alone.

## Scope

- Authorization basis: observation of the operator's own local installation.
- In scope: executable identity, help/version, empty-state `status`, `doctor`,
  unattached `runners list`/`logs`, and same-version `upgrade --dry-run`.
- Out of scope: login, attach, production accounts, service installation,
  daemon start, real upgrade, rollback, and real `~/.slock` state.
- Isolation: case-local `SLOCK_HOME`/`RAFT_HOME`; runtime probes used macOS
  `sandbox-exec` with `(deny network*)`.

## Timeline

1. Identified the Mach-O, digest, signature, version, and command surface.
2. Ran empty-state and unattached commands with network denied and case-local
   state roots.
3. Ran same-version upgrade dry-run and inspected its local audit record.
4. Compared the installed binary hash with a then-available extracted bundle
   and corrected four document attributions.
5. Closed the case with 8 evidence records and no authenticated or remote run.

## Work items

| ID | Work | Evidence | Status |
| --- | --- | --- | --- |
| WI-001 | Identify binary and public command surface | E-001, E-002, E-007 | done |
| WI-002 | Observe isolated unauthenticated behavior | E-003–E-006 | done |
| WI-003 | Reconcile external-reference claims | E-008 | done, source artifact no longer retained |

## E-001

Installed binary identity:

- arm64 Mach-O, `150920336` bytes;
- SHA-256 `87f298144f1dc13393af635d57dad15345a4b31cac032524bf3e9fec965bb51b`;
- Developer ID Application: Botiverse, Inc. (`XDAPXFY8FZ`);
- `codesign --verify --deep --strict` reported valid on disk.

Replay surface: `file`, `stat`, `shasum -a 256`, and `codesign --verify` on the
installed executable.

## E-002

`raft-computer --version` returned `1.0.15`. Root help exposed login, logout,
attach, setup, start, stop, restart, status, doctor, logs, runners, channel,
and upgrade commands.

## E-003

With fresh case-local roots and network denied, `status` printed:

```text
Logged in: no
CLI version: 1.0.15
Service: stopped
Service version: unknown (no live version evidence)
Attachments: none
```

The command exited `0` and the case-local state directory remained empty. This
only proves the observed empty-state branch; it does not make every `status`
path read-only.

## E-004

With no attachment, both `runners list` and `logs` exited `1`, reported
`NO_ATTACHMENT`, and stated that no local Computer state was changed.

## E-005

With distinct roots, the computer command selected `SLOCK_HOME` over
`RAFT_HOME`. Under the same empty-state fixture, `doctor` treated the state root
and stopped service as passing checks, treated user session and attachments as
failed checks, and exited `1`.

## E-006

`upgrade --dry-run --target-version 1.0.15` printed that no target existed and
exited `0`, but wrote a `0600` `computer/upgrade.log` entry with:

```text
outcome=err
errorCode=UPGRADE_NO_TARGET
fromBundle=1.0.15
toBundle=1.0.15
```

The captured log's SHA-256 was
`e9265fc1db5ed3dcb5e1a32ca6ef0b805bb899337d216a0d81a29d41456d7070`.

## E-007

`raft-computer status --help` exposed only `-h, --help`; no JSON or other
machine-readable output mode was present.

## E-008

At capture time, the installed executable and `/tmp/raft-probe/sea/rc.bin`
shared SHA-256
`87f298144f1dc13393af635d57dad15345a4b31cac032524bf3e9fec965bb51b`.
The matched bundle observation recorded that:

- `agentBridgeCommand` owned the `5000/120000/3000/limit 50` tuple;
- `taskCreateCommand` registered `--assignee <handle>`;
- `AGENT_ACTIVITIES` was `online/thinking/working/error/offline`;
- `status` invoked `reconcileStalePendingUpgrade()`, which could clear settled
  status/pending markers.

The extracted bundle and `rc.bin` were temporary third-party artifacts and are
not present now. These four points remain historical, hash-bound observations;
re-establishing them requires obtaining a matching authorized binary and
repeating the extraction. They are not fresh-clone proof of current RAFT
behavior.
