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

## Implemented scope and verification

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
