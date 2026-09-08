# Embedded operator APIs independent acceptance

Status: accepted after reviewer-prescribed safe_auto documentation correction; release unverified.

Reviewer: isolated read-only `operator_acceptance` gatekeeper. Initial verdict FAIL with one HIGH finding: README described unpublished 0.16.0 / keys 0.4.2 as latest published and linked candidate release notes/Release. No additional source blocker found.

The orchestrator applied the exact requested correction: explicitly unpublished source candidate, previous verified 0.15.0 / keys 0.4.1 release references, and install command conditional on future publication. Version-authority, local release-link existence/status assertions and git diff --check passed. Source logic did not change; no second full review was required. Final acceptance is the orchestrator's disposition after this delta, not a fabricated second reviewer PASS.

## P1 / P2 / P3
P1: diagnostics and AgentMessageOutbox retain storage ownership; host retains service lifecycle and confirmation.
P2: reviewer traced public entry -> tenant/device/Agent binding -> device and Agent leases -> durable audit -> live-log replacement. Held/draft records remain live; errors and unsafe input fail closed.
P3: reuse owning implementations and a closed public error contract; no new dependency or compatibility authority. New runtime/test files and scope artifacts are justified in the research report.

## Evidence
- Actual working diff and two untracked source/test files reviewed at base 9de5e12509f2c3823b22f568a8cbe04edf89b718.
- Independent command: `npx --yes node@22.22.3 node_modules/vitest/vitest.mjs run packages/client/src/__tests__/operator-actions.test.ts` — 1 file / 7 tests passed.
- Existing 3923 passed / 135 skipped full suite, build/typecheck/API/version/workflow and compiled smoke evidence reused after source, log and binary hashes matched. README is the only change to that frozen subject, covered by delta checks above.
- Detailed hashes and finding disposition: `docs/researches/2026-09-08-embedded-operator-apis.evidence.json`.

## Remaining release boundary
No clean committed candidate, official release-pack/isolated registry-install, live-device, OS credential or hosted CI proof is claimed. No commit/push/merge/publish/deploy occurred in this acceptance slice. Next bounded slice: freeze a clean local candidate and run official `bun run check:release-pack`; publication and Salesko exact-pin remain later boundaries.
