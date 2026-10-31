import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentMemoryHelperSourceDigest, verifyAgentMemoryHelperSourceDigest } from '../../packages/client/scripts/agent-memory-helper-source.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'byok-helper-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'go.mod'), 'module example/helper\n\ngo 1.26.5\n');
  writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n');
  return root;
}

test('source verification rejects changed native code and accepts test-only changes', t => {
  const root = fixture(t);
  const manifest = { sourceDigest: agentMemoryHelperSourceDigest(root) };
  verifyAgentMemoryHelperSourceDigest(root, manifest);
  writeFileSync(path.join(root, 'main_test.go'), 'package main\n');
  verifyAgentMemoryHelperSourceDigest(root, manifest);
  writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() { panic("changed") }\n');
  assert.throws(() => verifyAgentMemoryHelperSourceDigest(root, manifest), /source digest mismatch/);
});

test('the reproducibility command refuses a wrong manifest sourceDigest before invoking Go', t => {
  const root = fixture(t);
  const source = path.join(root, 'native/agent-memory-fs');
  const scripts = path.join(root, 'scripts');
  const output = path.join(root, 'dist/native/agent-memory-fs');
  for (const dir of [source, scripts, output]) mkdirSync(dir, { recursive: true });
  for (const name of ['go.mod', 'main.go']) copyFileSync(path.join(root, name), path.join(source, name));
  for (const name of ['check-agent-memory-helper-build.mjs', 'agent-memory-helper-source.mjs']) copyFileSync(new URL(`../../packages/client/scripts/${name}`, import.meta.url), path.join(scripts, name));
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ sourceDigest: '0'.repeat(64) }));
  const result = spawnSync(process.execPath, [path.join(scripts, 'check-agent-memory-helper-build.mjs')], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Agent memory helper source digest mismatch/);
  assert.doesNotMatch(result.stderr, /spawnSync go/);
});

test('both release builders run verified native builds before packing', () => {
  const workspace = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const client = JSON.parse(readFileSync(new URL('../../packages/client/package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(client.scripts.build, /build-agent-memory-helper/);
  assert.match(workspace.scripts['build:release'], /bun run build && bun run --filter @byok-sdk\/client build:agent-memory-helper/);
  assert.match(client.scripts['build:agent-memory-helper'], /build-agent-memory-helper\.mjs && node scripts\/check-agent-memory-helper-build\.mjs/);
  for (const name of ['publish.mjs', 'pack-and-smoke.mjs']) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.match(text, /\['run', 'build:release'\]/);
  }
});

test('committed helper identity matches the current native sources without a Go build', async () => {
  const { AGENT_MEMORY_HELPER_RELEASE } = await import('../../packages/client/src/util/agent-memory-helper-release-pin.ts');
  verifyAgentMemoryHelperSourceDigest(fileURLToPath(new URL('../../packages/client/native/agent-memory-fs/', import.meta.url)), AGENT_MEMORY_HELPER_RELEASE);
});
