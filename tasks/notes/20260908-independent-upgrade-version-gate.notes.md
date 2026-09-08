# Independent upgrade admission verification

Base: 62e83ae9ac76e38b5448307fec02850f780d7347. Isolated candidate; original
SDK/Salesko worktrees and production state remain untouched.

## Root Cause Evidence

- root_cause: envelope v accepted any integer; hello version advertisement did
  not constrain later messages, and the exported cloud entrypoint bypassed the
  HTTP schema entirely.
- repro: real paired long-poll v2 known offer reached onEnvelope/cursor; v2
  claim was HTTP-accepted and changed lifecycle state. Direct inbound also
  accepted it. Consumer regressions failed before source changes.
- regression_guard: protocol validation for 0/-1/2/99; client next-poll semantic
  barrier plus retained-offer v1 control; cloud HTTP/direct rejection plus
  same-envelope-id v1 claim control.
- pre_fix_failure_artifact: docs/researches/evidence/independent-upgrade-20260908/version-pre-fix.log.

## Local source acceptance

Node 22.22.3 / Bun 1.4.0. Build, typecheck, API surface (all nine goldens),
version authority, release graph and strict task workflow passed. Full root
test: **3890 passed, 135 skipped, zero failed**. Focused new consumer guards:
client 1 passed, cloud 3 passed; protocol validation/freeze guard 67 passed.
No golden was regenerated and the public v type remains number.

The first API check exposed TypeScript's inferred type predicate on the refine
callback; an explicit boolean return annotation preserves the existing public
shape. A test closure also needed an explicit non-null assertion for its setup
server. These two type-only edits produce byte-identical runtime JavaScript
across all 23 built package JS files; equivalence is recorded in evidence.
Final build/type/API checks were rerun; the successful full test was retained
instead of rerunning the same runtime just for erased type annotations.

The correction rejects unsupported versions; it does not add a new wire refusal
enum. HTTP consumers retain the existing generic 400/rejected contract. Cross-
release product acceptance remains limited by the unspecified old artifact.

## Delivery boundary

The research return file owns the matrix and host usage. The standard local
pack-and-smoke output will bind its own manifest to the frozen source commit;
its receipt is separate from source acceptance and registry publication. No
push, merge, npm publish, tag, Salesko mutation or production action is included.

Standard pack-and-smoke passed for all ten packages from source
6bcf659874be14ed27378d6dcb635a8a9a23a258, with isolated npm exact-edge readback.
A separate probe loaded the actual protocol/cloud tarball bytes and proved v1
decode plus v2 rejection before cloud store access. It reused the tested external
zod/hono dependencies; it is not another claimed isolated install. All hashes,
internal edges and local file pins are in the research delivery receipt.
