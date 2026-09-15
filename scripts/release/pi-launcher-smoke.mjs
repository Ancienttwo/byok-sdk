// Installed composition: no prompt, provider request, real profile or OS key access.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { SqliteProviderProfileStore, parseModelProviderProfile, exactProviderProfileBinding } from '@byok-sdk/keys';
import { parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER } from './pi-runtime-identity.mjs';

import { PiAdapter } from '@byok-sdk/client/adapters';
import { resolveTrustedLaunchCwd, sealRuntimeOperationManifest } from '@byok-sdk/client';

const require = createRequire(import.meta.url);
const keysRoot = path.dirname(require.resolve('@byok-sdk/keys/package.json'));
const clientRoot = path.dirname(require.resolve('@byok-sdk/client/package.json'));
// Exact client dependency, never an unversioned PATH executable. The pin is an
// npm alias onto the SDK's Pi fork, so the specifier and the installed path
// stay upstream while the manifest inside carries the fork identity.
const piEntry = fileURLToPath(import.meta.resolve(PI_DEPENDENCY_SPECIFIER));
const piRoot = path.dirname(path.dirname(piEntry));
const piManifest = JSON.parse(await readFile(path.join(piRoot, 'package.json'), 'utf8'));
const clientManifest = JSON.parse(await readFile(path.join(clientRoot, 'package.json'), 'utf8'));
const piRuntime = parsePiRuntimeIdentity(clientManifest, '@byok-sdk/client package.json');
assert.equal(piManifest.name, piRuntime.packageName);
assert.equal(piManifest.version, piRuntime.version);
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
  const toolsMarker = path.join(dir, 'active-tools.json');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const extension = path.join(dir, 'extension.mjs');
  const toolsObserver = path.join(dir, 'tools-observer.mjs');
  const reservedServerCwdMarker = path.join(dir, 'reserved-server-cwd.txt');
  const trustedLaunch = await resolveTrustedLaunchCwd();
  assert.equal(trustedLaunch.kind, 'resolved', `no trusted MCP launch directory here: ${trustedLaunch.reason}`);
  assert.notEqual(trustedLaunch.dir, dir);
  // A real stdio MCP server, so the installed package's own MCP extension is
  // run against a server that really has to start and really has to answer,
  // rather than stubbed away. Hand-rolled for the same reason the in-repo
  // fixtures are: the SDK ships an MCP client, not a server, and the release
  // smoke must not grow a dependency the published package does not have.
  //
  // What this proves and what it does not: the extension loads inside the
  // installed Pi, registers one tool per OBSERVED tool for the host toolset
  // server, and — for the SDK-reserved helper below — really connects,
  // handshakes and reads `tools/list` off a live child through
  // `McpServerPool`. It does NOT reach `tools/call`: only a model turn invokes
  // a registered tool, and this smoke sends no prompt and allows no inference.
  // The call path (lazy open, drift re-verification, the call itself, the
  // close) is covered against the same shape of server by
  // `packages/client/src/__tests__/mcp-extension-call.test.ts`.
  const fixtureServer = path.join(dir, 'fixture-mcp-server.mjs');
  await writeFile(fixtureServer, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
// The directory this server was actually started in, read back out of the
// child. It must be the daemon's proven-non-writable launch directory and NOT
// the Pi child's own cwd — a compiled server binary reads \`$cwd/bunfig.toml\`
// \`preload\` before its own code, and the Pi child's cwd is the Agent home.
if (process.argv[3]) writeFileSync(process.argv[3], process.cwd());
let initialized = false;
const TOOL = { name: process.argv[2] ?? 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined || request.id === null) {
    if (request.method === 'notifications/initialized') initialized = true;
    return;
  }
  if (request.method === 'initialize') return reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'byok-release-fixture', version: '1.0.0' } });
  if (request.method === 'tools/list' && initialized) return reply(request.id, { tools: [TOOL] });
  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: 'ok' }], isError: false });
});
`);
  // Exactly what the daemon would hand a task: the servers plus the
  // observation it took at admission. The extension registers from the
  // observation and discovers nothing of its own.
  const mcpTaskConfig = {
    mcpServers: {
      fixture: { command: process.execPath, args: [fixtureServer] },
      // An SDK-RESERVED helper, which the extension reads live at
      // `session_start` instead of from an observation. It is the one entry
      // that makes the installed `McpServerPool` open a real connection during
      // this smoke; a host toolset server stays unopened until it is called.
      byokagentteam: { command: process.execPath, args: [fixtureServer, 'relay_probe', reservedServerCwdMarker] },
    },
    observation: {
      fixture: {
        toolsetId: 'release.smoke.v1',
        serverName: 'fixture',
        serverInfo: { name: 'byok-release-fixture', version: '1.0.0' },
        protocolVersion: '2025-11-25',
        tools: [{
          name: 'echo',
          description: 'Echo text back.',
          // The operator's own read/mutation classification. Required under
          // the `readonly` policy this smoke runs, which is what makes the
          // tool registrable at all.
          readOnly: true,
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        }],
      },
    },
    permissionMode: 'readonly',
    // The daemon resolves this once per offer and the extension refuses to open
    // any server without it; the installed package must therefore honour it out
    // of the packed tarball, launcher script included.
    launchCwd: trustedLaunch.dir,
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpTaskConfig));
  await writeFile(toolsObserver, `import {writeFileSync} from 'node:fs';
export default function (pi) {
 pi.on('session_start', () => { writeFileSync(${JSON.stringify(toolsMarker)}, JSON.stringify(pi.getActiveTools())); });
}`);
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
  // No `resolveExtensions` stub: the installed adapter resolves its REAL
  // extension stack, so the invocation captured below is the one a task would
  // actually run — the SDK's own MCP extension included.
  const adapter = new PiAdapter({
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
  // The real, installed extension stack — and the MCP extension is the SDK's
  // own dist file, not a third-party package.
  const loadedExtensions = directInvocation.args.filter((arg, index) => directInvocation.args[index - 1] === '--extension');
  assert.equal(loadedExtensions.length, 5);
  const sdkMcpExtension = path.join(clientRoot, 'dist/adapters/pi/mcp-extension.js');
  assert.ok(loadedExtensions.includes(sdkMcpExtension), `real MCP extension missing from ${loadedExtensions.join(', ')}`);
  assert.ok(!loadedExtensions.some(entry => entry.includes('pi-mcp-adapter')), 'pi-mcp-adapter is retired');
  // The adapter creates its task-scoped MCP config, then removes it when the
  // captured spawn throws. Re-create it at the exact path the captured
  // environment names, so the observed invocation stays byte-identical while
  // the real MCP extension has the task file it refuses to start without.
  const capturedConfigPath = directInvocation.options.env.BYOK_PI_MCP_CONFIG_PATH;
  assert.equal(typeof capturedConfigPath, 'string');
  await mkdir(path.dirname(capturedConfigPath), { recursive: true });
  await writeFile(capturedConfigPath, JSON.stringify(mcpTaskConfig));
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
  await rm(path.dirname(capturedConfigPath), { recursive: true, force: true });
  console.log(`[release-pack] installed Pi${piManifest.version} detect/direct RPC with the real extension stack passed; prompts=0`);

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
    '--', '--mode', 'rpc',
    '--extension', extension,
    // The real SDK-owned MCP extension, against the real stdio MCP servers
    // configured above.
    '--extension', path.join(clientRoot, 'dist/adapters/pi/mcp-extension.js'),
    '--extension', toolsObserver,
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
    // One Pi tool per observed MCP tool, carrying the server's real schema —
    // not a single `mcp` proxy, and not `mcpScript`. The name is spelled out
    // rather than derived from the core's `projectMcpTools`: that helper is
    // not part of the published surface, and re-deriving the qualified form
    // here would make this file a second authority on the naming rule. That
    // the registered set IS exactly the projection is asserted in-repo, in
    // `packages/client/src/__tests__/mcp-projection.test.ts`.
    const activeTools = JSON.parse(await readFile(toolsMarker, 'utf8'));
    assert.ok(activeTools.includes('mcp__fixture__echo'), `registered tools: ${activeTools.join(', ')}`);
    // The reserved helper is read LIVE off a connected child, so its bare tool
    // name appearing here is proof the pool really handshook with a server.
    assert.ok(activeTools.includes('relay_probe'), `reserved helper tool missing from: ${activeTools.join(', ')}`);
    // ...and that child is where the launch boundary is actually observable
    // out of the packed tarball: it started in the proven-non-writable launch
    // directory, not in the Pi process's own cwd.
    const reservedServerCwd = (await readFile(reservedServerCwdMarker, 'utf8')).trim();
    assert.equal(await realpath(reservedServerCwd), await realpath(trustedLaunch.dir));
    assert.notEqual(reservedServerCwd, dir);
    // The packed tarball really ships the launcher the claude/codex paths need.
    await access(path.join(clientRoot, 'bin', 'byok-launch-cwd.mjs'));
    assert.ok(!activeTools.includes('mcp'), 'the retired MCP proxy tool must not be registered');
    assert.ok(!activeTools.includes('mcpScript'), 'the retired mcpScript tool must not be registered');
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
