import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { MethodHandlers, MethodTable } from './domain.ts';
import { BRIDGE_VERSION, BridgeError, decodeMessage, encodeMessage, type BridgeResponse, type HostMethods } from './protocol.ts';

/** What a Host implements behind the bridge. Params are validated by each method handler, at the Host boundary. */
export interface BridgeHandlers<M extends MethodTable<M> = HostMethods> {
  /** Called once, after main's hello passed; the Host starts its work only then. */
  greeted(): void;
  /** Every method besides `hello` and `shutdown`. A method not listed here is refused as `unknown_method`. */
  methods: MethodHandlers<M>;
  /** Stops the Host; the bridge replies, then stops reading. */
  shutdown(): Promise<void>;
}

/** A handler failure answers its call only; the bridge keeps serving. */
const callFailure = (error: unknown): BridgeError => error instanceof BridgeError && error.code === 'invalid_params'
  ? error
  : new BridgeError('method_failed', error instanceof Error ? error.message : String(error));

/**
 * The Host's end of the bridge. Resolves after `shutdown` or when main closes
 * the pipe; rejects after replying to a hello from another bridge version, or on
 * a malformed line, so the Host exits non-zero.
 */
export function serveBridge<M extends MethodTable<M> = HostMethods>(handlers: BridgeHandlers<M>, io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  const lines = createInterface({ input: io.input });
  const reply = (response: BridgeResponse) => io.output.write(encodeMessage(response));
  let greeted = false;
  return new Promise((resolve, reject) => {
    const stop = (error?: BridgeError) => {
      // Settle before close: closing emits 'close', which would resolve first.
      if (error) reject(error);
      else resolve();
      lines.close();
      io.input.destroy();
    };
    lines.on('close', () => resolve());
    lines.on('line', line => void (async () => {
      let id = 0;
      try {
        const message = decodeMessage(line);
        id = message.id;
        if (message.method === 'hello') {
          const params = message.params as { bridgeVersion?: unknown } | undefined;
          if (params?.bridgeVersion !== BRIDGE_VERSION) {
            throw new BridgeError('bridge_version_mismatch', `Shell bridge version ${String(params?.bridgeVersion)} differs from Host version ${BRIDGE_VERSION}`);
          }
          reply({ id, result: { bridgeVersion: BRIDGE_VERSION } });
          if (!greeted) handlers.greeted();
          greeted = true;
          return;
        }
        if (!greeted) throw new BridgeError('hello_required', 'The first bridge call must be hello');
        if (message.method === 'shutdown') {
          await handlers.shutdown();
          reply({ id, result: null });
          stop();
          return;
        }
        const method = typeof message.method === 'string' && Object.hasOwn(handlers.methods, message.method)
          ? (handlers.methods as Record<string, (params: unknown) => unknown>)[message.method]
          : undefined;
        if (!method) {
          reply({ id, error: { code: 'unknown_method', message: `Unknown bridge method ${String(message.method)}` } });
          return;
        }
        let result: unknown;
        try {
          result = await method(message.params);
        } catch (error) {
          const failure = callFailure(error);
          reply({ id, error: { code: failure.code, message: failure.message } });
          return;
        }
        reply({ id, result });
      } catch (error) {
        const failure = error instanceof BridgeError ? error : new BridgeError('invalid_message', String(error));
        reply({ id, error: { code: failure.code, message: failure.message } });
        stop(failure);
      }
    })());
  });
}
