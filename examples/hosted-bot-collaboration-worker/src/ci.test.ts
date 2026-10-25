import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// #794 D3: the dataplane job is the only job with a real Postgres and S3 endpoint. It must run this example's suites, with
// the flags that opt in to the wrangler suites and turn a missing substrate into a failure instead of a skip.
it('the CI dataplane job runs the Worker suites against real Postgres', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split('\n  dataplane:\n')[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? '';
  expect(job).toContain("BYOK_REQUIRE_WORKER_DATAPLANE: '1'");
  expect(job).toContain("BYOK_TEST_WORKER_DATAPLANE: '1'");
  expect(job).toContain('BYOK_TEST_POSTGRES_URL: postgres://');
  expect(job).toContain('BYOK_TEST_S3_ENDPOINT: http://');
  expect(job).toContain('run: bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test');
});
