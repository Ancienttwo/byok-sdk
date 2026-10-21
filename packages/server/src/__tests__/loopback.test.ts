import { createServer, Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { listenLoopback, type LoopbackListener, type LoopbackPortStore } from '../loopback';
import { createByokServer } from '../index';
import { connectFakeDaemonLongPoll } from './test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const selected = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return selected;
}
function store(initial: number | null = null): LoopbackPortStore {
  let value = initial;
  return { read: vi.fn(async () => value), claim: vi.fn(async candidate => value ??= candidate) };
}
async function start(handler = vi.fn(async (request: Request) => new Response(await request.text())), maxBodyBytes = 16, allowedOrigins?: string[]) {
  const selected = await availablePort();
  const portStore = store();
  const listener = await listenLoopback({ portStore, portRange: { min: selected, maxExclusive: selected + 1 }, maxBodyBytes, allowedOrigins,
    createHandler: () => handler });
  cleanups.push(listener.close);
  return { listener, handler, selected, portStore };
}
function raw(selected: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(selected, '127.0.0.1');
    let response = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw request timeout')); });
    socket.on('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('connect', () => socket.write(message));
  });
}

it('accepts native fetch mode:cors and exact body limit, rejects overflow before dispatch', async () => {
  const { listener, handler, selected } = await start();
  const response = await fetch(listener.serverUrl, { method: 'POST', body: 'x'.repeat(16) });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('x'.repeat(16));
  expect(handler).toHaveBeenCalledTimes(1);
  expect((await fetch(listener.serverUrl, { method: 'POST', body: 'x'.repeat(17) })).status).toBe(413);
  const chunked = await raw(selected, `POST / HTTP/1.1\r\nHost: 127.0.0.1:${selected}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\n${'x'.repeat(16)}\r\n1\r\nx\r\n0\r\n\r\n`);
  expect(chunked).toMatch(/^HTTP\/1.1 413/);
  expect(handler).toHaveBeenCalledTimes(1);
});

it('rejects unsafe raw headers, targets and protocol upgrades before dispatch', async () => {
  const { selected, handler } = await start();
  const host = `Host: 127.0.0.1:${selected}\r\n`;
  const cases = [
    `GET / HTTP/1.1\r\nHost: localhost:${selected}\r\n`,
    `GET / HTTP/1.1\r\n${host}Host: 127.0.0.1:${selected}\r\n`,
    ...['Origin: null', 'Origin:', 'Cookie:', 'Sec-Fetch-Site: cross-site', 'Sec-Fetch-Mode: navigate'].map(header => `GET / HTTP/1.1\r\n${host}${header}\r\n`),
    `GET http://127.0.0.1:${selected}/ HTTP/1.1\r\n${host}`,
    `GET //other/path HTTP/1.1\r\n${host}`,
    `GET /\\other/path HTTP/1.1\r\n${host}`,
    `GET / HTTP/1.1\r\n${host}Upgrade: websocket\r\nConnection: Upgrade\r\n`,
    `CONNECT 127.0.0.1:${selected} HTTP/1.1\r\n${host}`,
  ];
  for (const message of cases) expect(await raw(selected, `${message}Connection: close\r\n\r\n`)).toMatch(/^HTTP\/1.1 403/);
  expect(handler).not.toHaveBeenCalled();
});

it('admits only listed loopback origins with CORS, answering preflight without dispatch', async () => {
  const browser = 'http://localhost:5173';
  const { selected, handler } = await start(undefined, 16, [browser]);
  const host = `Host: 127.0.0.1:${selected}\r\n`;
  const page = `Origin: ${browser}\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Dest: empty\r\n`;
  const close = 'Connection: close\r\n\r\n';
  const preflight = await raw(selected, `OPTIONS /mcp HTTP/1.1\r\n${host}${page}Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: authorization\r\n${close}`);
  expect(preflight).toMatch(/^HTTP\/1.1 204/);
  expect(preflight).toMatch(new RegExp(`\r\nAccess-Control-Allow-Origin: ${browser}\r\n`));
  expect(preflight).toMatch(/\r\nAccess-Control-Allow-Headers: [^\r]*\bauthorization\b/);
  expect(preflight).not.toMatch(/Access-Control-Allow-Credentials/i);
  expect(handler).not.toHaveBeenCalled();
  const actual = await raw(selected, `POST /mcp HTTP/1.1\r\n${host}${page}Content-Length: 2\r\n${close}hi`);
  expect(actual).toMatch(/^HTTP\/1.1 200/);
  expect(actual).toMatch(new RegExp(`\r\nAccess-Control-Allow-Origin: ${browser}\r\n`));
  expect(actual).toMatch(/\r\nVary: Origin\r\n/);
  expect(actual).toMatch(/\r\nAccess-Control-Expose-Headers: Mcp-Session-Id\r\n/);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]![0].headers.get('origin')).toBe(browser);
  // Body cap still applies, and the allowed page can read the refusal.
  const oversized = await raw(selected, `POST /mcp HTTP/1.1\r\n${host}${page}Content-Length: 17\r\n${close}`);
  expect(oversized).toMatch(new RegExp(`^HTTP/1.1 413[^]*\r\nAccess-Control-Allow-Origin: ${browser}\r\n`));
  // A plain OPTIONS without a preflight request method is an ordinary request.
  expect(await raw(selected, `OPTIONS /mcp HTTP/1.1\r\n${host}${page}${close}`)).toMatch(/^HTTP\/1.1 200/);
  expect(handler).toHaveBeenCalledTimes(2);
  const refused = [
    `Origin: http://localhost:5174\r\nSec-Fetch-Mode: cors\r\n`,
    `Origin: ${browser}\r\nOrigin: ${browser}\r\n`,
    `Origin: ${browser}/\r\n`,
    `${page}Cookie: a=b\r\n`,
    `Origin: ${browser}\r\nSec-Fetch-Mode: navigate\r\n`,
    `Origin: ${browser}\r\nSec-Fetch-Mode: no-cors\r\n`,
    `Origin: ${browser}\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: document\r\n`,
    `${page}Sec-Fetch-User: ?1\r\n`,
    `${page}Sec-Fetch-Site: same-origin\r\n`,
    // Without Origin, browser metadata other than native fetch's mode stays refused.
    `Sec-Fetch-Mode: cors\r\nSec-Fetch-Site: cross-site\r\n`,
  ];
  for (const headers of refused) {
    const response = await raw(selected, `OPTIONS /mcp HTTP/1.1\r\n${host}${headers}Access-Control-Request-Method: POST\r\n${close}`);
    expect(response).toMatch(/^HTTP\/1.1 403/);
    expect(response).not.toMatch(/Access-Control-Allow-Origin/i);
  }
  const native = await fetch(`http://127.0.0.1:${selected}`, { method: 'POST', body: 'ok' });
  expect(native.status).toBe(200);
  expect(native.headers.get('access-control-allow-origin')).toBeNull();
  expect(handler).toHaveBeenCalledTimes(3);
});

it('rejects non-loopback or non-canonical allowed origins before reading the port store', async () => {
  for (const origin of ['http://example.com', 'null', '*', 'http://localhost:5173/', 'http://user@localhost:5173', 'file:///tmp', 'http://127.0.0.2:5173', 'ws://localhost:5173']) {
    const portStore = store();
    await expect(listenLoopback({ portStore, allowedOrigins: [origin], createHandler: () => () => new Response() })).rejects.toThrow(TypeError);
    expect(portStore.read).not.toHaveBeenCalled();
  }
});

it('refuses GET body and oversized Expect upload without continuing or dispatching', async () => {
  const { selected, handler } = await start();
  expect(await raw(selected, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${selected}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx`)).toMatch(/^HTTP\/1.1 400/);
  expect(await raw(selected, `POST / HTTP/1.1\r\nHost: 127.0.0.1:${selected}\r\nContent-Length: 17\r\nExpect: 100-continue\r\n\r\n`)).toMatch(/^HTTP\/1.1 413/);
  expect(handler).not.toHaveBeenCalled();
});

it('serves 503 while claim is pending, then restarts on the identical immutable URL', async () => {
  const selected = await availablePort();
  let release!: () => void;
  let claiming!: () => void;
  const entered = new Promise<void>(resolve => { claiming = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const portStore = store();
  const claim = portStore.claim;
  portStore.claim = async value => { claiming(); await gate; return claim(value); };
  const opening = listenLoopback({ portStore, portRange: { min: selected, maxExclusive: selected + 1 }, createHandler: () => () => new Response('ok') });
  try {
    await entered;
    expect((await fetch(`http://127.0.0.1:${selected}`)).status).toBe(503);
  } finally { release(); }
  const first = await opening;
  cleanups.push(first.close);
  await first.close();
  const second = await listenLoopback({ portStore, createHandler: () => () => new Response('ok') });
  cleanups.push(second.close);
  expect(second.serverUrl).toBe(first.serverUrl);
  expect(await portStore.read()).toBe(selected);
});

it('never redraws an assigned occupied port and does not commit a failed new bind', async () => {
  const { selected } = await start();
  const persisted = store(selected);
  await expect(listenLoopback({ portStore: persisted, createHandler: () => () => new Response() })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(persisted.claim).not.toHaveBeenCalled();
  const fresh = store();
  await expect(listenLoopback({ portStore: fresh, portRange: { min: selected, maxExclusive: selected + 1 }, createHandler: () => () => new Response() })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(fresh.claim).not.toHaveBeenCalled();
});

it('closes a losing candidate and binds the durable winner once', async () => {
  const candidate = await availablePort();
  const winner = await availablePort();
  let value: number | null = null;
  const listener = await listenLoopback({ portStore: { read: async () => value, claim: async () => value = winner },
    portRange: { min: candidate, maxExclusive: candidate + 1 }, createHandler: () => () => new Response('won') });
  cleanups.push(listener.close);
  expect(listener.serverUrl).toBe(`http://127.0.0.1:${winner}`);
  const replacement = await listenLoopback({ portStore: store(candidate), createHandler: () => () => new Response() });
  cleanups.push(replacement.close);
});

it('allows only the socket owner to serve when two processes race to claim one identity', async () => {
  const firstPort = await availablePort();
  let secondPort = await availablePort();
  while (secondPort === firstPort) secondPort = await availablePort();
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  let assigned: number | null = null;
  const shared: LoopbackPortStore = {
    read: async () => {
      if (++reads <= 2) { if (reads === 2) release(); await bothRead; return null; }
      return assigned;
    },
    claim: async candidate => assigned ??= candidate,
  };
  const createHandler = vi.fn(() => () => new Response('owned'));
  const results = await Promise.allSettled([firstPort, secondPort].map(selected => listenLoopback({
    portStore: shared, portRange: { min: selected, maxExclusive: selected + 1 }, createHandler,
  })));
  const success = results.filter(result => result.status === 'fulfilled');
  for (const result of success) cleanups.push(result.value.close);
  expect(success).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EADDRINUSE' } });
  expect(createHandler).toHaveBeenCalledTimes(1);
  expect(await (await fetch(success[0]!.value.serverUrl)).text()).toBe('owned');
  const loserPort = assigned === firstPort ? secondPort : firstPort;
  const replacement = await listenLoopback({ portStore: store(loserPort), createHandler: () => () => new Response() });
  cleanups.push(replacement.close);
});

it('releases the socket on persistence failure, readback mismatch and abort during pending claim', async () => {
  const selected = await availablePort();
  for (const failure of ['throw', 'mismatch', 'abort']) {
    const controller = new AbortController();
    let calls = 0;
    const portStore: LoopbackPortStore = {
      read: async () => ++calls === 1 ? null : selected + 1,
      claim: async () => {
        if (failure === 'throw') throw new Error('write failed');
        if (failure === 'abort') { controller.abort(new Error('cancelled')); await new Promise(() => {}); }
        return selected;
      },
    };
    await expect(listenLoopback({ portStore, signal: controller.signal, portRange: { min: selected, maxExclusive: selected + 1 }, createHandler: () => () => new Response() })).rejects.toThrow();
    const reusable = await listenLoopback({ portStore: store(selected), createHandler: () => () => new Response() });
    await reusable.close();
  }
});

it('mounts the embedded SDK and accepts native-fetch daemon pairing and long polling', async () => {
  const sdk = createByokServer({ productId: 'loopback-test', longPollHoldMs: 20 });
  cleanups.push(() => sdk.close());
  const selected = await availablePort();
  const listener: LoopbackListener = await listenLoopback({ portStore: store(selected), createHandler: () => request => sdk.hono.fetch(request) });
  cleanups.push(listener.close);
  const daemon = await connectFakeDaemonLongPoll(listener.serverUrl, sdk, { productId: 'loopback-test' });
  expect((await sdk.machines.list())[0]?.deviceId).toBe(daemon.deviceId);
});


it('retries a real new-identity collision on a different port and removes failed bind callbacks', async () => {
  // Reserve two adjacent real sockets. Whichever random candidate is drawn
  // first must collide; release only its neighbour after the kernel error.
  const held = [createServer(), createServer()];
  const closeHeld = async (server: Server) => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  cleanups.push(async () => { for (const server of held) await closeHeld(server); });
  let first = 0;
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { held[0]!.off('error', reject); resolve(); };
      held[0]!.once('error', reject);
      held[0]!.listen(0, '127.0.0.1', ready);
    });
    first = (held[0]!.address() as { port: number }).port;
    if (first === 65535) { await closeHeld(held[0]!); continue; }
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { held[1]!.off('listening', ready); reject(error); };
        const ready = () => { held[1]!.off('error', failed); resolve(); };
        held[1]!.once('error', failed);
        held[1]!.once('listening', ready);
        held[1]!.listen(first + 1, '127.0.0.1');
      });
      break;
    } catch (error) {
      await closeHeld(held[0]!);
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  expect(held.every(server => server.listening)).toBe(true);
  // Node itself installs setupConnectionsTracking on HTTP servers. Preserve
  // native listeners while proving that the SDK's pending ready callback left.
  const nativeListening = createServer().listeners('listening');
  const attempts: Array<{ server: Server; port: number }> = [];
  const collisions: string[] = [];
  let released: Promise<void> | undefined;
  const original = Server.prototype.listen;
  const spy = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: Parameters<typeof original>) {
    const selected = (args[0] as unknown as { port: number }).port;
    attempts.push({ server: this, port: selected });
    if (attempts.length === 1) this.once('error', (error: NodeJS.ErrnoException) => {
      collisions.push(error.code!);
      released = closeHeld(held[selected === first ? 1 : 0]!);
    });
    // Pass through to the real kernel. No fake bind result, timer or port RNG.
    return original.apply(this, args);
  });
  const portStore = store();
  try {
    const listener = await listenLoopback({ portStore,
      portRange: { min: first, maxExclusive: first + 2 },
      createHandler: () => () => new Response('retried'),
    });
    cleanups.push(listener.close);
    await released;
    expect(collisions).toEqual(['EADDRINUSE']);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.port).not.toBe(attempts[0]!.port);
    expect(attempts[0]!.server.listening).toBe(false);
    expect(attempts[0]!.server.listeners('listening')).toEqual(nativeListening);
    expect(attempts[0]!.server.listenerCount('error')).toBe(0);
    expect(portStore.claim).toHaveBeenCalledExactlyOnceWith(attempts[1]!.port);
    expect(await portStore.read()).toBe(attempts[1]!.port);
    expect(await (await fetch(listener.serverUrl)).text()).toBe('retried');
  } finally { spy.mockRestore(); }
});
