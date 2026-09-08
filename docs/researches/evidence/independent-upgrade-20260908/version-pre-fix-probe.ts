import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, type Envelope } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/protocol/src/index.ts';
import { AuthManager } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/client/src/daemon/auth-manager.ts';
import { ConnectionManager } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/client/src/daemon/connection-manager.ts';
import { CursorStore } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/client/src/daemon/cursor-store.ts';
import { DeviceStore } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/client/src/daemon/store.ts';
import { startRealServer } from '/Users/kito/Projects/byok-sdk-wt-r10-r13/packages/client/src/__tests__/fixtures/real-server.ts';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('probe timeout');
}

const real = await startRealServer({
  productId: 'version-v2-probe',
  longPollHoldMs: 20,
  rateLimit: { messagesPerSecond: 10_000, burst: 10_000 },
});
const storeDir = await mkdtemp(path.join(os.tmpdir(), 'byok-version-v2-probe-'));
const auth = new AuthManager({ serverUrl: real.url, store: new DeviceStore(storeDir) });
const pairing = await real.createPairingCode();
const record = await auth.pair(pairing.code);
const cursorStore = new CursorStore(storeDir);
let receivedV: number | undefined;
let acceptedV2 = false;
const originalFetch = globalThis.fetch;

try {
  // This models an independently upgraded cloud by changing only the on-wire
  // envelope version after the real server has generated a known task.offer.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await originalFetch(input, init);
    if (!url.startsWith(`${real.url}/byok/events`) || !response.ok) return response;
    const body = await response.json() as { events: Array<Record<string, unknown>>; cursor: number; capabilities?: string[] };
    return new Response(JSON.stringify({
      ...body,
      events: body.events.map((event) => event.type === 'task.offer' ? { ...event, v: 2 } : event),
    }), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const connection = new ConnectionManager({
    serverUrl: real.url,
    deviceId: record.deviceId,
    productId: 'version-v2-probe',
    capabilities: [],
    runtimes: [],
    auth,
    cursorStore,
    onEnvelope: async (envelope) => {
      if (envelope.type === 'task.offer') receivedV = envelope.v;
    },
    onOutboundAccepted: async (envelopes) => {
      if (envelopes.some((envelope) => envelope.type === 'task.claim' && envelope.v === 2)) acceptedV2 = true;
    },
    longPollRetryDelayMs: 10,
    longPollIdleDelayMs: 10,
  });

  await connection.start();
  await connection.waitForConnection();
  const task = await real.byok.dispatch({ instruction: 'known task for v2 admission probe', policy: { mode: 'auto' } });
  await waitFor(() => receivedV === 2);
  await waitFor(async () => (await cursorStore.load(real.url, record.deviceId)) !== undefined);
  const cursor = await cursorStore.load(real.url, record.deviceId);
  const v2Claim = { ...createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: task.taskId }), v: 2 } as Envelope;
  connection.send(v2Claim);
  await waitFor(async () => acceptedV2 && (await real.byok.tasks.get(task.taskId))?.state === 'Claimed');
  console.log(JSON.stringify({ receivedV, cursor, acceptedV2, cloudTaskState: (await real.byok.tasks.get(task.taskId))?.state }));
  await connection.stop(1_000);
  throw new Error('PRE_FIX_VERSION_BYPASS: v:2 executed and was acknowledged on both long-poll boundaries');
} finally {
  globalThis.fetch = originalFetch;
  await auth.stop();
  await real.close();
}
