# Nightly Windows ACL cold-start outlier (#1123)

## What failed

- Run 41143045892 (schedule, head cbc13abc6), job 124361684420,
  `npm release pack/install (windows-latest, fixed Node)`.
- Step: `Check graph, pack, and install as a freshly created NON-administrator local user`.
- Suite: `packages/keys/src/pi-projection-windows.test.ts`, 5 failed / 3 passed.

| Case | Observed | Verdict |
| --- | --- | --- |
| cold positive (`[pi-acl-positive-cold]`) | no stdout; killed at 29,817ms; watchdog 29,741ms | failed |
| warm positive (`[pi-acl-positive-warm]`) | killed at 4,759ms; watchdog 4,750ms | failed |
| external Allow ACE | 5,004ms | vitest timeout |
| real directory owner | 5,001ms | vitest timeout |
| directory junction | 5,006ms | vitest timeout |
| non-ASCII path | 2,309ms | passed |
| shadowed PSModulePath | 322ms | passed |
| missing directory | 397ms | passed |

File total: 54,148ms. The monotonic warm-up (first probe >29.7s, second >4.7s,
then three passing cases at 2,309ms / 322ms / 397ms test duration) is the hosted
runner and the freshly created local account paying their one-time Windows
PowerShell first-use cost; no ACL assertion failed. The last three cases
exercised the same product query and passed.

## Control

PR #1164 (Draft for #1160) ran the same lowpriv Windows job from main plus a
mailbox change and passed in 16m53s:

- run 41166896788, job 124436342863.

That is the same keys ACL path, the same fresh non-administrator account and
the same 30s cold bound. It shows the nightly trace is an environment/load
outlier, not a product ACL regression.

## Decision

- Keep the cold case bound to the client's 30s startup deadline
  (`startupTimeoutMs ?? 30_000` in
  `packages/client/src/daemon/task-runner.ts`). Do not raise it above the
  product deadline.
- Do not add a Windows PowerShell prepay to the lowpriv step. The cold case
  exists to prove the product pays the account's real first use; a prepay
  would hide the risk (#462/#469).
- Do not change ACL assertions, negative cases, or product ACL semantics.

The change made here is test instrumentation only: the budgets were extracted
to `packages/keys/src/fixtures/acl-evidence-budget.ts` and a cross-platform
regression (`packages/keys/src/__tests__/acl-evidence-budget.test.ts`) pins the
cold watchdog strictly inside the 30s client deadline and the warm/teardown
budgets inside Vitest's defaults. A future silent budget relaxation now fails
on every platform.

## Next

Rerun the nightly. If the cold case reproduces at ~30s on a second isolated
run, treat it as a policy decision with fresh evidence (hosted Windows
first-use cost vs. the product's 30s startup deadline), not as a reason to
weaken the test.

## Local evidence (macOS)

- `bun run build`: passed.
- `bun run typecheck`: passed.
- `bun run --filter @byok-sdk/keys test`: 929 passed, 12 skipped (8 Windows ACL
  cases and 4 Windows credential-custody cases skip on non-Windows).
- `bun run test:scripts:ci`: 195 passed, 1 skipped.

Windows ACL behavior cannot be verified locally; the rerun is the proof.
