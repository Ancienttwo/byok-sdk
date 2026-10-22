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

async function socketPath(home: string): Promise<string> {
  const direct = path.join(home, 'gateway.sock');
  return fs.lstat(direct).then(
    () => direct,
    () => fs.readFile(path.join(home, 'gateway.sock.path'), 'utf8').then((text) => text.trim(), () => direct),
  );
}

const IDENTIFY_REQUEST = `${JSON.stringify({ protocol: 1, id: 1, verb: 'identify' })}\n`;

function parseIdentity(line: string): HermesGatewayIdentity | undefined {
  try {
    const result = (JSON.parse(line) as { result?: Record<string, unknown> }).result;
    const served = Array.isArray(result?.served_profiles) ? result.served_profiles : [];
    return typeof result?.pid === 'number' && typeof result.state === 'string'
      ? {
          pid: result.pid,
          state: result.state,
          servedHomes: served.flatMap((entry) => {
            const home = (entry as { home?: unknown } | null)?.home;
            return typeof home === 'string' ? [home] : [];
          }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface IdentifyHermesGatewayOptions {
  timeoutMs?: number;
  /**
   * Windows: the server pids the caller owns. The kernel names the server;
   * only an owned server receives the request. Any other server yields
   * `{ pid: <server pid>, state: 'unverified', servedHomes: [] }`, and an
   * owned server whose answer names another pid yields `state: 'mismatch'`.
   * On Windows `pid` is always the kernel's server pid. POSIX ignores it:
   * only this execution can reach the profile directory.
   */
  owned?: (serverPid: number) => boolean;
  nativeAssetRoot?: string;
}

/** Windows: one exchange with the koffi pipe client (`gateway-pipe-win32.ts`). */
async function identifyOverPipe(home: string, options: IdentifyHermesGatewayOptions): Promise<HermesGatewayIdentity | undefined> {
  const { exchangeHermesPipe } = await import('./gateway-pipe-win32');
  const name = hermesGatewayPipeName(await fs.realpath(home).catch(() => path.resolve(home)));
  const answer = await exchangeHermesPipe(name, IDENTIFY_REQUEST, options.owned ?? (() => false), Date.now() + (options.timeoutMs ?? 1_000), options.nativeAssetRoot);
  if (answer === undefined) return undefined;
  const identity = answer.line === undefined ? undefined : parseIdentity(answer.line);
  if (identity === undefined) return { pid: answer.serverPid, state: 'unverified', servedHomes: [] };
  // The server names another process than the kernel does: it is not the gateway it claims to be.
  return identity.pid === answer.serverPid ? identity : { pid: answer.serverPid, state: 'mismatch', servedHomes: [] };
}

/**
 * Asks the gateway that serves `home` who it is, over its control channel.
 * POSIX: the Unix socket `<home>/gateway.sock`, else the path written in
 * `<home>/gateway.sock.path` when the direct path is too long for a Unix
 * socket. Windows: the named pipe {@link hermesGatewayPipeName}, see
 * {@link IdentifyHermesGatewayOptions.owned}. The Hermes ACP viewer reads the
 * same answer before it attaches. Undefined: no gateway answered.
 */
export async function identifyHermesGateway(home: string, options: IdentifyHermesGatewayOptions = {}): Promise<HermesGatewayIdentity | undefined> {
  if (process.platform === 'win32') return identifyOverPipe(home, options).catch(() => undefined);
  const target = await socketPath(home);
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
    const timer = setTimeout(() => finish(undefined), options.timeoutMs ?? 1_000);
    const socket = net.createConnection({ path: target });
    socket.on('connect', () => socket.write(IDENTIFY_REQUEST));
    socket.on('error', () => finish(undefined));
    socket.on('close', () => finish(undefined));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 256 * 1024) return finish(undefined);
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(parseIdentity(buffer.slice(0, newline)));
    });
  });
}
