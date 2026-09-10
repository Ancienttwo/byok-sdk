// Installed composition: no prompt, provider request, real profile or OS key access.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { SqliteProviderProfileStore, parseModelProviderProfile, exactProviderProfileBinding } from '@byok-sdk/keys';

import { PiAdapter } from '@byok-sdk/client/adapters';
import { sealRuntimeOperationManifest } from '@byok-sdk/client';

const require = createRequire(import.meta.url);
const keysRoot = path.dirname(require.resolve('@byok-sdk/keys/package.json'));
const clientRoot = path.dirname(require.resolve('@byok-sdk/client/package.json'));
// Exact client dependency, never an unversioned PATH executable.
const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piRoot = path.dirname(path.dirname(piEntry));
const piManifest = JSON.parse(await readFile(path.join(piRoot, 'package.json'), 'utf8'));
const clientManifest = JSON.parse(await readFile(path.join(clientRoot, 'package.json'), 'utf8'));
assert.equal(piManifest.version, clientManifest.dependencies['@earendil-works/pi-coding-agent']);
const dir = await mkdtemp(path.join(tmpdir(), 'packed-pi-launcher-'));
let requests = 0;
const server = createServer((_req, res) => { requests++; res.writeHead(500); res.end('No inference allowed'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelConfig = {
  contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, thinkingLevel: 'low',
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', zaiToolStream: true },
};
let child;
try {
  const sessionDir = path.join(dir, 'sessions');
  const profileDbPath = path.join(dir, 'profiles.db');
  const marker = path.join(dir, 'extension-observed.json');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const extension = path.join(dir, 'extension.mjs');
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  await writeFile(extension, `import {writeFileSync} from 'node:fs';
export default function() {
 if (process.env.BYOK_PI_MCP_CONFIG_PATH !== ${JSON.stringify(mcpConfigPath)} || process.env.BYOK_PI_PERMISSION_MODE !== 'readonly') throw new Error('Missing task context');
 if (process.env.ZAI_API_KEY || process.env.UNRELATED_CANARY) throw new Error('Ambient credential escaped');
 writeFileSync(${JSON.stringify(marker)}, JSON.stringify({loaded:true}));
}`);
  const profile = parseModelProviderProfile({
    adapter: 'openai_compatible', auth_mode: 'none', base_url: `http://127.0.0.1:${server.address().port}/v1`,
    capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
    display_name: 'Packed explicit model', enabled: true, kind: 'model', model: 'glm-5.3-flash',
    profile_ref: 'packed-zai', provider_kind: 'custom', pi_model: modelConfig,
  });
  const store = new SqliteProviderProfileStore({ path: profileDbPath });
  await store.save(profile);
  const { pi_model: _, ...withoutPi } = profile;
  const missingPi = parseModelProviderProfile({ ...withoutPi, profile_ref: 'missing-pi', auth_mode: 'bearer', enabled: false });
  await store.save(missingPi);
  const stale = parseModelProviderProfile({ ...profile, profile_ref: 'stale-pi', enabled: false });
  const staleBinding = exactProviderProfileBinding(stale);
  await store.save(parseModelProviderProfile({ ...stale, pi_model: { ...modelConfig, maxTokens: 16_384 } }));
  await store.close();
  const binding = exactProviderProfileBinding(profile);
  const isolatedHome = path.join(dir, 'home');
  await mkdir(isolatedHome);
  const env = {
    PATH: process.env.PATH, HOME: isolatedHome, USERPROFILE: isolatedHome,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}),
    BYOK_PI_MCP_CONFIG_PATH: mcpConfigPath, BYOK_PI_PERMISSION_MODE: 'readonly',
    ZAI_API_KEY: 'synthetic-must-not-forward', UNRELATED_CANARY: 'synthetic-must-not-forward',
  };
  // Observe the actual installed adapter's direct command without ever sending its prompt.
  const directExtension = path.join(dir, 'direct extension.mjs');
  await writeFile(directExtension, `export default function() { if (process.env.BYOK_PI_PERMISSION_MODE !== 'readonly') throw new Error('Missing direct permission context'); }`);
  let directInvocation;
  const adapter = new PiAdapter({
    resolveExtensions: () => Object.fromEntries(['webAccess', 'mcpAdapter', 'subagentsPolicy', 'subagents', 'todo'].map(name => [name, directExtension])),
    spawnFn: (command, args, options) => { directInvocation = { command, args, options }; throw new Error('capture before prompt'); },
  });
  const detected = await adapter.detect();
  assert.equal(detected.kind, 'available');
  assert.equal(detected.version, piManifest.version);
  const policy = { mode: 'readonly' };
  const directEnv = { ...env, PI_CODING_AGENT_DIR: path.join(dir, 'direct-agent') };
  delete directEnv.ZAI_API_KEY;
  delete directEnv.UNRELATED_CANARY;
  const prepared = await adapter.prepare({ offer: { instruction: 'Never sent', policy }, policy, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  assert.equal(prepared.kind, 'prepared');
  const manifest = sealRuntimeOperationManifest({ taskId: 'packed-direct-capture', runtimeId: 'pi', descriptor: adapter.descriptor,
    policy, requiredToolsetIds: [], workspace: { workspaceDir: dir }, forwardedEnvironmentNames: Object.keys(directEnv).sort() });
  await assert.rejects(prepared.operation.start({ manifest, instruction: 'Never sent', env: directEnv }));
  assert.equal(directInvocation.command, process.execPath);
  assert.equal(directInvocation.args[0], path.join(piRoot, piManifest.bin.pi));
  assert.equal(directInvocation.options.shell, undefined);
  // Run that exact observed invocation with get_state only, no prompt/inference.
  child = spawn(directInvocation.command, directInvocation.args, { cwd: dir, env: directInvocation.options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const directClosed = once(child, 'close');
  let directStderr = '';
  child.stderr.on('data', bytes => { directStderr += bytes.toString(); });
  const directLines = createInterface({ input: child.stdout });
  const directTimer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  try {
    child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'direct-state' })}\n`);
    let state;
    for await (const line of directLines) {
      const event = JSON.parse(line);
      if (event.type === 'response' && event.id === 'direct-state') { state = event; break; }
    }
    assert.equal(state?.success, true, directStderr || 'Direct Pi did not return RPC state');
    assert.equal(state.data.messageCount, 0);
    assert.equal(requests, 0);
  } finally {
    clearTimeout(directTimer); directLines.close(); child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await directClosed; clearTimeout(force);
  }
  console.log(`[release-pack] installed Pi${piManifest.version} detect/direct RPC passed; prompts=0`);

  for (const [rejectedBinding, expected] of [
    [exactProviderProfileBinding(missingPi), /requires explicit pi_model/],
    [staleBinding, /hash mismatch/],
  ]) {
    const check = spawnSync(process.execPath, [path.join(keysRoot, 'dist/bin/pi-provider-launcher.js'),
      '--pi-bin', process.execPath, '--pi-entry', path.join(piRoot, piManifest.bin.pi), '--profile-db', profileDbPath, '--session-dir', sessionDir,
      '--provider', rejectedBinding.profileRef, '--model', rejectedBinding.modelId,
      '--profile-revision', rejectedBinding.profileRevision, '--profile-hash', rejectedBinding.profileHash,
      '--required-capabilities', '[]', '--validate-only', 'true',
    ], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 1);
    assert.match(check.stderr, expected);
  }
  child = spawn(process.execPath, [path.join(keysRoot, 'dist/bin/pi-provider-launcher.js'),
    '--pi-bin', process.execPath, '--pi-entry', path.join(piRoot, piManifest.bin.pi), '--profile-db', profileDbPath, '--session-dir', sessionDir,
    '--provider', binding.profileRef, '--model', binding.modelId,
    '--profile-revision', binding.profileRevision, '--profile-hash', binding.profileHash,
    '--required-capabilities', '[]', '--validate-only', 'false',
    '--', '--mode', 'rpc', '--extension', extension, '--no-tools',
  ], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  let state;
  try {
    child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'packed-state' })}\n`);
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'response' && event.id === 'packed-state') { state = event; break; }
    }
    assert.equal(state?.success, true, stderr || 'Pi did not return RPC state');
    assert.equal(state.data.model.provider, 'byok-sdk-packed-zai');
    assert.equal(state.data.model.id, profile.model);
    assert.equal(state.data.model.contextWindow, modelConfig.contextWindow);
    assert.equal(state.data.model.maxTokens, modelConfig.maxTokens);
    assert.equal(state.data.model.reasoning, true);
    assert.deepEqual(state.data.model.thinkingLevelMap, modelConfig.thinkingLevelMap);
    for (const [key, value] of Object.entries(modelConfig.compat)) assert.equal(state.data.model.compat[key], value);
    assert.equal(state.data.thinkingLevel, modelConfig.thinkingLevel);
    assert.equal(state.data.messageCount, 0);
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).loaded, true);
    assert.equal(requests, 0);
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await closed; clearTimeout(force);
  }
  console.log(`[release-pack] keys -> Pi${piManifest.version} RPC model/extension/custody passed; LLM requests=0`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
