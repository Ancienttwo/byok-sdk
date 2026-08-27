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
    expect(helperJob).toContain('runs-on: macos-latest');
    expect(helperJob).not.toContain('needs:');
    expect(helperJob).toContain('uses: actions/checkout@v7');
    expect(helperJob).toContain('uses: actions/setup-node@v7');
    expect(helperJob).toContain('node-version-file: .node-version');
    expect(helperJob).toContain('uses: oven-sh/setup-bun@v2');
    expect(helperJob).toContain('uses: actions/setup-go@v6');
    expect(helperJob).toContain('go-version-file: packages/client/native/agent-memory-fs/go.mod');
    expect(helperJob).toContain('run: bun ci');
    expect(helperJob).toContain('run: bun run build');
    expect(helperJob).toContain('working-directory: packages/client/native/agent-memory-fs');
    expect(helperJob).toContain('GOTOOLCHAIN=go1.26.5 go test ./...');
    expect(helperJob).toContain('go build -o "$RUNNER_TEMP/byok-agent-memory-fs" .');
  });

  it('executes the TypeScript-to-Go helper contract with the built helper binary', () => {
    const helperJob = ciJob(workflow, 'agent-memory-helper');
    expect(helperJob).toContain('BYOK_TEST_AGENT_MEMORY_FS_BIN="$RUNNER_TEMP/byok-agent-memory-fs"');
    expect(helperJob).toContain(
      'bun run --filter @byok-sdk/client test -- src/__tests__/agent-memory-fs-helper.test.ts',
    );
  });
});
