# Pre-fix failure: quiescent runtime disposal

- Base: `069f3fc781f7cfc20dd935a38e7343493ae31722`
- Regression guard: `packages/client/src/__tests__/runtime-process-tree.test.ts`
- Command: `pnpm --filter @byok-sdk/client exec vitest run src/__tests__/runtime-process-tree.test.ts`

Observed on the unfixed Row 2 base after adding only the real process-tree
fixture and regression guard:

```text
FAIL  src/__tests__/runtime-process-tree.test.ts > bundled runtime process-tree disposal > Pi close resolves only after its real root and descendant are both gone
AssertionError: expected true to be false

- Expected
+ Received

- false
+ true

at src/__tests__/runtime-process-tree.test.ts:54:46
Test Files  1 failed (1)
Tests       1 failed (1)
```

`Session.close()` returned while the reported runtime root PID was still
alive, so it could not possibly be a child-plus-descendant quiescence receipt.

PRE_FIX_EXIT=1
