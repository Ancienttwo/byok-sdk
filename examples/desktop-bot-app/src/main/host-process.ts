import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeClient, type HostChild } from '../bridge/client.ts';
import { BridgeError, type BridgeMethod, type BridgeMethods, type HostState } from '../bridge/protocol.ts';

/** The Host's own state, or main's view while no Host answers: restarting after a crash, or failed for good. */
export type SupervisedHostState =
  | HostState
  | { readonly state: 'restarting'; readonly inMs: number; readonly reason: string }
  | { readonly state: 'failed'; readonly reason: string };

export interface HostProcessOptions {
  /** Spawns one Host child with piped stdin and stdout. */
  readonly spawnHost: () => HostChild;
  readonly onState: (state: SupervisedHostState) => void;
  /** First restart delay; each further crash doubles it up to `maxBackoffMs`. */
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** A Host that ran at least this long restarts from `initialBackoffMs` again. */
  readonly backoffResetMs?: number;
  /** How long `stop` waits for an acknowledged shutdown before it kills the Host. */
  readonly shutdownGraceMs?: number;
}

/**
 * Dev mode: the Host bundle (`bun run build:host`, dist/host/) runs under the
 * Node on PATH, never under Electron's own binary (RunAsNode is fused off).
 * A package runs the same bundle as a SEA.
 */
export function spawnDevHost(): HostChild {
  const entry = fileURLToPath(new URL('../../host/host.cjs', import.meta.url));
  return spawn('node', [entry], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
}

/**
 * Main's supervisor of the Host child. A Host that exits unasked, or fails to
 * connect, restarts with exponential backoff; a bridge version mismatch cannot
 * heal by restarting, so it ends supervision as `failed`. A Host that reports
 * `stopped` keeps running and is not restarted: its reason stays readable.
 */
export class HostProcess {
  readonly #options: Required<HostProcessOptions>;
  #child: HostChild | undefined;
  #client: BridgeClient | undefined;
  #launching: Promise<void> = Promise.resolve();
  #restartTimer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #stopping = false;

  constructor(options: HostProcessOptions) {
    this.#options = { initialBackoffMs: 1_000, maxBackoffMs: 30_000, backoffResetMs: 60_000, shutdownGraceMs: 10_000, ...options };
  }

  start(): void {
    this.#launching = this.#launch();
  }

  call<M extends BridgeMethod>(method: M, params: BridgeMethods[M]['params']): Promise<BridgeMethods[M]['result']> {
    if (!this.#client) return Promise.reject(new BridgeError('host_exited', 'No Host is running'));
    return this.#client.call(method, params);
  }

  /**
   * Asks the Host to shut down. Resolves only when the Host acknowledged it
   * and exited 0; a Host still running after the grace period is killed and
   * this rejects, as does any other failed shutdown.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    const child = this.#child;
    if (!child) return;
    // Armed on the spawned child, so a Host that never answers hello is killed too.
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, this.#options.shutdownGraceMs);
    try {
      // A Host that is saying hello now gets the same acknowledged shutdown.
      await this.#launching;
      const client = this.#client;
      if (!client) {
        if (killed) throw new Error('Host never answered hello');
        return;
      }
      await client.call('shutdown', undefined);
      const code = await client.exited;
      if (code !== 0) throw new Error(`Host exited with code ${code} after shutdown`);
    } catch (error) {
      child.kill();
      if (killed) throw new Error(`Host did not shut down within ${this.#options.shutdownGraceMs} ms`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #launch(): Promise<void> {
    const startedAt = Date.now();
    let client: BridgeClient;
    try {
      this.#child = this.#options.spawnHost();
      client = await BridgeClient.connect(this.#child, this.#options.onState);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'bridge_version_mismatch') {
        this.#options.onState({ state: 'failed', reason: error.message });
        return;
      }
      this.#restart(startedAt, (error as Error).message);
      return;
    }
    this.#client = client;
    void client.exited.then(code => {
      this.#client = undefined;
      this.#child = undefined;
      this.#restart(startedAt, `Host exited with code ${code}`);
    });
  }

  #restart(startedAt: number, reason: string): void {
    if (this.#stopping) return;
    if (Date.now() - startedAt >= this.#options.backoffResetMs) this.#attempt = 0;
    const inMs = Math.min(this.#options.initialBackoffMs * 2 ** this.#attempt, this.#options.maxBackoffMs);
    this.#attempt += 1;
    this.#options.onState({ state: 'restarting', inMs, reason });
    this.#restartTimer = setTimeout(() => { this.#launching = this.#launch(); }, inMs);
  }
}
