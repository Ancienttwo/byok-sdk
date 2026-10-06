# Native SDK interaction contract

Base: `Ancienttwo/byok-sdk` main `329780b6562706f1ae57d1970cc1d77bf35738b5`.

## Boundary

Add a process-lifetime, local SDK interaction contract independent of ordinary text steering and the remote task approval stream. Native runtime request IDs retain their wire type. Every process receives a new SDK generation, including a process that resumes an existing provider session. Do not replay a prior process's pending approval.

No Pi custody/identity, core/cloud coordination, egress, unpublished audit patches, new dependencies, real provider calls, credentials, publication, or deployment belong to this slice.

## Task Breakdown

1. Qualify upstream request and reply protocols from official, pinned sources. Never advertise unavailable support.
2. Implement immutable request/response types, explicit capability vocabulary, bounded pending state, one-shot replies and process-lifetime invalidation.
3. Integrate only independently verified native adapter protocols. Keep the remote Host transport and legacy boolean approval contract explicitly separate.
4. Fixture-test repeat answers, conflicting answers, malformed answers, cancellation, timeouts, uncertain writes, process exit and resume boundaries.
5. Run applicable build, typecheck, tests, API surface and version authority checks. Report unsupported and unrun scope.

## Ownership

Production interaction contract, exports and runtime adapter integration belong to the native interaction implementation. Capability matrix and reusable conformance fixtures are a separate disjoint reviewable slice. No cross-package runtime dependency is introduced.

## Foundation checkpoint (812f9e11)

The local controller, typed channel, optional descriptor capability and Session
seam are implemented. The controller fixtures cover 47 cases. Independent
review drove additional regressions for cancelled in-flight write ownership,
capacity reservations, fatal-once disposal, inert optional fields and async
observer failures.

No bundled provider bridge is implemented or advertised. Required native reply
schema qualification remains incomplete; retain unsupported capability rather
than invent an approval/question transport. Host reconnect and persisted
snapshot recovery remain outside this local process-lifetime contract.

- PASS: full workspace build (with private `XDG_CONFIG_HOME` for Wrangler).
- PASS: full workspace typecheck, after the build completed.
- PASS: 47 native controller tests.
- PASS: version authority and whitespace checks.
- PARTIAL: 135-test native/Claude/Codex/control regression run: 130 passed,
  5 failed at the cloud environment's existing trusted launcher requirement
  (`launch_cwd_shell_not_root_owned`). No launcher policy was weakened.
- FAIL, existing base drift: aggregate API-surface gate reports the main
  branch's pre-existing ClaudeProcessClient declaration changes and cloud
  `readBoundedRawBody`/`cancelBody` additions missing from their goldens.
  The feature's client golden delta contains only the new native seam.
- NOT RUN: full workspace test aggregate, live provider calls, external API
  integration, real desktop resume, persistent Host recovery and held audit
  probes. No full acceptance claim follows from focused fixture tests.

This is a local unpublished feature foundation. Release-version selection and
publication remain separate decisions; an additive public feature requires the
repository's next appropriate minor release, not a patch-only release.


## Provider bridge and conformance completion

The approved official-source read succeeded. Claude Agent SDK Python sources
were additionally checked byte-for-byte against commit
`1cc862c469aaf4c738285be745ab12f980a11dbe`; Codex schemas are pinned to
`rust-v0.160.0`. T3 remains a design reference, with no copied implementation.
The new source inventory records exact hashes and URLs.

Claude and Codex now expose the native channel only under explicit local Host
opt-in, with adapter-owned disposal and no remote boolean approval fallback.
Claude offers one-shot approval only and never writes persistent permission
rules. Codex preserves native once/session scope, validates policy readback and
active/resume identities, and awaits acknowledged native response writes.
Readonly/plan/confirm policies cannot be overridden by the Claude approval
callback; exact task tool grants are enforced. Pi remains unsupported.

Independent review found and drove regressions for uncertain native writes,
provider-cancellation races, exact turn and resume identity, and refused-prompt
cleanup. The corrected scoped bridge/transport run passes 132/132 tests and the
OAR source/declaration bridge guard passes 2/2. The prior run's only remaining
failure was the maintained vendor inventory expecting five source deltas; the
explicit inventory now correctly records six, including open.ts.

The disjoint four-file conformance change from commit
`d3c43f24586659dc5c2d30c89d2283a31728ce2c` is integrated. Its default-mode
capability assertions remain unchanged; the capability matrix now additionally
states the actually tested enabled-mode behavior. Host reconnect is a proposed
next repository-specific task, not implemented by native session resume.

Final integrated fixture verification: 228/228 tests across 15 files pass in one
sequential run, including the 26-case capability conformance suite and native,
control-channel, acknowledged-write, startup, permission and OAR coverage.
The first integrated run exposed default sessions carrying an undefined
`interactions` property; the adapters now omit that property when disabled,
without weakening the conformance assertions. This remains fixture-only
qualification; full workspace tests, real providers and Host recovery are not
claimed. The unchanged-source API golden mismatch and previously observed
trusted-launcher environment failures remain explicit validation limits.
