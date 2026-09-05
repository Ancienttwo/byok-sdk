# Implementation Notes: runtime-event-spill

> **Status**: Active
> **Plan**: plans/plan-20260906-0253-runtime-event-spill.md
> **Contract**: tasks/contracts/20260906-0253-runtime-event-spill.contract.md
> **Review**: tasks/reviews/20260906-0253-runtime-event-spill.review.md
> **Last Updated**: 2026-09-06 03:20
> **Lifecycle**: notes

## Per-File Changes

### Protocol

- `packages/protocol/src/agent-event.ts`
  - New `AGENT_EVENT_SPILL_UNSTORED_REASON_MAX_LENGTH = 512`.
  - New `AgentEventSpillSchema` / `AgentEventSpill`: `.strict()` object with
    `field: 'input'|'output'`, `totalBytes`, `omittedBytes`,
    `contentType: z.literal('application/json')`, optional `blob: BlobRefSchema`,
    optional `unstoredReason` (1..512), plus a `.refine` asserting exactly one of
    `blob` / `unstoredReason`.
  - `spill: AgentEventSpillSchema.optional()` added to the `tool_use` and
    `tool_result` variants only. No other variant gained a field; no existing
    field changed type.
  - New import of `BlobRefSchema` from `./blob` (blob.ts imports only zod, so no
    cycle).
- `packages/protocol/src/index.ts` — exports `AgentEventSpillSchema`,
  `AGENT_EVENT_SPILL_UNSTORED_REASON_MAX_LENGTH`, and the `AgentEventSpill` type
  next to the existing agent-event exports.
- `packages/protocol/src/__tests__/agent-event.test.ts` — new
  `AgentEvent spill descriptor` describe block: blob form accepted, unstored form
  accepted, both rejected, neither rejected, `unstoredReason` bound at 512 (and
  empty rejected), unknown key rejected (`.strict()`), non-JSON `contentType`
  rejected, `spill` on `progress` never becomes part of the parsed event,
  encode/decode round trip.
- `packages/protocol/src/__tests__/golden/v1.frozen.json` — regenerated. Diff is
  **816 insertions, 0 deletions** (`git diff --stat`), i.e. purely additive; the
  freeze guard's own diff output contained no removal lines before regeneration.
- `docs/protocol.md` — new `### 11.6 spill on tool_use / tool_result — bounded
  inline event content (additive)`, placed before `## 12`. States the consumer
  contract explicitly: `spill`'s presence is the only signal that `input`/`output`
  is a preview, and it must be checked before treating either as complete.

**Freeze-golden regeneration command** (from `freeze-guard.test.ts`'s own doc
comment, lines ~296-305 — the file writes the golden at import time when the env
var is set):

```
BYOK_PROTOCOL_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/protocol test -- freeze-guard.test.ts
```

### Client

- `packages/client/src/daemon/event-spill.ts` (new)
  - `DEFAULT_MAX_INLINE_EVENT_BYTES = 64 * 1024`,
    `MIN_MAX_INLINE_EVENT_BYTES = 4096`.
  - `EventSpillDeps { maxInlineBytes, blobClient: Pick<BlobResolver,'uploadArtifact'>, taskId, signal?, log? }`.
  - `spillOversizedEvent(event, deps)`: returns the SAME object reference for a
    non-`tool_use`/`tool_result` event and for any event already at or under the
    cap. Otherwise serializes the field, uploads it as `application/json` with
    `idempotencyKey = spill_<taskId>_<sha256hex>` and the task signal, and replaces
    the field with `{ preview: { head, tail } }` plus the `spill` descriptor.
  - UTF-8-safe cutting: `utf8Prefix` / `utf8Suffix` walk code points (handling
    surrogate pairs explicitly) so a preview can never contain a lone surrogate.
    The tail is taken from `serialized.slice(head.length)`, so head and tail can
    never overlap into duplicated content.
  - Cap invariant is **measured, not assumed**: the initial budget is
    `maxInlineBytes − byteLength(JSON.stringify(<event with an empty preview and
    the real, worst-case-sized descriptor>))`, split ceil/floor between head and
    tail, then the whole candidate event is `JSON.stringify`d and shrunk (by
    actual retained bytes, so every iteration makes strict progress) until it
    fits. This is load-bearing: JSON escaping costs up to 6 bytes per source
    character, so a raw byte budget alone would overshoot ~6x
    (`event-spill.test.ts` has a `U+0001`-filled case that proves it).
  - Upload failure produces `unstoredReason` bounded to ≤ 512 UTF-8 bytes on a
    code-point boundary, calls `log` once, and continues — the preview still
    ships and the task is not failed.
  - A final assertion throws a plain `Error` naming the numbers if the
    replacement still exceeds the cap. Made unreachable by construction via a
    skeleton gate: if `byteLength(skeleton) + MAX_SPILL_DESCRIPTOR_BYTES (768) >
    cap` — the event minus the spilled field plus the descriptor's proven
    worst-case encoded width — the field is not what can bring the event under
    the cap, so the event is forwarded unchanged and logged, with no upload.
    The trade: events whose non-spillable parts land in the band
    `(cap − 768, cap)` are now forwarded unchanged and logged, where the older
    `>= cap` gate would have spilled them with a tiny preview or driven them
    into the throw path. Reaching that band takes a ~3.3 KB `tool` name at the
    4096-byte minimum cap, or ~64 KB at the default — and it buys a provable
    bound instead of a reachable throw.
- `packages/client/src/daemon/task-runner.ts`
  - New optional `TaskRunnerDeps.maxInlineEventBytes` + private
    `get maxInlineEventBytes()` defaulting to `DEFAULT_MAX_INLINE_EVENT_BYTES`.
  - `pump`'s loop variable changed from `const event` to `let event`; the spill
    call sits immediately before the `estimateEventBytes` accounting, using
    `active.blobAbort.signal` as the task signal and
    `console.error('[byok/client] …')` as the log seam (the same diagnostic seam
    `reportArtifactError` and the rest of this file already use).
  - The existing stale-task guard (`this.tasks.get(active.taskId) !== active ||
    active.beingTornDown`) is repeated immediately after the await, because the
    upload is a real suspension point during which a cancel/reject can finish the
    task.
- `packages/client/src/daemon/create-daemon.ts`
  - `DaemonConfig.maxInlineEventBytes?: number` documented in the
    `maxTaskOutputBytes` style, including the consumer contract.
  - Validation next to the other synchronous config checks: safe integer,
    `>= MIN_MAX_INLINE_EVENT_BYTES`. Deliberately **no** `POSITIVE_INFINITY`
    opt-out (unlike `maxTaskOutputBytes`) — an unbounded per-event payload is the
    state this cap exists to prevent.
  - Threaded into `TaskRunnerDeps` beside `maxTaskOutputBytes`.
- `packages/client/src/daemon/agent-egress-policy.ts` — doc-comment only.
  `metadataStatusEvent` already constructs every projected event from
  SDK-authored literals rather than editing the incoming one, so `spill` was
  already dropped by construction; the comment now names that guarantee (a
  `BlobRef` is a readable locator for tool content, and the byte counts would
  leak the payload's size) and the new test pins it.

### Tests

- `packages/client/src/__tests__/event-spill.test.ts` (new, 17 tests) — identity
  for under-cap events, `progress`/`usage` untouched, absent-field and
  oversized-for-another-reason forwarding + log, oversized `tool_result` preview
  shape / `contentHash` / byte arithmetic / cap fit, symmetric `tool_use.input`,
  idempotency key format, signal forwarding, head/tail split balance, a multi-byte
  sweep (CJK + emoji + astral + accented) across eight cap values asserting no
  lone surrogate and `JSON.parse(JSON.stringify(result))` deep-equality, JSON
  escaping inflation, no head/tail overlap, upload rejection → bounded
  `unstoredReason` + one log + still under cap, and the minimum-cap proof with a
  200-character blobId and with a maximum-length `unstoredReason`.
- `packages/client/src/__tests__/task-runner-event-spill.test.ts` (new, 3 tests)
  — a 300 KiB `tool_result` through the real `TaskRunner` with a fake
  `blobClient`: the `task.progress` envelope carries the preview + `spill.blob`,
  the fake blob content equals the original serialization byte-for-byte, the
  idempotency key matches, and a `maxTaskOutputBytes` of 128 KiB is **not**
  tripped by a 300 KiB event when `maxInlineEventBytes` is 64 KiB (this is the
  post-spill accounting assertion). Second case: upload rejects →
  `spill.unstoredReason`, no `blob`, exactly one daemon log line, task still
  completes. Third case: an under-cap `tool_result` reaches the wire
  byte-identical with no upload.
- `packages/client/src/__tests__/agent-egress-policy.test.ts` — new test proving
  no `spill`, no `blobId`, no preview bytes, and no byte count survive
  `sanitizeEgressEnvelope` or `AgentEgressController.projectLatestValue` under the
  default metadata-status policy.
- `packages/client/src/__tests__/create-daemon-resource-limits.test.ts` — new
  describe block for `maxInlineEventBytes` validation (0, -1, 4095, 4096.5, NaN,
  POSITIVE_INFINITY rejected; 4096 and 65536 and unset accepted).

### Goldens / docs

- `api-surface/protocol.d.ts`, `api-surface/client.d.ts`,
  `api-surface/cloud.d.ts` — regenerated with
  `node scripts/api-surface/check-api-surface.mjs --update --package <name>`.
- `CHANGELOG.md` — two Unreleased entries (protocol additive `spill`; client
  `DaemonConfig.maxInlineEventBytes`), including the consumer contract and the
  never-silent upload-failure behavior.

## Deviations From Plan Or Spec

- **Scope widened by one derived file: `api-surface/cloud.d.ts`.**
  `@byok-sdk/cloud` re-exports the protocol `AgentEvent` schemas, so its
  api-surface golden drifts mechanically from the additive `spill` field (its
  diff is additions only — `0` removal lines). No cloud source is touched, but
  `bun run check:api-surface` cannot pass without regenerating it. Added to the
  contract's `allowed_paths` with an inline justification, per the contract's own
  Scope gate ("update this contract before widening scope").
- **`agent-egress-policy.ts` needed no behavioral change.** The deliverable asked
  to "drop `spill` in metadata-status projection"; `metadataStatusEvent` already
  rebuilds each event from literals, so the field was never copied. Only the
  doc comment and a pinning test were added rather than inventing a redundant
  strip step.
- **Branch.** The dispatch named `claude/event-spill`; the worktree is on `main`
  and switching branches was explicitly forbidden, so all work landed in the
  working tree of `main` uncommitted.

## Consumer Follow-Ups (falsifier check)

Grepped every in-repo reader of `tool_use.input` / `tool_result.output`:

| Consumer | Reads | Decision |
|---|---|---|
| `packages/client/src/bin/format.ts:61-64` | Renders only `tool_use: <tool>` / `tool_result: <tool>`; never touches `input`/`output` | No change needed. Nothing to annotate. |
| `packages/client/src/bin/audit-log.ts:208-211, 374-377` | Records `valueByteSize(event.input/output)` and renders a size placeholder | No change. It never renders content, so it degrades correctly: the recorded size becomes the preview's size. **Follow-up:** it could record `spill.totalBytes` so the audit trail shows the pre-spill size. Deliberately not done here — the audit-log record shape is a separate frozen-ish surface and the contract puts consumer rendering out of scope. |
| `packages/ui-runtime/src/timeline.ts:209-210, 221-222` | Copies `input`/`output` into a `TimelineToolCall` observation | No change. It structurally passes the value through and drops `spill` (it picks named fields), so it typechecks and shows the preview object. **Follow-up:** `TimelineToolCall` should carry `spill` so a UI can label a truncated result. Explicitly out of scope per the contract ("consumer rendering … ui-runtime timeline beyond typecheck"). |
| `packages/client/src/daemon/agent-egress-policy.ts` | Rebuilds events from literals | Covered — new test pins that `spill` never survives. |
| Salesko / hosted consumers | Out of repo | Covered by the CHANGELOG + `docs/protocol.md` §11.6 consumer contract. Listed as the known regression risk in the contract's Acceptance Notes. |

No in-repo consumer renders a preview as authoritative full content today, so
the falsifier does not fire.

## Design Decisions

- **Spill at the daemon's ingestion boundary, not in the adapters.** One hook in
  `pump` covers every current and future adapter, and it is the first place the
  SDK owns the payload while still holding the blob client.
- **Measure the replacement, never assume it.** The preview budget is arithmetic,
  but JSON escaping is not, so the loop re-measures `JSON.stringify(result)` and
  shrinks until it actually fits. The final assertion exists to make a broken
  bound loud rather than shipping an event the policy promised to bound.
- **Skeleton pre-check instead of a wider assertion.** An event that is oversized
  independently of its spillable field (a pathological `tool` name) is forwarded
  unchanged and logged, with no upload. Without this, the throw would be
  reachable from real data.
- **Upload failure is a telemetry failure, not a task failure.** The runtime's own
  transcript still holds the content; failing the task would trade a real result
  for an observability problem. `unstoredReason` + a log line keep it visible.
- **No `POSITIVE_INFINITY` opt-out for `maxInlineEventBytes`**, unlike
  `maxTaskOutputBytes`: "no per-event bound" is the exact state this config
  exists to remove.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Bound in each adapter | Rejected | Three copies of the same policy, and a custom adapter would bypass it. |
| Truncate without a descriptor | Rejected | A silent truncation is indistinguishable from a short output; the whole point is that omission is described. |
| Fail the task when the blob upload fails | Rejected | Loses a real result over a telemetry problem; `unstoredReason` + log is observable without being destructive. |
| Count pre-spill bytes against `maxTaskOutputBytes` | Rejected | The cap is about what the daemon puts on the wire; counting bytes that never left would fail tasks that behaved correctly. |
| Strip `spill` in `metadataStatusEvent` with an explicit delete | Rejected | The switch already rebuilds from literals; an explicit strip would imply the other cases need one too and invite the "list of remembered fields" failure mode. |

## Open Questions

- None blocking. Two consumer follow-ups are recorded in the table above.

## Verification (verbatim exit lines, this run)

```
### bun run build
@byok-sdk/client build: ESM ⚡️ Build success in 835ms
@byok-sdk/client build: Exited with code 0
byok-sdk build: ESM ⚡️ Build success in 18ms
byok-sdk build: Exited with code 0
EXIT=0

### bun run --filter @byok-sdk/protocol typecheck
@byok-sdk/protocol typecheck: Exited with code 0
EXIT=0

### bun run --filter @byok-sdk/protocol test
@byok-sdk/protocol test:  Test Files  21 passed (21)
@byok-sdk/protocol test:       Tests  356 passed (356)
@byok-sdk/protocol test: Exited with code 0
EXIT=0

### bun run --filter @byok-sdk/client typecheck
@byok-sdk/client typecheck: Exited with code 0
EXIT=0

### bun run --filter @byok-sdk/client build
@byok-sdk/client build: ESM ⚡️ Build success in 802ms
@byok-sdk/client build: Exited with code 0
EXIT=0

### bun run --filter @byok-sdk/client test
@byok-sdk/client test:  Test Files  170 passed | 2 skipped (172)
@byok-sdk/client test:       Tests  1678 passed | 11 skipped (1689)
@byok-sdk/client test: Exited with code 0
EXIT=0

### bun run typecheck
@byok-sdk/keys:typecheck                             | Done in 134ms
@byok-sdk/protocol:typecheck                         | Done in 250ms
@byok-sdk/server:typecheck                           | Done in 406ms
@byok-sdk/testkit:typecheck                          | Done in 114ms
@byok-sdk/ui-runtime:typecheck                       | Done in 118ms
byok-sdk:typecheck                                   | Done in 110ms
EXIT=0

### bun run check:api-surface
api-surface: 9 package golden(s) match the built declarations
EXIT=0
```

Whole-workspace `bun run test` (every package, same run):

```
@byok-sdk/client:test                           |  Test Files  170 passed | 2 skipped (172)
@byok-sdk/client:test                           |       Tests  1678 passed | 11 skipped (1689)
@byok-sdk/cloud:test                            |  Test Files  37 passed (37)
@byok-sdk/cloud:test                            |       Tests  338 passed (338)
@byok-sdk/cloud-dataplane:test                  |  Test Files  8 passed | 26 skipped (34)
@byok-sdk/cloud-dataplane:test                  |       Tests  74 passed | 103 skipped (177)
@byok-sdk/conformance:test                      |  Test Files  4 passed (4)
@byok-sdk/conformance:test                      |       Tests  160 passed (160)
@byok-sdk/core:test                             |  Test Files  9 passed (9)
@byok-sdk/core:test                             |       Tests  252 passed (252)
@byok-sdk/example-live-activity-host:test       |  Test Files  1 passed (1)
@byok-sdk/example-live-activity-host:test       |       Tests  21 passed (21)
@byok-sdk/example-salesko-connector-broker:test |  Test Files  5 passed (5)
@byok-sdk/example-salesko-connector-broker:test |       Tests  25 passed (25)
@byok-sdk/keys:test                             |  Test Files  21 passed (21)
@byok-sdk/keys:test                             |       Tests  427 passed (427)
@byok-sdk/protocol:test                         |  Test Files  21 passed (21)
@byok-sdk/protocol:test                         |       Tests  356 passed (356)
@byok-sdk/server:test                           |  Test Files  32 passed (32)
@byok-sdk/server:test                           |       Tests  347 passed | 19 skipped (366)
@byok-sdk/testkit:test                          |  Test Files  1 passed (1)
@byok-sdk/testkit:test                          |       Tests  4 passed (4)
@byok-sdk/ui-runtime:test                       |  Test Files  3 passed (3)
@byok-sdk/ui-runtime:test                       |       Tests  17 passed (17)
byok-sdk:test                                   |  Test Files  1 passed (1)
byok-sdk:test                                   |       Tests  1 passed (1)
```

```
$ git diff --check
DIFF_CHECK_EXIT=0
```

`repo-harness run check-task-workflow --strict` was **not** run — the dispatch
explicitly withheld it. Nothing was committed.

## Gate Round 1

Two acceptance findings against `packages/client/src/daemon/event-spill.ts`,
both fixed in the linked contract worktree
`/Users/kito/Projects/byok-sdk-wt-runtime-event-spill` (branch
`codex/runtime-event-spill`, base `152206c`). Nothing committed.

### Finding 1 — the "Unreachable" bound-failure throw was reachable

The comment at the old `:235-243` claimed the final cap check was "Unreachable
for any `maxInlineBytes >= MIN_MAX_INLINE_EVENT_BYTES`". False.
`BlobRefSchema.blobId` is an unbounded server-chosen string, so a SUCCESSFUL
upload can hand back a locator whose descriptor alone exceeds the cap.
Reproduced at cap 4096 with a 3800-character `blobId`: the module threw
`event spill failed to bound a tool_result event: replacement is 4137 bytes
against a 4096-byte cap`. Because `spillOversizedEvent` runs inside
`TaskRunner.pump`, that throw escaped into the runtime-boundary catch and
failed the task — misattributing a telemetry-plane problem to the adapter.

Fix, in three coupled parts:

1. **`MAX_UNSTORED_REASON_BYTES` is now charged on the ENCODED width**
   (`JSON.stringify(reason)` minus its two quotes), not the raw UTF-8 width.
   A raw bound was not enough to make anything provable: a runtime error
   message made of control characters escapes to six bytes per character, so
   a "512-byte" reason could cost 3072 bytes on the wire. `boundReasonText`
   rescales the prefix budget by the OBSERVED escape ratio rather than
   subtracting the overshoot — subtracting would zero out a maximally
   escaping reason entirely. All-ASCII reasons still truncate at exactly 512
   bytes, so the pre-existing max-length assertion is unchanged.
2. **`MAX_SPILL_DESCRIPTOR_BYTES = 768`** (exported), itemized in its own
   doc comment: `,"spill":` 9 + `{` 1 + `"field":"output",` 17 +
   `"totalBytes":<=16d>,` 30 + `"omittedBytes":<=16d>,` 32 +
   `"contentType":"application/json",` 33 + `"unstoredReason":` 17 + encoded
   reason <= 514 + `}` 1 = **654**, rounded up so digit growth cannot
   invalidate it. The skeleton gate is strengthened from
   `byteLength(skeleton) >= cap` to
   `byteLength(skeleton) + MAX_SPILL_DESCRIPTOR_BYTES > cap`.
3. **The measure-and-shrink loop is extracted into `bound(half)` and run
   twice.** When the first run (with the real `BlobRef`) still exceeds the
   cap — whether because the empty-preview overhead already exceeds it, or
   because the loop bottomed out at an empty preview — the descriptor falls
   back to `unstoredReason: "spill locator too large for maxInlineBytes:
   blobId <N> chars"`, `deps.log` fires once, and the same loop re-runs. The
   blob stays uploaded; only the inline locator is dropped, and the reason
   reports the SIZE rather than repeating the oversized id.

The false "Unreachable" claim is deleted. The final check is kept as a
fail-closed assertion and is now dead code by construction, with the argument
in the comment: reaching it requires an `unstoredReason` descriptor (the
`blob` branch already fell back), that descriptor costs at most 768 encoded
bytes, the skeleton gate refused to spill unless `skeleton + 768 <= cap`, and
because `spill` serializes last an empty-preview event is EXACTLY
`skeleton + ,"spill":{...}`. The arithmetic is asserted by a test
("fits the cap when the skeleton is at the gate AND the reason escapes
maximally"), not left to the prose.

### Finding 2 — unguarded `JSON.stringify`

`AgentEvent.input` / `.output` are `z.unknown()`, so an in-process custom
`AgentSession` can supply a BigInt, a cycle, or a throwing `toJSON`. Every
`JSON.stringify` in the module was unguarded — the one at the old `:139` threw
a `TypeError` before any size check, on the same `TaskRunner.pump` path whose
sibling `estimateEventBytes` documents "never throws".

Fix: one module-level `safeStringify` returning `string | undefined`, applied
at all four call sites (whole event, spilled value, skeleton, and both
measurements inside `bound`). Every failure logs once via `deps.log` and
returns the event unchanged — the same treatment given to values
`JSON.stringify` legitimately declines to encode, since in both cases the
module cannot measure and therefore cannot bound the event.

### Tests added

`packages/client/src/__tests__/event-spill.test.ts`

- `falls back to unstoredReason, keeps the upload, and never throws` — cap
  4096, upload succeeds with a 4000-character `blobId`; result <= cap,
  `unstoredReason` is exactly `spill locator too large for maxInlineBytes:
  blobId 4000 chars`, no `spill.blob`, the reason does not contain the id,
  upload called once, `log` called once, and a real preview still ships.
- `forwards a BigInt payload unchanged, logs once, and never uploads`
- `forwards a circular payload unchanged, logs once, and never uploads`
- `forwards a payload whose toJSON throws, without failing the caller`
- `fits the cap when the skeleton is at the gate AND the reason escapes
  maximally` — a 3240-character tool name puts the skeleton just inside the
  gate, the upload fails with 9000 `U+0001` characters (six bytes each once
  escaped), and the test asserts both the encoded-reason bound and that the
  whole `,"spill":{...}` fragment stays within `MAX_SPILL_DESCRIPTOR_BYTES`.

`packages/client/src/__tests__/task-runner-event-spill.test.ts`

- `completes the task when the blob store returns a locator too large to
  inline` — end to end through `TaskRunner.pump` at a 4 KiB cap with a
  4000-character `blobId`: `task.complete` is sent, no `task.fail`, the wire
  event is <= 4096 bytes and carries `unstoredReason` without the id, and the
  300 KiB payload is still in the blob plane.

### Evidence (verbatim exit lines, this run)

```
$ bun run --filter @byok-sdk/client typecheck
@byok-sdk/client typecheck: Exited with code 0
TYPECHECK_EXIT=0
```

```
$ bun run --filter @byok-sdk/client test -- event-spill task-runner-event-spill
@byok-sdk/client test:  Test Files  2 passed (2)
@byok-sdk/client test:       Tests  26 passed (26)
@byok-sdk/client test: Exited with code 0
TARGETED_TEST_EXIT=0
```

```
$ bun run --filter @byok-sdk/client test
@byok-sdk/client test:  Test Files  170 passed | 2 skipped (172)
@byok-sdk/client test:       Tests  1684 passed | 11 skipped (1695)
@byok-sdk/client test: Exited with code 0
CLIENT_TEST_EXIT=0
```

```
$ bun run check:api-surface
$ node scripts/api-surface/check-api-surface.mjs
api-surface: 9 package golden(s) match the built declarations
API_SURFACE_EXIT=0
```

```
$ git diff --check
DIFF_CHECK_EXIT=0
```

`bun run build` was run first: the workspace `typecheck` resolves
`@byok-sdk/core` / `@byok-sdk/protocol` through their `dist` declarations, so
a cold worktree fails with `TS2307` until it is built.
`repo-harness run check-task-workflow --strict` was not run — outside this
dispatch. Nothing was committed.

### Ledger and contract updates in this round

- `tasks/todos.md` — two Deferred Goals rows appended. The first names
  `ToolTimelineItem` (`packages/ui-runtime/src/types.ts:60-67`), not
  `TimelineToolCall`: there is no such symbol in
  `packages/ui-runtime/src/timeline.ts`. The second records that
  `redactAgentEvent` (`packages/client/src/bin/audit-log.ts:209-211`) measures
  the post-spill preview and should record `spill.totalBytes` instead.
- `tasks/contracts/20260906-0253-runtime-event-spill.contract.md` — Rollback
  Point commit `440907e` -> `5af5c5c`.

## Gate Round 2

Two documentation-accuracy findings against the round-1 fix. Both are text
only — no behavior changed. Fixed in this worktree
(`/Users/kito/Projects/byok-sdk-wt-runtime-event-spill`, branch
`codex/runtime-event-spill`). Nothing committed.

### Finding 1 — `unstoredReason` was documented as upload failure only

`packages/protocol/src/agent-event.ts:33-35` and `docs/protocol.md` §11.6
("Storage failure is described, never silent") both said `unstoredReason`
means the upload did not succeed and the content is gone from the wire. Round
1 added a second producer: a SUCCESSFUL upload whose returned `blobId` makes
the descriptor exceed the inline cap also falls back to `unstoredReason`
(`spill locator too large for maxInlineBytes: blobId <N> chars`), with the
blob still stored. A consumer reading the old wording would conclude the
content was lost when it is in fact in the blob plane, just not addressable
from this event.

Fix: both texts now state that `unstoredReason` means the omitted bytes are
not readable *from this event* — either the upload failed, or it succeeded
but the returned locator did not fit the daemon's inline cap — and that
`spill.blob` is absent either way. The 512-character bound statement in
§11.6 is unchanged.

### Finding 2 — the notes described the superseded skeleton gate

`tasks/notes/20260906-0253-runtime-event-spill.notes.md:78-81` still
described the pre-round-1 gate ("if the event minus the spilled field already
meets or exceeds the cap … forwarded unchanged"). The shipped gate is
`byteLength(skeleton) + MAX_SPILL_DESCRIPTOR_BYTES (768) > cap`.

Fix: the bullet now states the current gate and records the trade it makes —
events whose non-spillable parts land in `(cap − 768, cap)` are forwarded
unchanged and logged, where the old gate would have spilled them with a tiny
preview or driven them into the throw path. Reaching that band needs a
~3.3 KB `tool` name at the 4096-byte minimum cap or ~64 KB at the default,
and it buys a provable bound instead of a reachable throw.

### Evidence (verbatim exit lines, this run)

```
$ bun run build
byok-sdk build: ESM ⚡️ Build success in 18ms
byok-sdk build: Exited with code 0
BUILD_EXIT=0
```

```
$ node scripts/api-surface/check-api-surface.mjs --update --package protocol
api-surface: updated 1 golden(s): protocol
UPDATE_PROTOCOL_EXIT=0

$ node scripts/api-surface/check-api-surface.mjs --update --package cloud
api-surface: 1 golden(s) already up to date
UPDATE_CLOUD_EXIT=0
```

`api-surface/cloud.d.ts` did not move: the cloud golden re-exports the
protocol schema declarations without carrying this jsdoc block, so only
`api-surface/protocol.d.ts` changed (6 insertions, 3 deletions, all comment
text).

```
$ bun run check:api-surface
api-surface: 9 package golden(s) match the built declarations
API_SURFACE_EXIT=0
```

```
$ bun run --filter @byok-sdk/protocol test
@byok-sdk/protocol test:  Test Files  21 passed (21)
@byok-sdk/protocol test:       Tests  356 passed (356)
@byok-sdk/protocol test: Exited with code 0
PROTOCOL_TEST_EXIT=0
```

```
$ git diff --check
DIFF_CHECK_EXIT=0
```

```
$ git diff api-surface/ | grep '^[-+]' | grep -v '^\(---\|+++\)' | grep -v '\*'
(no output — the api-surface diff is jsdoc text only)
```

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
