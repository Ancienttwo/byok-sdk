import { createServer as createHttpServer } from 'node:http';
import { createServer, Server } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { startWorker, type Substrate, type WorkerInstance } from './worker.test-support';
import { verifyWorkerIdentity } from './worker.test-endpoint';

// Readiness does not need database access; accidental product routes fail closed.
const substrate = {
  sdkSchema: 'harness_probe', hSchema: 'harness_probe', hostSchema: 'harness_probe',
  connectionString: 'postgres://unused:unused@127.0.0.1:1/unused',
} as Substrate;
let worker: WorkerInstance | undefined;
const holders: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await worker?.kill();
  await worker?.dispose?.();
  worker = undefined;
  await Promise.all(holders.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

for (const kind of ['occupied', 'foreign 404'] as const) {
  it(`owns its listener instead of handing a released port to a ${kind} server`, async () => {
    // Recreate the old freePort race deterministically: another process wins immediately
    // after a probe closes, before its callback returns the now-unowned number.
    const close = Server.prototype.close;
    let starting = true;
    vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      const address = this.address();
      if (!starting || address === null || typeof address === 'string') return close.call(this, callback);
      return close.call(this, () => {
        const holder = kind === 'occupied'
          ? createServer(socket => socket.destroy())
          : createHttpServer((_request, response) => { response.writeHead(404); response.end('foreign server'); });
        holders.push(holder);
        holder.listen(address.port, '127.0.0.1', () => callback?.());
      });
    });
    try { worker = await startWorker(substrate); }
    finally { starting = false; }
    expect(holders).toHaveLength(0);
    const response = await fetch(worker.base);
    expect(await response.text()).toContain('routes: /byok/*');
    const port = Number(new URL(worker.base).port);
    const contender = createServer();
    await expect(new Promise<void>((resolve, reject) => {
      contender.once('error', reject);
      contender.listen(port, '127.0.0.1', resolve);
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await worker.dispose();
    worker = undefined;
    // Disposal returned only after the owned device listener became available.
    const reclaimed = createServer();
    holders.push(reclaimed);
    await new Promise<void>(resolve => reclaimed.listen(port, '127.0.0.1', resolve));
  });
}

it('rejects a foreign 404 as readiness, even on a reachable listener', async () => {
  const foreign = createHttpServer((_request, response) => { response.writeHead(404); response.end('foreign'); });
  holders.push(foreign);
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const address = foreign.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  await expect(verifyWorkerIdentity(`http://127.0.0.1:${address.port}`, 'our-instance')).rejects.toThrow('identity mismatch');
});

it('keeps the device listener owned across an abrupt generation restart', async () => {
  worker = await startWorker(substrate);
  const base = worker.base;
  await worker.kill();
  worker = await worker.restart();
  expect(worker.base).toBe(base);
  const response = await fetch(base);
  expect(await response.text()).toContain('routes: /byok/*');
});
