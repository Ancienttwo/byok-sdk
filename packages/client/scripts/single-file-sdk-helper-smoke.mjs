import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootArg = process.argv.indexOf('--client-root');
const artifactsArg = process.argv.indexOf('--artifacts');
let installRoot;
let clientRoot;
if (artifactsArg >= 0) {
  const artifactsRoot = path.resolve(process.argv[artifactsArg + 1]);
  const manifest = JSON.parse(readFileSync(path.join(artifactsRoot, 'release-manifest.json'), 'utf8'));
  installRoot = mkdtempSync(path.join(os.tmpdir(), 'byok-packed-helper-install-'));
  writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));
  const tarballs = manifest.packages.map((entry) => path.join(artifactsRoot, entry.file));
  const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
    cwd: installRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  clientRoot = path.join(installRoot, 'node_modules', '@byok-sdk', 'client');
} else {
  clientRoot = path.resolve(rootArg >= 0 ? process.argv[rootArg + 1] : new URL('..', import.meta.url).pathname);
}
const clientEntry = path.join(clientRoot, 'dist', 'index.js');
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'byok-single-file-helper-'));
const executable = path.join(fixtureRoot, process.platform === 'win32' ? 'packed-host.exe' : 'packed-host');
const source = path.join(fixtureRoot, 'host.ts');

const expectedTool = {
  'agent-message-mcp': 'send_agent_message',
  'agent-memory-mcp': 'memory.recall',
  'approval-mcp': 'approval_prompt',
};

try {
  writeFileSync(source, `
    import { runSdkReservedHelperCommand } from ${JSON.stringify(clientEntry)};
    if (await runSdkReservedHelperCommand()) process.exit(0);
    process.stderr.write('unknown product command\\n');
    process.exit(2);
  `);
  const compiled = spawnSync('bun', ['build', '--compile', source, '--outfile', executable], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);

  for (const [kind, toolName] of Object.entries(expectedTool)) {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n';
    const result = spawnSync(executable, ['__byok_sdk_helper', kind], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        BYOK_STORE_DIR: fixtureRoot,
        BYOK_PRODUCT_ID: 'single-file-smoke',
        BYOK_TASK_ID: 'single-file-task',
        BYOK_AGENT_MESSAGE_CONTEXT: 'single-file-message-context',
        BYOK_AGENT_MEMORY_CONTEXT: 'single-file-memory-context',
      },
    });
    assert.equal(result.status, 0, `${kind}: ${result.stdout}${result.stderr}`);
    const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    const listed = responses.find((value) => value.id === 2);
    assert.ok(listed?.result?.tools?.some((tool) => tool.name === toolName), `${kind}: missing ${toolName}`);
  }

  const normal = spawnSync(executable, ['status'], { encoding: 'utf8' });
  assert.equal(normal.status, 2);
  assert.match(normal.stderr, /unknown product command/);
  process.stdout.write(`[single-file-sdk-helper] ${clientRoot} passed\n`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (installRoot) rmSync(installRoot, { recursive: true, force: true });
}
