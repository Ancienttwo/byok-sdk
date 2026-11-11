import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { BRIDGE_VERSION, BridgeError, decodeMessage, encodeMessage, type BridgeMethod, type BridgeMethods } from './protocol.ts';

/** A Host child spawned with piped stdin and stdout; stderr is the Host's diagnostics. */
export type HostChild = ChildProcessByStdio<Writable, Readable, null>;

interface Pending { resolve(value: unknown): void; reject(error: Error): void }

/** Main's end of the bridge to one Host child. */
export class BridgeClient {
  readonly #child: HostChild;
  readonly #pending = new Map<number, Pending>();
  readonly exited: Promise<number | null>;
  #nextId = 1;
  #closed: BridgeError | undefined;

  private constructor(child: HostChild) {
    this.#child = child;
    this.exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    void this.exited.then(code => this.#fail(new BridgeError('host_exited', `Host exited with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = decodeMessage(line);
        const pending = this.#pending.get(message.id);
        if (!pending) throw new BridgeError('invalid_message', `Bridge reply ${message.id} has no request`);
        this.#pending.delete(message.id);
        const error = message.error as { code: BridgeError['code']; message: string } | undefined;
        if (error) pending.reject(new BridgeError(error.code, error.message));
        else pending.resolve(message.result);
      } catch (error) {
        this.#fail(error as BridgeError);
        child.kill();
      }
    });
  }

  /** Says hello before any other call. A Host on another bridge version is killed and the connect rejects. */
  static async connect(child: HostChild): Promise<BridgeClient> {
    const client = new BridgeClient(child);
    try {
      const { bridgeVersion } = await client.call('hello', { bridgeVersion: BRIDGE_VERSION });
      if (bridgeVersion !== BRIDGE_VERSION) {
        throw new BridgeError('bridge_version_mismatch', `Host bridge version ${bridgeVersion} differs from shell version ${BRIDGE_VERSION}`);
      }
    } catch (error) {
      child.kill();
      throw error;
    }
    return client;
  }

  call<M extends BridgeMethod>(method: M, params: BridgeMethods[M]['params']): Promise<BridgeMethods[M]['result']> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#child.stdin.write(encodeMessage({ id, method, params }));
    });
  }

  kill(): void {
    this.#child.kill();
  }

  #fail(error: BridgeError): void {
    this.#closed ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#closed);
    this.#pending.clear();
  }
}
