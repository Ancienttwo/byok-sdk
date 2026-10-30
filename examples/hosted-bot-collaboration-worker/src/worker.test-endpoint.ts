import { createConnection, createServer, type Socket } from 'node:net';

/** Retains the device URL across abrupt runtime generations without releasing its port. */
export async function openWorkerEndpoint() {
  let target: number | undefined;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer(client => {
    track(client);
    if (target === undefined) { client.destroy(); return; }
    const upstream = track(createConnection({ host: '127.0.0.1', port: target }));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Worker endpoint has no TCP address');
  const disconnect = () => {
    target = undefined;
    for (const socket of sockets) socket.destroy();
  };
  let disposed: Promise<void> | undefined;
  return {
    base: `http://127.0.0.1:${address.port}`,
    connect(port: number) { target = port; },
    disconnect,
    dispose() {
      disconnect();
      disposed ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return disposed;
    },
  };
}

export type WorkerEndpoint = Awaited<ReturnType<typeof openWorkerEndpoint>>;

export async function verifyWorkerIdentity(base: string, identity: string): Promise<void> {
  const response = await fetch(`${base}/__test_ready/${identity}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  if (response.status !== 200 || body !== identity) throw new Error('Worker readiness identity mismatch');
}
