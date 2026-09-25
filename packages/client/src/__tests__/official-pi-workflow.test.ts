import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveBunBin } from './support/test-bun-bin';

it('runs the vendored scripted workflow, official Agent/compat stream and opaque one-use permits offline', () => {
  const bun = resolveBunBin();
  if (bun === undefined) throw new Error('Bun is required for the vendored TS workflow probe');
  const result = execFileSync(bun, [fileURLToPath(new URL('./fixtures/official-pi-workflow-probe.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  expect(JSON.parse(result.trim())).toMatchObject({ status: 'passed', workflowLaunches: 1, loopbackRequests: 2, providerRequests: 0 });
}, 20_000);
