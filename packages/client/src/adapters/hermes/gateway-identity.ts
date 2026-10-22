import { createHash } from 'node:crypto';
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
 * Hermes's Windows control pipe for a home (`windows_pipe_name` in
 * `gateway/control_socket.py`): the first 16 hex digits of the SHA-256 of the
 * home's real path, normalized as `os.path.normcase` does (backslashes,
 * lower case). `realHome` must be the native real path, so that an 8.3 short
 * form names the same pipe as the long form Hermes resolves.
 */
export function hermesGatewayPipeName(realHome: string): string {
  const key = realHome.replaceAll('/', '\\').toLowerCase();
  return `\\\\.\\pipe\\hermes-gateway-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Whether the gateway names `served` (a real path) among its profiles. Windows paths compare without case. */
export function servesHermesHome(identity: HermesGatewayIdentity, served: string): boolean {
  const key = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  return identity.servedHomes.some((home) => key(home) === key(served));
}

async function controlPath(home: string): Promise<string> {
  if (process.platform === 'win32') return hermesGatewayPipeName(await fs.realpath(home).catch(() => path.resolve(home)));
  const direct = path.join(home, 'gateway.sock');
  return fs.lstat(direct).then(
    () => direct,
    () => fs.readFile(path.join(home, 'gateway.sock.path'), 'utf8').then((text) => text.trim(), () => direct),
  );
}

/**
 * Asks the gateway that serves `home` who it is, over its control channel.
 * POSIX: the Unix socket `<home>/gateway.sock`, else the path written in
 * `<home>/gateway.sock.path` when the direct path is too long for a Unix
 * socket. Windows: the named pipe {@link hermesGatewayPipeName}. The Hermes ACP
 * viewer reads the same answer before it attaches. Undefined: no gateway
 * answered.
 */
export async function identifyHermesGateway(home: string, timeoutMs = 1_000): Promise<HermesGatewayIdentity | undefined> {
  const socketPath = await controlPath(home);
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
