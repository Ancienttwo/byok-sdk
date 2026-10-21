# Issue 632: bounded K4 tree restore coordinator

Dependency: Draft PR #644 / `7f5c9c32c1ce03eb1769571f4e6708612c6f6d44`
(task-free export, issue625), itself based on main742295a4.
Issue: https://github.com/Ancienttwo/byok-sdk/issues/632

Scope: synthetic-only K4 restore admission, durable queue gate, per-file CAS
intent orchestration and terminal aggregation. No operational backup, user memory,
private downstream repository access, upload or Windows admission.

The README records the complete contract: exact approved observation and digest,
initial nonempty-tree zero-write conflict, overwrite missing-note deletion,
preparing cancellation and late-result fence, same-id recovery, shared ledger
instance, and no cross-file filesystem atomicity. The gate covers K4 execution
only. All per-file durable terminals are required before it releases, including
explicit uncertain outcomes; no automatic new CAS is attempted after conflict.

## Validation

- Workspace build passed.
- Initial new restore + existing memory suites:36 passed.
- Synthetic restore suite with four owned Host fixture processes SIGKILLed after
  gate/preflight/intentcommit/first-readback stages:13 passed. These are actual
  process deaths against temporary SQLite, with simulated per-file completion;
  they are not claims of daemon/OS/power-loss recovery.
- Final affected restore/memory/core suites:58 passed, no skips (17.10 seconds).
- After independent review moved core ledger binding after configuration
  validation, final restore suite:16 passed, no skips (1.72 seconds), including
  failed-construction cleanup, shared-ledger and malformed-export regressions.
- Workspace typecheck, API surface and version-authority checks passed. Final
  affected-package typecheck and diff whitespace check also passed.
- Linux embedded notification/CAS/export tests added and required in CI. Locally
  unrun on macOS; no Linux result claimed. They separately exercise queued-task
  exclusion, three-file initial restore, Host-ledger reopen between notices,
  duplicate notice, nonempty initial zero writes, overwrite and omitted-note
  deletion. Hosted outcome pending.
- No duplicate full workspace suite launched.

Independent parent review found one lifecycle issue: binding registration preceded
core configuration validation. Registration now follows validation and a focused
regression proves failed construction leaves no binding. Parent review approved
the final source after that fix and the 58/16 test evidence.

Release-candidate freeze: the parent authorized a local-only commit for isolated
integration on the #625 dependency. No #632 push, PR or CI run is authorized or
triggered. Actual Linux qualification will run once on the combined exact HEAD;
these local results do not qualify that future combined tree.

Release limitations: this restores only the bounded admitted memory tree, not
all user data. It is not a filesystem-wide atomic transaction or rollback;
external writers may produce partial CAS outcomes. Windows memory admission,
real-user restoration, and full cross-device deployment are not qualified.
Linux embedded notification/export integration remains an explicit release gate.
