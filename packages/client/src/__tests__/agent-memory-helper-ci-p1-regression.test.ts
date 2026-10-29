import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const REPO_ROOT_URL = new URL('../../../../', import.meta.url);

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT_URL), 'utf8');
}

function ciJob(workflow: string, name: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start === -1) throw new Error(`CI job ${name} is missing`);
  const followingJob = workflow.slice(start + 1).search(/^  [a-z][a-z0-9-]*:$/m);
  return followingJob === -1 ? workflow.slice(start) : workflow.slice(start, start + followingJob + 1);
}

describe('Agent memory filesystem helper CI P1 regression', () => {
  const workflow = repoFile('.github/workflows/ci.yml');

  it('builds and tests the Go helper on the macOS admission platform', () => {
    const helperJob = ciJob(workflow, 'agent-memory-helper');
    expect(helperJob).toContain('runs-on: ${{ matrix.os }}');
    expect(helperJob).toContain('os: macos-latest');
    expect(helperJob).toContain('os: macos-15-intel');
    expect(helperJob.match(/^    needs:.*$/gm)).toEqual(['    needs: select']);
    expect(helperJob).toContain("if: ${{ contains(fromJSON(needs.select.outputs.families), 'agent-memory-helper') }}");
    expect(helperJob).toMatch(/^        uses: actions\/checkout@[0-9a-f]{40} # v7\.\d+\.\d+$/m);
    expect(helperJob).toMatch(/^        uses: actions\/setup-node@[0-9a-f]{40} # v7\.\d+\.\d+$/m);
    expect(helperJob).toContain('node-version-file: .node-version');
    expect(helperJob).toMatch(/^        uses: oven-sh\/setup-bun@[0-9a-f]{40} # v2\.\d+\.\d+$/m);
    expect(helperJob).toMatch(/^        uses: actions\/setup-go@[0-9a-f]{40} # v6\.\d+\.\d+$/m);
    expect(helperJob).toContain('go-version-file: packages/client/native/agent-memory-fs/go.mod');
    expect(helperJob).toContain('run: bun ci');
    expect(helperJob).toContain('run: bun run build');
    expect(helperJob).toContain('run: bun run --filter @byok-sdk/client build:agent-memory-helper');
    expect(helperJob).toContain('working-directory: packages/client/native/agent-memory-fs');
    expect(helperJob).toContain('GOTOOLCHAIN=go1.26.5 go test -race -v ./...');
    expect(helperJob).toContain('go build -buildvcs=false -trimpath -o "$RUNNER_TEMP/byok-agent-memory-fs" .');
  });

  it('executes the TypeScript-to-Go helper contract with the built helper binary', () => {
    const helperJob = ciJob(workflow, 'agent-memory-helper');
    expect(helperJob).toContain('agent-memory-intent.test.ts');
    expect(helperJob).toContain('daemon-conn-hello-capabilities.test.ts');
    expect(helperJob).toContain('node packages/client/scripts/agent-memory-runtime-smoke.mjs');
    expect(helperJob).toContain('bun packages/client/scripts/agent-memory-runtime-smoke.mjs');
    expect(helperJob).toContain('bun run check:release-pack');
    expect(helperJob).toContain(
      'bun run --filter @byok-sdk/client test -- src/__tests__/agent-memory-fs-helper.test.ts',
    );
  });
});
