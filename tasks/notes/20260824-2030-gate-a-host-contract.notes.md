# Implementation Notes: Gate A host contract

> **Status**: Complete
> **Plan**: `plans/plan-20260824-2030-gate-a-host-contract.md`
> **Contract**: `tasks/contracts/20260824-2030-gate-a-host-contract.contract.md`
> **Last Updated**: 2026-08-24

## Frozen Inputs

- GA-01 and GA-02 SHA-256 values have been recomputed from the read-only
  Salesko files and match the supplied subjects.
- GA-02 is intentionally a red pre-fix falsifier: Salesko's current
  `buildDaemonConfig()` lacks `strictAgentOnly`. It may not be edited or
  rehashed. A separate Phase B temporary consumer fixture will set the new
  config value and have its own SHA-256 recorded before it is run.
- Current user release instruction supersedes the earlier suggested 0.9.0:
  package manifests and `bun.lock` stay at their existing versions. A current
  version tarball is only a local RC when paired with frozen source SHA and
  content integrity.

## P1/P2/P3

The complete P1 architecture map, P2 producer-to-local trace, and P3 decision
rationale are in the active plan. They were established before source edits.

## Cost Boundary

The final full build/typecheck/test/pack/consumer sequence may exceed ten
minutes. It will run exactly once after the implementation is committed to a
clean frozen source SHA; focused tests run during development.

## Implementation evidence

- `bun run typecheck` passed after the credential-store, public declaration,
  strict local gate, server routing, and cloud mailbox changes.
- Focused client/server/cloud Gate A tests passed; `bun run test` passed with
  the existing cross-process SQLite test skipped only under the intentionally
  process-local credential test double. Its same-process owner refusal remains
  covered; no user credential provider was touched.
- `bun run build` passed and the built client root declaration only re-exports
  `DeviceEnrollment`, status, and cold-read options; it contains none of the
  secret store, record, auth-manager, or signer names.

## Frozen source and local RC evidence

- Clean source commit: `bdc601aeec27c6bdaae6cc84740ee1ee811cd497`
  (`feat(client): enforce Gate A host contract`). No package manifest or
  `bun.lock` change was made.
- The one post-freeze execution of `bun run build`, `bun run typecheck`, and
  `bun run test` passed. Client: 1,403 passed / 1 skipped; cloud: 210 passed;
  server: 263 passed; protocol: 334 passed. The intentional existing
  cross-process SQLite scenario remains skipped only under the process-local
  credential test double.
- `bun run check:release-graph` passed. The clean-source pack command
  `node scripts/release/pack-and-smoke.mjs --out-dir artifacts/gate-a/bdc601a`
  passed its isolated install/import smoke and wrote all ten tarballs plus
  `release-manifest.json`.
- `artifacts/gate-a/bdc601a/gate-a-manifest.json` explicitly marks
  `unpublishedLocalRc: true`; version identity is deliberately current
  `0.8.1` (`keys` `0.3.2`) and authority is source SHA plus tarball integrity,
  not a registry/runtime version assertion. Packed client declaration and
  dependency readback found no secret internal root export and no file/link/git
  dependency edge.

## Disposable Salesko consumer evidence

- A copied read-only consumer at `/tmp/byok-gate-a-salesko-RZB8ol` installed
  only exact Gate A tarballs through temporary `file:` entries. That copy's
  manifest/lock are not deliverables and will be removed after handoff.
- Frozen GA-01 (`cba060…0a886`) passed: its paired `device.json` contained no
  access token or private-key property. Runtime-session lease consumer also
  passed 6 tests with the exact tarballs.
- Frozen GA-02 (`a3c498…75179`) remains intentionally red: it never sets
  `strictAgentOnly`, so both legacy variants still start the recording adapter
  and create workspace directories. Its contents and hash were not changed.
  The separate archived Phase B subject
  `phase-b-strict-agent-admission.consumer.test.ts`
  (`dee410fe…07f27`) passed both variants: exact tarballs advertised
  `strict-agent-only`, and the producer rejected before durable task creation.
- The unrelated frozen `root-only.falsifier.ts` failed in the untouched Salesko
  consumer because `workspaceRoot`/`storeDir` are not both contained by its
  supplied `SALESKO_HOME`. This is a Salesko host-root contract gap outside the
  two authorized generic SDK changes; do not treat the composite Gate A
  acceptance as complete until its owner resolves or re-scopes it.
- `repo-harness run check-task-workflow --strict` passed after evidence
  scaffolding. Independent review/semantic acceptance has not been authored by
  this implementation worker.

## Primary-agent takeover review

The worker result was treated as implementation evidence, not acceptance. A
manual source trace found two defects that its green suite did not exercise:

- the Windows bridge returned an additional base64 wrapper while the common
  decoder expected the owned UTF-8 envelope; every real Windows read would
  therefore fail;
- secret bytes and enrollment metadata were committed to separate authorities,
  so a crash or failure between writes could combine a token/private key from
  one pairing response with device/tenant/public-key metadata from another.

The takeover correction makes one OS credential entry contain the complete
validated enrollment record. `device.json` remains a deterministic non-secret
projection: pair writes the projection before the authoritative OS replace,
restart repairs missing/stale projection from the OS record, renewal replaces
the complete record, and status never derives paired identity from the file.
Focused fault-injection now covers failed OS replace, failed projection write,
projection-loss repair, Windows UTF-8 round-trip, and Linux provider-error
classification. No real user credential provider was touched.

### Replacement frozen source and RC

- Corrected source commit: `ff89d99cdab37a8a6ddb82bc21261861a95bfac8`.
- Post-freeze `bun run build`, `bun run typecheck`, and `bun run test` passed.
  Client was 1,408 pass / 1 intentional skip; cloud 210, server 263,
  protocol 334, and every other workspace suite completed successfully.
- Replacement unpublished RC: `artifacts/gate-a/ff89d99/`. Its release
  manifest SHA-256 is
  `4dc7a968eed84291deb9bb068f60fccf1355db8b77b5525ec870cf814a072b1a`;
  package versions remain 0.8.1 and keys 0.3.2, so source SHA plus integrity
  are the artifact authority rather than the colliding version string.
- Disposable exact-tarball Salesko consumption passed 9/9 across GA-01, the
  separate Phase B strict producer subject, and runtime/session/lease. Frozen
  subject hashes were recomputed unchanged. The known Salesko root-only
  blocker was not rerun because the replacement RC does not alter host-root
  composition. The disposable copy was moved to Trash and is recoverable.

## Salesko Gate B2 relocation handoff

- Frozen downstream subject:
  `sha256:ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`.
  Its exact local-RC pre-fix command exits non-zero because the high-level
  primitive is absent.
- A service-manager status check is not a mutation authority. The SDK must
  serialize relocation against the same store and Agent-home writer publication
  paths used by real daemons, including foreground execution.
- Public scope is deliberately narrow: `localStateRelocation.acquire(...)`
  returns an idempotent lease. Internal daemon-owner acquisition, marker
  parsing, endpoint selection and stale-state classification remain private.
- The host may adapt public naming in its consumer adapter, but semantics are
  fixed: exact paths, no destination tree effect, active/unknown/corrupt
  refusal, no scan-then-writer race, opaque SDK state and exact release.

## Gate B2 source implementation

- `localStateRelocation.acquire()` is the only new public coordinator. Store
  owner internals, marker readers and gate endpoints remain private.
- One fixed OS-temp path-mutation gate now covers daemon/store owner publish
  and release, Agent-home directory materialization/preflight, and Agent lease
  marker publication. Relocation acquires the same four source/destination
  gates in deterministic identity order and holds them for the host transaction.
- The prior synchronous strict-Agent preflight could create the branded root
  before daemon ownership and could not participate in an async cross-process
  gate. It is now non-mutating construction validation; the existing async
  writable preflight remains after daemon ownership and before transport or
  capability publication.
- The first frozen full run exposed one direct concurrency regression: eight
  simultaneous content-read root resolutions treated the brief internal gate
  as relocation contention. Internal writers now use a bounded wait on the
  same gate, while relocation acquisition remains fail-fast; a long relocation
  still ends in typed fail-closed refusal rather than a fallback path.
- Focused client verification then passed 48/48 across relocation, Agent home,
  content read, strict admission, public-surface constraints and daemon-owner
  collision. Client TypeScript passed. The full workspace/artifact envelope is
  rerun only after this corrected source subject is frozen.

## Gate B2 frozen source, packed RC and consumer acceptance

- Corrected relocation source is frozen at
  `7edb05440df74406547071bce74ae4f41a87184a`, after
  `66fa655f0b4afc514d6115af00c10304a6bc04fb` added the exclusive relocation
  lease and `7edb05440df74406547071bce74ae4f41a87184a` serialized brief Agent-root
  writers without changing relocation's fail-fast behavior.
- Frozen full BYOK verification passed: `bun run build`, `bun run typecheck`,
  `bun run test`, `bun run check:release-graph`, strict task workflow and
  `git diff --check`. Client completed 1,413 pass / 1 intentional skip; the
  remaining package suites also passed.
- `artifacts/gate-a/7edb054/` is an unpublished local RC. Its release manifest
  SHA-256 is
  `e80e3b9759cf100c8a50a76bb52c9d22b2a591a356336bcd2bc42ef06d889c90`;
  packed client SHA-256 is
  `96bece951f62b723e919481e6a8cd53fcf4787b2999d1d3115c04d3169a6b8e6`.
  Package version identity remains 0.8.1 and keys 0.3.2, so source SHA plus
  content integrity are the authority; no registry or release claim is made.
- The packed client declaration exposes only `localStateRelocation` and typed
  relocation errors. Internal path gates and daemon-owner operations remain
  private.
- A disposable Salesko copy consumed only the exact tarballs. Frozen relocation
  subject `ba94b50f...0488` passed 1/1 with 7 assertions; the existing Gate B
  focused matrix passed 45 with one intentional Postgres skip; Local Agent
  TypeScript passed; full root `bun run check` passed with exit 0. Exact results
  are recorded in `artifacts/gate-a/7edb054/salesko-consumer-results.md`.
- The disposable copy is not an artifact authority. It will be moved to Trash
  after evidence is frozen; neither Salesko manifests/lock nor either source
  worktree contains a `file:` dependency.
- Independent semantic review for the composite Gate A work package remains a
  separate acceptance authority. This implementation and downstream packed-RC
  result do not self-approve publication, merge or rollout.

## Independent gate symlink finding and replacement RC

- The first independent semantic gate rejected source `7edb054`: requested
  roots were canonicalized through `realpath` before symlink validation, so a
  lexical alias could be accepted while the lease returned that alias to the
  host. The existing reverse-order test incorrectly encoded this acceptance.
- Replacement source `64cd0607fd4a4e32986623eb25c513a3f81cd84a`
  validates every requested absolute root before canonicalization and again
  after the four mutation gates are held. A changed canonical target or any
  symlink component is a typed integrity refusal before destination effects.
  Canonical paths remain internal gate identities only.
- The replacement test covers each of the four requested path inputs and keeps
  reverse-order deadlock serialization as a separate case. Focused client
  verification passed 49/49; full build, typecheck, tests, release graph,
  strict workflow and diff check passed. Client completed 1,414 pass / 1
  intentional skip.
- Replacement unpublished RC is `artifacts/gate-a/64cd060/`. Its release
  manifest SHA-256 is
  `6aa12cb3196968f0546f83af8c9c2f89688485596b25314eee46af6e53c6bc79`;
  client tarball SHA-256 is
  `0d7fa125a8025b324a4aa4d69f8cc5e77fb3ceb4e2789eb1df59611a2350c621`.
- The frozen Salesko subject remains `ba94b50f...0488`. macOS's default test
  temp spelling begins at symlink alias `/var`; the fixed SDK correctly refused
  the first attempt. Re-running the unchanged frozen consumer with canonical
  `TMPDIR=/private/tmp` passed 1/1, the focused matrix passed 45 with one
  intentional Postgres skip, Local Agent TypeScript passed, and root
  `bun run check` passed. This fixture environment is recorded in the artifact
  result rather than hidden by weakening product symlink refusal.
- The prior `7edb054` packed RC and acceptance result are superseded. Neither
  RC is published or a committed Salesko dependency. A fresh independent gate
  must review `64cd060` before composite acceptance.
- The fresh independent Gate B2 re-review returned PASS and is projected in
  `tasks/reviews/20260824-2030-gate-a-host-contract.review.md`. It rechecked the
  corrected source, focused alias matrix, packed declaration/integrities and
  frozen Salesko subject. This closes relocation semantic acceptance only; the
  plan's older whole-package Gate A review row remains separate.

## Whole-package independent finding and replacement RC

- The first independent whole-package gate rejected the prior subject with two
  HIGH findings. First, raw lexical `.` and `..` path segments were normalized
  away by `path.resolve()` before relocation validation. Second, a valid OS
  credential authority caused status/restart to hide or repair a legacy
  secret-bearing `device.json` instead of requiring explicit re-pairing.
- Corrected source `9377594ca6798e1d5726ffbef56ec45194cfca44`
  rejects lexical dot segments for all four relocation inputs before
  normalization. It validates the bounded projection before paired status and
  lets `DeviceRecordRePairRequiredError` propagate through restart; only a
  missing or valid-but-stale non-secret projection remains repairable.
- Focused correction verification passed 56 tests with one intentional skip;
  client TypeScript and `git diff --check` passed. The frozen full BYOK
  build/typecheck/test/release-graph/strict-workflow envelope also passed.
- Replacement unpublished RC is `artifacts/gate-a/9377594/`. Its release
  manifest SHA-256 is
  `c026228ab6737189a757ccf51a0b705f0cca3974e9028529a2e8de03058c3ee9`;
  packed client SHA-256 is
  `dbf420203d5e485c1a3fd6c3d2eeab65db06c1244bbd8b6bd64f8677f60368e6`.
  Versions remain 0.8.1 and keys 0.3.2, so source SHA plus integrity remain the
  artifact authority; no registry assertion is made.
- A fresh disposable Salesko copy consumed only these exact tarballs. The
  unchanged relocation subject `ba94b50f...0488` passed 1/1 with 7 assertions,
  the Gate B matrix passed 45 with one intentional Postgres skip, Local Agent
  TypeScript passed, and canonical `TMPDIR=/private/tmp bun run check` exited
  0. No deliverable manifest or lockfile contains a `file:` dependency.
- This evidence is ready for a fresh independent whole-package re-gate. It does
  not self-authorize merge, push, publication, downstream pin, release, deploy,
  migration or production cutover.

## Whole-package independent acceptance

- The fresh independent whole-package re-gate returned PASS against evidence
  HEAD `df1e7a92def2f18d81e7b8eccc99723e7247c6f2` and implementation
  ancestor `9377594ca6798e1d5726ffbef56ec45194cfca44`. It confirmed the
  worktree was clean and unmoved at the end of review.
- The reviewer traced the OS credential authority, legacy-projection refusal,
  strict local and producer admission, and relocation path/lease lifecycle. It
  also checked ten packed tarballs against both SHA-256 and SHA-512 manifest
  values and confirmed the public declaration stays bounded.
- Independent focused execution passed client 31/31, server 2/2, cloud 14/14,
  client TypeScript and `git diff --check`. The exact source's previously
  frozen full build/typecheck/test/release-graph/strict-workflow evidence was
  reused because an external worktree cleanup removed ignored harness runtime
  inputs; this was recorded as an evidence-availability boundary, not treated
  as a product test failure.
- Source-ready and unpublished packed-RC acceptance are complete. Merge, push,
  registry/npm publication, Salesko exact pin/release, deploy, migration and
  production remain separate unexecuted authorities.
