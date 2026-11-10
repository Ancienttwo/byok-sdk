# #605 L1: protocol 4 and Windows explicit-root open barrier

Refs #605; reuses the retained-chain primitive and per-flush injection cases
from closed PR #1083 (`8c9e63856a88ac1da53ea007474065ce06f5da05`). Base:
`0e6c4453988b2df66c6677eaf3f4f7604ebc43ab` on `train/next-minor`.
The owner signed the full protocol-4 contract on 2026-11-10, including the
mandatory public argument and the root-durability precondition
([record](https://github.com/Ancienttwo/byok-sdk/pull/1650#issuecomment-6762093837)).
This implementation remains Draft for the coordinator's reviews. It does not
establish Windows OS-crash or power-loss durability, and it does not enable B.

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
and contains no NUL. It must resolve to an ancestor of `root` (home itself is
valid for a direct caller's deliberately selected boundary). The daemon never
substitutes home for the enrolled root. Unknown fields, missing/null required
fields, and every request protocol other than 4 are rejected. Responses use
protocol 4 and the open result reports helper version `"4"`; the daemon rejects
any other response protocol or helper version. Upgrade daemon and helper
together. There is no protocol-3 reader, omitted-root default or fallback.

The daemon's one authority for this field is
`AgentHomeResolution.hostStorageRoot`: `AgentHomeLayout.resolveRoot` obtains
its canonical spelling and `resolve` creates `agentsRoot` and home below it.
Task helper opens use that same layout authority; export uses its acquired
binding; the intent/commit backend captures the canonical layout root at daemon
composition. The admission volume probe deliberately opens that root itself
as both home and ancestor. It is a probe of the selected root, not a task home.

**Precondition:** `hostStorageRoot` must already exist durably before the first
helper open. W2-B flushes that directory and the chain below it; it does not
flush its parent or prove that the root's own directory entry is durable.
Existing Agent-home root materialization is unchanged and may create a missing
root. Root initialization: [#1652](https://github.com/Ancienttwo/byok-sdk/issues/1652).
This Draft claims no proof for creating the root itself.

Public breaking signatures, on the next MINOR train:

- `openAgentMemoryFilesystemHelper({ helperBin, canonicalHome, ancestorRoot,
  homeIdentity, assetRoot? })` requires `ancestorRoot`.
- `helperAgentMemoryIntentBackend(helperBin, ancestorRoot, assetRoot?)` requires
  the root as its second argument; `assetRoot` moves to third.
- The exported helper protocol/version constants change from `3`/`"3"` to
  `4`/`"4"`.

No public Agent-home config or lease field is added. The owner signed the
field contract, selected root authority, durability precondition and version
cut; Windows B still awaits the separately required recovery evidence.

## Barrier behavior

Windows open validates its existing local-NTFS and leased-home identity gates,
then retains the ancestor-to-home chain through descriptor-relative child
opens. Every retained directory must be on the same volume as the pinned home.
The terminal object must match the already-pinned home. The first flush pass
runs ancestor to home; relation checks follow; the second runs home to
ancestor. Every flush is mandatory. No directory above `ancestorRoot` is
flushed by that Windows chain barrier. macOS retains its existing same-volume
home-chain barrier and also validates the explicit ancestor relation.

Agent-home initialization creates `.byok` while acquiring the lease and
`notes` before exposing the memory helper. Open adds an initialization barrier
for each real directory present: pin and verify the child, flush the child,
recheck its parent entry, flush home, and recheck the entry again. Repeat opens
also flush existing directories, so retrying a failed initialization does not
skip the barrier. Missing entries are not created by the helper. Wrong-type or
link entries gain no directory authority and remain subject to the existing
operation/restore checks; open must still permit the repair path for malformed
`notes`. Failure closes the pinned home before any session is exposed.

Windows `strictLedgerBarrier` remains false and the production daemon does not
advertise `agent-memory-intent.v1`. Processor tests use the existing explicit
W4/W5 test-only B seam. Those tests are not A7 power-loss evidence.

## Verification and limits

Local macOS arm64:

- `bun run build`, `bun run typecheck`, Go `go test ./...`, and Windows amd64
  test-binary cross-compilation passed.
- After the rebase, all 28 affected TS files passed: 354 tests passed and 38
  skipped, including runtime discovery. The full client suite then passed
  483 files / 6,489 tests (94 tests skipped); other workspace suites are still
  running. This full-client run used the pre-handle-fix native artifact;
  affected helper tests must also run with the regenerated artifact.
- The native release was built at two independent source paths for all three
  targets; bytes and generated pin matched. Source-digest release tests passed.
- `check:api-surface` and `check:version-authority` passed after the deliberate
  golden update. The coordinator approved only these measured closure increases:
  client 2,353,342 → 2,353,836 bytes (+494), agent-memory 73,576 → 73,835 (+259),
  and byok-agent 2,323,578 → 2,324,072 (+494); the README table was regenerated.
- `check:release-pack` initially refused the uncommitted tree as designed; it
  must run on the committed Draft head.

The first actual win-ci Go run (Go 1.26.5, Windows amd64, normal user) passed
all new protocol, explicit-chain and initialization tests, including every
injected flush. Its ancestor-junction fixture failed. Using the original
canonical ancestor authority did not fix it: [hosted Windows job
129706074753](https://github.com/Ancienttwo/byok-sdk/actions/runs/42779537199/job/129706074753)
reproduced the failure at `TestWindowsOpenWithJunctionFixtures/ancestor-junction`.
The existing W2 diagnostic in that job independently showed
`filepath.EvalSymlinks` failing on a junction-ancestor home while every native
handle open and flush succeeded.

The fix resolves both Windows chain names with `GetFinalPathNameByHandleW`
using `FILE_NAME_NORMALIZED | VOLUME_NAME_DOS` (flags zero): home comes from the
already-pinned handle, ancestor from an explicitly opened `ancestorRoot`.
One normalizer removes the extended drive prefix or converts the extended UNC
prefix for both names; it preserves component case. The requested home must
still identify the pinned object, and the retained-chain relation, volume and
final-home checks remain mandatory. Query/normalization failure returns the
specific bounded `root_resolution_failed` error with no pathname fallback.
Unix retains `EvalSymlinks`; the other production use in `syncHomeChain` is
only called on Unix. Diagnostic-only uses are not admission paths.

A new Windows regression covers junction-ancestor resolution from the pinned
home, shared DOS/UNC normalization, and closed name-handle failure. The original
junction assertions remain. Local Go race and Windows amd64 cross-compilation
passed after the fix. All three native targets were rebuilt with the normal
repository scripts in an isolated stage, including two-path reproducibility;
the stage source digest was checked against the real native tree before
copying the generated pin. The worktree source/pin tests passed (4/4).
Regenerated source digest:
`412481b72e8872d75cf6954c83073b38b87dab6a7410c41cedc9940aed5aff20`.
Hosted Windows green and actual win-ci processor verification remain pending.

The coordinator paused all win-ci activity after its connection hung during
large stdin transfers, then restored serialized access. This seat still waits
for its explicit turn. The remote scratch to remove then is `C:\Users\win\byok-tmp\l1-605-t26m`. Future file transfers must use `hc file`.
Actual Windows TS processor verification, final Go rerun, release-pack and
full-suite results will be appended before final handoff. CI on the Draft head
is the acceptance authority; local and process-kill checks cannot close A7.
