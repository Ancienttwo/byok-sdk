# Pre-fix regression evidence

- Regression guard: `packages/cloud-postgres/src/__tests__/conformance.test.ts`
- Command: `BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm --filter @byok-sdk/cloud-postgres exec vitest run src/__tests__/conformance.test.ts -t "persists the exact sequence encoded into an offer envelope"`

```text
FAIL src/__tests__/conformance.test.ts > Postgres offer delivery composition > persists the exact sequence encoded into an offer envelope
ByokCloudError: Mailbox numbered this offer 2 while the delivery sequence allocated 1; the daemon's redelivery cursor would be wrong.
  at Object.enqueueOffer ../cloud/src/cloud.ts:426:15
  at src/__tests__/conformance.test.ts:135:21

Test Files  1 failed (1)
Tests       1 failed | 55 skipped (56)
PRE_FIX_EXIT=1
```
