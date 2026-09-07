import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const installRoot = path.resolve(process.argv[process.argv.indexOf('--install-root') + 1]);
const load = (pkg, entry = 'index.js') => import(pathToFileURL(path.join(installRoot, 'node_modules', '@byok-sdk', pkg, 'dist', entry)).href);
const { createInMemoryByokCloud, tenantId } = await load('cloud');
const client = await load('client');
const adapters = await load('client', 'adapters/index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'byok-packed-cli-mcp-'));
const fakeCodex = path.join(root, process.platform === 'win32' ? 'codex-probe.exe' : 'codex-probe');
const fixture = fileURLToPath(new URL('./fixtures/packed-cli-mcp-codex.mjs', import.meta.url));
const built = spawnSync('bun', ['build', '--compile', fixture, '--outfile', fakeCodex], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const tenant = tenantId('packed-cli-mcp');
const { cloud, core } = createInMemoryByokCloud({ longPollHoldMs: 100, longPollIntervalMs: 10 });
await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 10000000n, maxObjectBytes: 1000000n,
  maxInlineBytes: 1000000n, mailboxLimitBytes: 10000000n, retentionPolicyId: 'test' });
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await cloud.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method,
      headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
const cli = path.join(installRoot, 'node_modules', '@byok-sdk', 'client', 'dist', 'bin', 'byok-agent.js');
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`timed out: ${label}`);
};
const runCli = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
});
const previous = { bin: process.env.BYOK_CODEX_BIN, testStore: process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE };
process.env.BYOK_CODEX_BIN = fakeCodex;
process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE = '1';
try {
  for (const entry of ['root', 'adapters', 'cli']) {
    const storeDir = path.join(root, entry);
    const audit = path.join(root, `${entry}-mcp.jsonl`);
    const config = { productId: `packed-${entry}`, productName: 'Packed MCP', serverUrl, storeDir,
      workspaceRoot: path.join(storeDir, 'work'), runtimeAllowlist: ['codex'], serviceEnrollment: { enabled: true },
      mcpToolsets: { probe: { mcpServers: { echo: { command: process.execPath,
        args: [fileURLToPath(new URL('../src/__tests__/fixtures/toolset-echo-mcp.mjs', import.meta.url)), audit] } } } } };
    const pairing = await cloud.createPairingCode(tenant, { productId: config.productId });
    let daemon, processChild, output = '';
    const env = { ...process.env };
    try {
      if (entry === 'cli') {
        const configFile = path.join(root, 'cli.json'); writeFileSync(configFile, JSON.stringify(config));
        processChild = spawn(process.execPath, [cli, 'start', '--config', configFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        processChild.stdout.on('data', chunk => { output += chunk; }); processChild.stderr.on('data', chunk => { output += chunk; });
        await wait(() => { if (processChild.exitCode !== null) throw new Error(output); return output.includes('daemon started:'); }, 'packed CLI start');
        await runCli(['pair', pairing.code, '--server', serverUrl, '--config', configFile], env);
      } else {
        const runtimeConfig = { ...config, localAgentRelease: { version: '0.0.0-test' } };
        daemon = entry === 'root' ? client.createDaemon(runtimeConfig) : client.createDaemonWithAdapters(runtimeConfig, [new adapters.CodexAdapter()]);
        await daemon.pair(pairing.code); await daemon.start();
      }
      const device = await wait(async () => (await cloud.listDevices(tenant)).find(device => device.productId === config.productId && device.capabilities?.includes('toolset-selection')), `${entry} discovery`);
      const offer = await cloud.enqueueToolsetOffer(tenant, device.deviceId, { payload: { instruction: 'call echo', policy: { mode: 'auto' }, runtime: 'codex', requiredToolsets: ['probe'] } });
      await wait(async () => {
        const attempt = await cloud.readTaskAttempt(tenant, offer.taskId);
        if (attempt?.status === 'failed') throw new Error(`${entry}: ${JSON.stringify(await cloud.readTerminalReceipt(tenant, offer.taskId))}\n${output}`);
        return attempt?.status === 'complete';
      }, `${entry} actual MCP completion`);
      const calls = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'tools/call');
      assert.equal(calls.length, 1, `${entry}: expected exactly one real tools/call`);
      console.log(`[packed-cli-mcp] ${entry}: actual MCP tools/call passed`);
    } finally {
      await daemon?.stop();
      if (processChild && processChild.exitCode === null) {
        const exited = new Promise(resolve => processChild.once('close', resolve));
        processChild.kill(); await exited;
      }
    }
  }
} finally {
  if (previous.bin === undefined) delete process.env.BYOK_CODEX_BIN; else process.env.BYOK_CODEX_BIN = previous.bin;
  if (previous.testStore === undefined) delete process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE; else process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE = previous.testStore;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  rmSync(root, { recursive: true, force: true });
}
