# #605 L1: protocol 4 and Windows explicit-root open barrier

Refs #605 and Draft PR [#1650](https://github.com/Ancienttwo/byok-sdk/pull/1650).
The implementation reuses the retained-chain primitive and per-flush injection
cases from closed PR #1083 (`8c9e63856a88ac1da53ea007474065ce06f5da05`). The
current train integration is `b77c6976492dbd769b1253e76ad49b1eb912a51d`.

The owner signed the full contract on 2026-11-10, including the mandatory public
argument and root-durability precondition
([record](https://github.com/Ancienttwo/byok-sdk/pull/1650#issuecomment-6762093837)).
The PR remains Draft for the coordinator's reviews. This work does not establish
Windows OS-crash or power-loss durability and does not enable B.

## Owner-signed contract

The private JSON-lines `open` request has exactly these fields:

```json
{
  "id": "m1",
  "protocol": 4,
  "op": "open",
  "root": "<absolute Agent home>",
  "ancestorRoot": "<absolute canonical enrolled hostStorageRoot>",
  "expectedIdentity": {
    "kind": "windows",
    "volumeSerial": "<unsigned decimal uint32>",
    "fileIndex": "<unsigned decimal uint64>"
  }
}
```

Unix identity remains `{ "kind": "unix", "dev": "<uint64 decimal>",
"ino": "<uint64 decimal>" }`. `root` retains its Agent-home meaning.
`ancestorRoot` is required, non-null, nonempty, absolute, at most 4096 bytes,
and contains no NUL. It must resolve to an ancestor of `root`; home itself is
valid for a direct caller's deliberately selected boundary. The daemon never
substitutes home for the enrolled root. Unknown fields, missing/null required
fields, and every request protocol other than 4 are rejected. Responses use
protocol 4 and open reports helper version `"4"`; the daemon rejects any other
response protocol or helper version. Upgrade daemon and helper together.
There is no protocol-3 reader, omitted-root default or fallback.

The daemon's one authority is `AgentHomeResolution.hostStorageRoot`:
`AgentHomeLayout.resolveRoot` obtains its canonical spelling and `resolve`
creates `agentsRoot` and home below it. Task and export opens use their acquired
binding's `resolution.hostStorageRoot`; the intent/commit backend captures
the canonical layout root at composition. The admission volume probe opens that
selected root itself as both home and ancestor, rather than a task home.

**Precondition:** `hostStorageRoot` must already exist durably before the first
helper open. W2-B flushes that directory and its chain below; it does not flush
its parent or prove durability of the root's own directory entry. Existing
Agent-home root materialization is unchanged and may create a missing root.
Root initialization: [#1652](https://github.com/Ancienttwo/byok-sdk/issues/1652).
No proof is claimed for creating the root itself.

Breaking signatures, on the next MINOR train:

- `openAgentMemoryFilesystemHelper({ helperBin, canonicalHome, ancestorRoot,
  homeIdentity, assetRoot? })` requires `ancestorRoot`.
- `helperAgentMemoryIntentBackend(helperBin, ancestorRoot, assetRoot?)` requires
  the root second; optional `assetRoot` moves to third.
- Exported helper protocol/version constants become `4`/`"4"`.

No public Agent-home config or lease field is added. The upgrade manifest
covers the changed public helper-open export and links the [Host upgrade
section](../releases/host-upgrade-next-minor.md#agent-memory-helper-protocol-4).
There is no extracted upgrade-manifest item for this private helper protocol;
its version cut is included in that entry's migration text.

## Barrier and Windows path resolution

Windows open retains the ancestor-to-home chain through descriptor-relative
child opens. Every retained directory must share the pinned home's volume;
the terminal object must match the already-pinned home. Flush ancestor to
home, check relations, then flush home to ancestor. Every flush is mandatory,
and no directory above the selected ancestor is flushed by this Windows
barrier. Unix retains its existing same-volume traversal and validates the
explicit ancestor relation. **The owner approved Unix cross-volume refusal on
2026-11-10 in the t4 question dialog** (selection: 「跨 volume 就拒絕（推薦）」),
as verified and relayed by coordinator t3. Unix refuses a cross-volume selected
ancestor with `ancestor_volume_mismatch` before flushing or granting a session.
Both native and TS refusals instruct the Host: "Put the agents directory on the
same volume as hostStorageRoot." The Host must fix this layout before retrying.
The traversal
must cover the entire selected chain before it can stop at the home volume
boundary; it can still flush same-volume parents above the selected ancestor,
as before.

Agent-home initialization creates `.byok` during lease acquisition and `notes`
before binding the memory helper. Open adds a barrier for each real directory
present: pin and verify the child, flush it, recheck its parent entry, flush
home, and recheck the entry again. Repeat opens also flush existing directories,
so retry does not skip a previously failed barrier. Missing entries are not
created by the helper. Wrong-type/link entries gain no directory authority and
remain subject to the existing operation/restore checks; malformed `notes`
must remain repairable. Failure closes the pinned home before publishing a
session.

The existing junction-ancestor fixture failed on Windows after initial wiring.
Changing its ancestor field from an alias to the canonical parent did not fix
it. [Hosted Windows job 129706074753](https://github.com/Ancienttwo/byok-sdk/actions/runs/42779537199/job/129706074753)
reproduced the failure; the existing W2 diagnostic independently showed
`filepath.EvalSymlinks` failing through the junction while native handle opens
and flushes succeeded.

Windows therefore resolves both chain names with `GetFinalPathNameByHandleW`,
using `FILE_NAME_NORMALIZED | VOLUME_NAME_DOS` (flags zero): home from the pinned
handle, ancestor from an explicitly opened `ancestorRoot`. One normalizer
removes the extended drive prefix or converts the extended UNC prefix for both
names, preserving component case. The requested home must still match the
pinned object. Existing relation, volume and final-home checks remain required.
Query/normalization failure returns bounded `root_resolution_failed`; there is
no Windows pathname fallback. Unix retains `EvalSymlinks` in its chain-name
resolution and passes that validated chain into the existing volume traversal.
Diagnostic-only uses grant no authority.

The original junction assertions remain. A new Windows guard covers resolution
from the pinned home, DOS/UNC normalization and closed name-handle failure.
Hosted Windows Go jobs on windows-latest and windows-2022 passed after this
change, providing red/green evidence against the original failure. A remaining
raw junction-smoke caller still expected protocol 3; its version and required
ancestor field were updated to 4 without changing sentinel/refusal assertions.

Windows `strictLedgerBarrier` remains false and production does not advertise
`agent-memory-intent.v1`. Processor tests retain the explicit W4/W5 test-only
B seam. Those tests are not A7 evidence.

## Verification evidence

Acceptance-review delta: the real Unix `openSession` path originally granted a
session after only 6/4 flushes when the existing device-comparison seam reported
a different volume at the selected ancestor/an intermediate parent. The
regression now requires `ancestor_volume_mismatch`, no session and zero flushes,
then retries successfully with the seam restored. The shared real-open test
compares the identity and order of every chain flush in both passes and every
initialization flush on Unix and Windows, and injects failure at each one.
The daemon MCP integration deliberately gives maintenance `hostRootInput()` a
different existing ancestor and checks that opens still use the task binding's
canonical `resolution.hostStorageRoot`.

- Merged build, typecheck, API surface, version authority and upgrade-manifest
  checks passed. The manifest gate records that the next release must be MINOR.
- Go race tests passed and the Windows amd64 test binary cross-compiled.
- All three native targets passed two-path reproducibility. An isolated stage
  initially generated the handle-fix pin while the full suite owned `dist`;
  its source digest was checked against the real native tree before copying the
  generated pin. Real-worktree source/pin tests passed 4/4, followed by a normal
  merged-worktree native build/repro/pin verification. The stage was deleted.
- Native source digest:
  `3aaf4812361a4d9e6aab69538f8b7b5ca39f80f9c413bd42afcb8b32479fae75`.
- Owner-message delta: focused Go race tests and the transport remedy test
  passed; the final affected TS run passed 4 files / 18 tests without skips.
  Build/typecheck, three-target two-path reproducibility, API/version/upgrade
  gates and source/pin tests (4/4) passed with regenerated native assets.
- Before acceptance review, the affected TS run passed 28 files / 354 tests,
  with 38 skipped (31.32 s).
- The broader local workspace run passed the full client suite (483 files,
  6,489 tests, 94 skipped), then failed in K8 cross-bot tests under accumulated
  load. That full-client run preceded the final Windows handle fix; subsequent
  affected tests and hosted helper jobs exercise the regenerated artifact.
- Both macOS hosted helper jobs passed on the merged implementation. Hosted
  Windows SDK TS helper/processor checks and Node/Bun runtime smoke passed
  before the stale raw-junction-smoke version assertion described above.
- The binding-authority review fix added exactly +28 to the client and
  byok-agent caps, approved by the coordinator. The subsequent owner-directed
  TS remedy adds exactly +152 to each affected closure: client
  2,353,872 → 2,354,024 bytes, agent-memory 73,835 → 73,987, and byok-agent
  2,324,108 → 2,324,260. Only those measured caps changed; total increases over
  train are +674, +411 and +674. README rows were regenerated from the build;
  no selector, workflow or CSP-policy edits belong to this PR's own diff.

The coordinator requested an isolated K8 comparison on the same macOS arm64
machine, Node 24.18.0 and Bun 1.4.3, sequentially with no overlapping heavy task
from this seat. Each checkout had its own dependency install, build and native
assets:

| Checkout | Exact SHA | Result |
| --- | --- | --- |
| L1, protocol-4 assets | `e5489c634d8314bca5ac7c02647eba5e43d73014` | 79 files / 720 tests passed, 566.19 s |
| Train baseline, protocol-3 assets | `202ac1f49afb98e8f29542d7c18ed691f9ae448f` | 79 files / 720 tests passed, 497.50 s |

Command: `bun run --filter @byok-sdk/example-bot-collaboration test`. No
branch-only isolated failure was found. The failed full-workspace run is not
counted as a pass.

Per the coordinator's 2026-11-10 decision, final-head hosted windows-latest and
windows-2022 Go jobs plus the Windows SDK processor/helper and runtime smoke
checks are sufficient Windows evidence for this Draft. No further win-ci run
is required for L1; physical-machine/storage-profile evidence belongs to the
later A7 VM work. Final-head CI and packaging outcomes are recorded on PR
#1650, the verification authority. Neither local tests nor process kills close
A7 or justify enabling B.
