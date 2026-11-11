/**
 * The Host child: serves the bridge on stdio around the composed server and
 * daemon. Main runs it under Node in dev; the packaged SEA Host arrives with
 * #1811. stdout carries only bridge lines, so diagnostics go to stderr.
 */
import type { Readable, Writable } from 'node:stream';
import { bundledSdkHelperHost, resolveHostLayout, runSdkReservedHelperCommand } from '@byok-sdk/client';
import brand from '../../brand.config.ts';
import manifest from '../../package.json' with { type: 'json' };
import { encodeMessage, type HostState } from '../bridge/protocol.ts';
import { serveBridge, type BridgeHandlers } from '../bridge/server.ts';
import { composeHost, HostStoppedError, type ComposedHost, type HostCompositionOptions } from './compose.ts';
import { HostStoreRefusedError } from './precheck.ts';

/**
 * Composes the Host after main's hello and pushes its state on every change.
 * Resolves once the Host is closed after main's `shutdown` or a closed pipe.
 * A refused store or a daemon halt leaves the Host `stopped` with the reason
 * and nothing composed; any other composition failure rejects, so the process
 * exits non-zero and main restarts it.
 */
export async function superviseHost(
  options: HostCompositionOptions,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  let state: HostState = { state: 'starting', pid: process.pid };
  const push = (next: HostState) => {
    state = next;
    io.output.write(encodeMessage({ event: 'state', state }));
  };
  let composing: Promise<ComposedHost | undefined> = Promise.resolve(undefined);
  /** The composed Host while it serves domain calls: set once composed, cleared when closing starts. */
  let running: ComposedHost | undefined;
  let crash: (error: unknown) => void = () => {};
  const crashed = new Promise<never>((_resolve, reject) => { crash = reject; });

  const compose = async (): Promise<ComposedHost | undefined> => {
    let host: ComposedHost;
    try {
      host = await composeHost(options);
    } catch (error) {
      if (!(error instanceof HostStoreRefusedError || error instanceof HostStoppedError)) throw error;
      push({ state: 'stopped', pid: process.pid, reason: error.message });
      return undefined;
    }
    const observe = () => {
      const status = host.daemon.status();
      const next: HostState = status.lifecycle.phase === 'halted'
        ? { state: 'stopped', pid: process.pid, reason: `Daemon halted: ${status.lifecycle.reason}` }
        : { state: 'running', pid: process.pid, activeWork: status.activeTaskCount };
      if (JSON.stringify(next) !== JSON.stringify(state)) push(next);
    };
    host.daemon.subscribe(observe);
    observe();
    if (!closing) running = host;
    return host;
  };

  let closing: Promise<void> | undefined;
  const close = () => {
    running = undefined;
    return closing ??= composing.then(host => host?.close());
  };

  await Promise.race([crashed, serveBridge({
    greeted: () => {
      push(state);
      composing = compose();
      composing.catch(crash);
    },
    // Read on every call: the domain methods exist only while the Host runs, and are `unknown_method` before.
    get methods() { return { status: () => state, ...running?.domains.handlers } as BridgeHandlers['methods']; },
    shutdown: close,
  }, io)]);
  await close();
}

if (import.meta.main && !await runSdkReservedHelperCommand()) {
  const layout = resolveHostLayout({ productId: brand.productId, productName: brand.productName });
  // Exit only after stdout has flushed the last bridge line: pipes are asynchronous on macOS.
  const exit = (code: number) => process.stdout.write('', () => process.exit(code));
  superviseHost({
    productId: brand.productId,
    productName: brand.productName,
    releaseVersion: manifest.version,
    storeDir: layout.storeDir,
    hostStorageRoot: layout.hostStorageRoot,
    sdkHelperHost: bundledSdkHelperHost(),
  }).then(() => exit(0), (error: Error) => {
    console.error(`Host stopped: ${error.stack ?? error.message}`);
    exit(1);
  });
}
