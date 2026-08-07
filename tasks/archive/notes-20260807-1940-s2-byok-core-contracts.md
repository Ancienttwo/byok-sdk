> **Archived**: 2026-08-07 19:40
> **Related Plan**: plans/archive/plan-20260807-1829-s2-byok-core-contracts.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260807-1940

# Implementation Notes: s2-byok-core-contracts

> **Status**: Active
> **Plan**: plans/plan-20260807-1829-s2-byok-core-contracts.md
> **Contract**: tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md
> **Review**: tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md
> **Last Updated**: 2026-08-07 19:55
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| C-001/C-002 | `859ef81` | Scaffold (zod-only deps, sibling idiom, `tsup platform: 'neutral'`); branded `TenantId` + single mint point `tenantId()`; `DevicePrincipal`/`ControlPlanePrincipal`; error taxonomy skeleton; lockfile |
| C-003~C-008/C-010 | `df58dbb` | Tenant-first async store ports: Mailbox (read-does-not-ack / cursor-ack), Board (5-state vocabulary + transitions, claim/`expectedStatus` CAS, per-tenant `board_seq`, conflict snapshots), Truth (terminal first-hash-wins + `terminal_conflict`, `expectedRev` CAS, manifest), Presence/Activity (TTL + explicit `dropped`), Blob/Object metadata (`sha256:` address, object state machine), Quota (§12.7.6 shapes verbatim incl. `bigint` + version CAS, reserve→finalize/abort, five stable `storage_*` codes), capability declaration schema |
| C-009 | `3dc4efc` | `DeviceProofEnvelopeV1` schema (§S6.2 protected claims), dependency-free JCS-style canonicalizer (UTF-16 code-unit key sort; floats/unsafe ints/NaN/Date/Map/bigint fail closed), `byok-device-proof-v1\n` prefix, injectable `ProofVerifier` port, canonical-bytes golden at `src/__tests__/golden/device-proof-v1.canonical.json` |
| C-011 | `8f39ceb` | InMemory reference for all seven ports (injected mutable clock); `runCoreConformance(name, factory)` — 51 assertions (mailbox 6, board 7, truth 5, presence 2, activity 2, objects 4, quota 10, port inventory 8, tenant isolation 7); constraint tests 65 (dependency isolation, frozen public surface, I7 inventory, mint-point grep, vocabulary isolation, quota vocabulary, proof constraints) |
| docs | (docs commit, see git log) | Architecture §12.1 core → implemented/isolated, §1.2 five-package table, status annotations on §12.2/§12.3/§12.6.3/§12.7.6-7; `machines.list()` todos row ruled host-global by design |

## Design Decisions

- **`tsup platform: 'neutral'`** (deviation from the keys idiom, ratified): core must load in Workers compositions; `neutral` turns an accidental Node builtin into a build error instead of a runtime crash. Everything else mirrors the sibling packages.
- **Conformance factory contract**: `create() → { stores, now(), advanceTime(ms), dispose? }`; assertions are fixed, compositions only provide the factory — the in-memory integration is 25 lines with zero assertions, which is the shape S4A's Postgres+R2 run must reuse unchanged.
- **`TenantScopedStores` facade deliberately not defined**: §12.6.2 layer 2 is shaped by how handlers are written, and the first handlers are S3's `@byok/cloud`; freezing a guess now would put a wrong contract under every later sprint. `stores.ts` documents the decision in place.
- **Per-tenant hash dedup lives in `QuotaStore.finalizeReservation`**, not ObjectStore: usage accounting is what dedup exists for (§12.7.6 "同 tenant 同 hash 多 reference 只計一次"), and it keeps the counted-once invariant assertable against one port. SQL compositions implement it as a join against `object_manifest`.
- **Canonicalizer accepts only strings/booleans/null/safe integers/objects/arrays** — floats, unsafe integers, `NaN`, `Infinity`, `undefined`, `bigint`, `Date`, `Map`, functions, symbols, and circular references all raise `proof_canonicalization_failed`. The golden pins three claim sets (method+path, operationId+expiry+nonce, non-ASCII with embedded NUL); regeneration uses the protocol freeze-guard idiom (`BYOK_CORE_UPDATE_GOLDEN=1`).
- **Two error codes beyond the pinned list** (`board_item_exists`, `hint_ttl_invalid`) needed by the reference implementation; both live in the single taxonomy.
- **`Date.now()` banned inside core** (constraint test): all time flows through the injected clock, which is what makes TTL and CAS behavior deterministic in the suite.

## Deviations From Plan Or Spec

- The architecture-event hook did **not** fire for `packages/core/package.json` (no request card generated); the plan's card-closure story is therefore a no-op. Verified: `docs/architecture/requests/` unchanged.
- Existing packages byte-identical to main, machine-checked: `git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ packages/client/src/ examples/` clean.
- Per-commit typecheck of the four progressive `index.ts` states is inferred (sliced at module boundaries), only the final tree was verified.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Conformance as public subpath export | Rejected | S2.2 constrains the public API; sprint S2.3 tree puts it under `src/__tests__/conformance/`; S4A story O-005 owns its packaging |
| Crypto verify inside core | Rejected | Breaks Node-free; Workers/Node crypto differ; injected `ProofVerifier` port instead |
| Migrate server's `TenantId` alias now | Rejected | S2.4 forbids touching existing packages; S3+ migrates when server first imports core |
| JCS via a dependency | Rejected | Node-free/Workers-safe and zero new deps outweigh reimplementation cost; scope restricted to the shapes the envelope allows |

## Open Questions

- None blocking. S3 must define the `TenantScopedStores` handler facade and decide the conformance suite's packaging for out-of-repo consumers (S4A O-005).

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run evidence (after `8f39ceb`): `pnpm -r run typecheck` 7 projects clean; `pnpm -r run test` core 162 / keys 328 / protocol 189 / server 216 / client 873 all green; `pnpm -r run build` 5× success with full `.d.ts` tree; protocol golden dir clean; existing-packages zero-diff vs main clean. Conformance 51/51; constraints 65/65; canonicalizer golden regeneration idempotent (no diff).
- Full-repo gates re-run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- "Constraint tests over comment-stripped source let a module document forbidden vocabulary without tripping its own scan" — candidate for `tasks/lessons.md` if the pattern recurs in S3's route-inventory tests.
