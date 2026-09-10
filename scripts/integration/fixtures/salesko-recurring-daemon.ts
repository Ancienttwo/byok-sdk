import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StubRuntimeAdapter } from '../../../packages/client/src/__tests__/fixtures/stub-adapter';

// Owned disposable child only. The adapter supplies synthetic events; all
// execution, journal, outbox and authenticated transport come from the install.
const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  installRoot: string; localRoot: string; serverUrl: string; productId: string;
  controlToken: string; readyPath: string; pairingCode?: string; egressPolicy: unknown;
};
const { createDaemonWithAdapters } = await import(pathToFileURL(Bun.resolveSync('@byok-sdk/client', config.installRoot)).href);
const adapter = new StubRuntimeAdapter('claude', { kind: 'available', version: 'synthetic-recovery' },
  { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true, permissionModes: ['auto', 'readonly', 'confirm', 'plan'] }, false);
let preparations = 0;
const prepare = adapter.prepare.bind(adapter);
adapter.prepare = async input => { preparations++; return prepare(input); };
const daemon = createDaemonWithAdapters({
  localAgentRelease: { version: '0.0.0-recovery-test' }, productName: 'recovery fixture', productId: config.productId,
  serverUrl: config.serverUrl, workspaceRoot: join(config.localRoot, 'workspace'), storeDir: join(config.localRoot, 'store'),
  hostedJournal: { mode: 'sqlite' }, agentHome: { hostStorageRoot: join(config.localRoot, 'home') },
  agentEgress: { policy: config.egressPolicy },
  mcpToolsets: { 'salesko.read.v1': { mcpServers: { read: { command: '/bin/false' } } },
    'salesko.propose.v1': { mcpServers: { propose: { command: '/bin/false' } } } },
}, [adapter]);
if (config.pairingCode) await daemon.pair(config.pairingCode);
await daemon.start();
const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.headers.get('x-test-control') !== config.controlToken) return new Response(null, { status: 403 });
  const path = new URL(request.url).pathname;
  if (path === '/status' && request.method === 'GET') return Response.json({ pid: process.pid,
    preparations, starts: adapter.startCalls.length, status: daemon.status(),
    sessions: adapter.startCalls.map((call, i) => ({ sessionRef: adapter.sessions[i]?.sessionRef,
      workspaceDir: call.ctx.workspaceDir })) });
  if (path === '/emit' && request.method === 'POST') {
    if (adapter.sessions.length !== 1) return new Response('Expected one synthetic session', { status: 409 });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'A1' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    return Response.json({ emitted: true });
  }
  if (path === '/stop' && request.method === 'POST') {
    await daemon.stop();
    setTimeout(() => { control.stop(true); process.exit(0); }, 25);
    return Response.json({ stopped: true });
  }
  return new Response(null, { status: 404 });
} });
await writeFile(config.readyPath + '.tmp', JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${control.port}`, deviceId: daemon.status().deviceId }));

await rename(config.readyPath + '.tmp', config.readyPath);
