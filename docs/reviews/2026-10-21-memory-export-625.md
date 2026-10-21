# Issue 625: bounded task-free local Host memory export

Baseline: `742295a4a97a8c1de5b2ab55c827ac2f73cb07cc` (fresh origin/main).
Issue: https://github.com/Ancienttwo/byok-sdk/issues/625

The baseline exposes only task-context snapshot capture and redacted hosted
projection, not a task-free raw Host export. This implements the issue's Plan B
as an optional in-process daemon method. It reuses the home writer lease,
task-free skeleton initialization and existing pinned memory filesystem; it does
not forge a task or alter hosted projection's raw-data prohibition.

The implementation scope and digest format are specified in docs/spec.md.
Requested profile identity is distinct from optional locally observed projection
revision. No global current-profile claim is possible when no projection record
exists. Only memory paths admitted by existing recall/save policy are captured.
No operational export, user-memory read, upload, restore, real daemon start or
private downstream repository access was performed.

## Validation

- Workspace build: passed.
- Pinned macOS helper build and reproducible release artifact checks: passed.
- `BYOK_REQUIRE_MEMORY_EXPORT_TESTS=1 bun run --filter @byok-sdk/client test -- src/__tests__/agent-memory-export.test.ts`: 8 passed, no skips (local macOS arm64, real release helper, synthetic temporary homes).
- Regression cases: empty-home SHA-256, no network/task/projection/audit effects,
  memory_save exact revisions, independently computed stable sorted-tree digest,
  active writer typed busy, observed profile mismatch, file/byte limits with
  lease recovery, opt-in omission, pre-abort and mid-operation abort cleanup.
- Workspace typecheck: passed (initial test-only missing `this` annotation fixed).
- Affected existing suites (`agent-memory-mcp`, `agent-memory-embedded-entry`,
  `agent-memory-entry-constraints`, `agent-memory-intent`, `agent-memory-windows-gate`):
  136 passed, 27 existing platform-specific skips, five files passed.
- After the final lightweight constants import, native export plus entry-constraint
  tests: 17 passed, no skips (2.47 seconds).
- API surface and version-authority checks: passed. New limits use the existing
  protocol/constants leaf; importing the protocol root was rejected by the
  lightweight entry gate and corrected. No dependency prohibition was relaxed.
  Exact measured closure budgets: agent-memory 67,427 bytes (364 above prior
  budget); protocol 127,572, cloud 533,880, cloud-dataplane 783,752, ui-runtime
  562,140 (each 181 bytes above prior budget from the two exported constants).
  API declarations and generated README budget table are updated.
- CI adds a dedicated Linux native-descriptor qualification job and a required
  export test step to both macOS helper jobs. Missing backend fails those gates
  via BYOK_REQUIRE_MEMORY_EXPORT_TESTS=1; ordinary unsupported local environments
  retain an explicit skip. Actual Linux and hosted macOS outcomes pending.
- No duplicate full workspace suite was launched. Windows export remains refused;
  no cross-device restore or Windows admission is claimed.

Independent review: review_604 approved source, tests, documentation, native CI
and exact closure-budget changes with no actionable findings. The parent approved
commit/push as Draft; hosted platform qualification remains pending.
