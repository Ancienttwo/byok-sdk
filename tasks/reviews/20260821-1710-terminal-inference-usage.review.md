# Review: terminal-inference-usage

> **Status**: Source review passed — strict workflow environment blocked
> **Plan**: `plans/plan-20260821-1710-terminal-inference-usage.md`

## Review Boundary

- One bounded, optional protocol object across complete/fail/cancelled.
- No inferred provider/model or zero-filled metrics.
- `clientVersion` is consumed only from the U4a-frozen release identity.
- Winning cloud receipt projects a typed object, with no storage-usage coupling
  or raw-receipt caller parsing.

## Result

- No P1/P2/P3 findings in the reviewed U2 diff.
- The initial full client run exposed three pre-existing exact-payload
  assertions that confirmed the correct omission rule: a runtime with no
  native `usage` event (Pi) must omit the entire optional block. The final
  implementation and targeted regression test preserve that rule.
- Build, typecheck, and full test passed locally. `check-task-workflow --strict`
  cannot start task validation until the repository-owned `.ai/harness/`
  directories exist; they are outside this U2 write contract. Package artifact
  readback remains pending a clean committed worktree.
