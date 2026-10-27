import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// #793: the dataplane job is the only job with a real Postgres. It must run this example's suites,
// with the flag that turns a missing database into a failure instead of a skip.
it('the CI dataplane job runs the hosted example against real Postgres', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split('\n  dataplane:\n')[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? '';
  expect(job).toContain("BYOK_REQUIRE_DATAPLANE: '1'");
  expect(job).toContain('BYOK_TEST_POSTGRES_URL: postgres://');
  expect(job).toContain('run: bash scripts/ci/with-secret-service.sh bun run --filter @byok-sdk/example-hosted-bot-collaboration test');
});
