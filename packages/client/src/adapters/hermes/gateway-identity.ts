import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** The fields of a Hermes gateway `identify` answer that the adapter checks. */
export interface HermesGatewayIdentity {
  readonly pid: number;
  readonly state: string;
  readonly servedHomes: readonly string[];
}

/**
 * Asks the gateway that serves `home` who it is, over its control socket:
 * `<home>/gateway.sock`, else the path written in `<home>/gateway.sock.path`
 * when the direct path is too long for a Unix socket. The Hermes ACP viewer
 * reads the same answer before it attaches. Undefined: no gateway answered.
 */
export async function identifyHermesGateway(home: string, timeoutMs = 1_000): Promise<HermesGatewayIdentity | undefined> {
  const direct = path.join(home, 'gateway.sock');
  const socketPath = await fs.lstat(direct).then(
    () => direct,
    () => fs.readFile(path.join(home, 'gateway.sock.path'), 'utf8').then((text) => text.trim(), () => direct),
  );
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const finish = (value: HermesGatewayIdentity | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const socket = net.createConnection({ path: socketPath });
    socket.on('connect', () => socket.write(`${JSON.stringify({ protocol: 1, id: 1, verb: 'identify' })}\n`));
    socket.on('error', () => finish(undefined));
    socket.on('close', () => finish(undefined));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 256 * 1024) return finish(undefined);
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const result = (JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, unknown> }).result;
        const served = Array.isArray(result?.served_profiles) ? result.served_profiles : [];
        finish(typeof result?.pid === 'number' && typeof result.state === 'string'
          ? {
              pid: result.pid,
              state: result.state,
              servedHomes: served.flatMap((entry) => {
                const home = (entry as { home?: unknown } | null)?.home;
                return typeof home === 'string' ? [home] : [];
              }),
            }
          : undefined);
      } catch {
        finish(undefined);
      }
    });
  });
}
