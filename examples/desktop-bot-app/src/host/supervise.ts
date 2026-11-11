/**
 * The Host child: serves the bridge on stdio around the composed server and
 * daemon. Its bundle (scripts/package/bundle-host.mjs) runs under Node in dev
 * and as the packaged SEA. stdout carries only bridge lines, so diagnostics go
 * to stderr.
 */
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { bundledSdkHelperHost, resolveHostLayout, runSdkReservedHelperCommand } from '@byok-sdk/client';
import brand from '../../brand.config.ts';
import manifest from '../../package.json' with { type: 'json' };
import { joinHandlers } from '../bridge/domain.ts';
import { encodeMessage, type HostState } from '../bridge/protocol.ts';
import { serveBridge, type BridgeHandlers } from '../bridge/server.ts';
import { composeHost, HostStoppedError, type ComposedHost, type HostCompositionOptions } from './compose.ts';
import { runKeysCommand } from './keys/commands.ts';
import { HostStoreRefusedError } from './precheck.ts';

/**
 * Composes the Host after main's hello and pushes its state on every change,
 * and again, unchanged, whenever a domain's views changed (main turns each push
 * into one coalesced renderer hint). Resolves once the Host is closed after
 * main's `shutdown` or a closed pipe. A missing SDK asset, a refused store, a
 * refused embedded pairing or a daemon halt leaves the Host `stopped` with the
 * reason and nothing composed; any other composition failure rejects, so the
 * process exits non-zero and main restarts it.
 */
export async function superviseHost(
  options: Omit<HostCompositionOptions, 'onChanged'>,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  let state: HostState = { state: 'starting', pid: process.pid };
  const push = (next: HostState) => {
    state = next;
    io.output.write(encodeMessage({ event: 'state', state }));
  };
  let composing: Promise<ComposedHost | undefined> = Promise.resolve(undefined);
  const status = () => state;
  /** The bridge methods: `status`, and the domain methods while the Host runs (cleared when closing starts). */
  let methods: Record<string, (params: unknown) => unknown> = { status };
  /** Domain calls in flight; closing waits for them before the domains close. */
  const inflight = new Set<Promise<unknown>>();
  const track = (handler: (params: unknown) => unknown) => (params: unknown) => {
    const call = Promise.resolve().then(() => handler(params));
    inflight.add(call);
    // The caller gets the outcome through the bridge reply; this only forgets the settled call.
    call.then(() => inflight.delete(call), () => inflight.delete(call));
    return call;
  };
  let crash: (error: unknown) => void = () => {};
  const crashed = new Promise<never>((_resolve, reject) => { crash = reject; });

  const compose = async (): Promise<ComposedHost | undefined> => {
    let host: ComposedHost;
    try {
      // A domain's view change re-sends the unchanged state: main turns every state push into one coalesced renderer hint.
      host = await composeHost({ ...options, onChanged: () => push(state) });
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
    let served: typeof methods;
    try {
      served = joinHandlers({ status }, Object.fromEntries(Object.entries(host.domains.handlers).map(([name, handler]) => [name, track(handler as (params: unknown) => unknown)])));
    } catch (error) {
      await host.close();
      throw error;
    }
    host.daemon.subscribe(observe);
    observe();
    if (!closing) methods = served;
    return host;
  };

  let closing: Promise<void> | undefined;
  const close = () => {
    methods = { status };
    return closing ??= (async () => {
      const host = await composing;
      await Promise.allSettled(inflight);
      await host?.close();
    })();
  };

  await Promise.race([crashed, serveBridge({
    greeted: () => {
      push(state);
      composing = compose();
      composing.catch(crash);
    },
    // Read on every call: the domain methods exist only while the Host runs, and are `unknown_method` before and after.
    get methods() { return methods as BridgeHandlers['methods']; },
    shutdown: close,
  }, io)]);
  await close();
}

/** bundle-host.mjs writes the SDK assets beside the Host executable: the CommonJS bundle in dev, the SEA in a package. */
function hostedBesideExecutable(): HostCompositionOptions['sdkHosting'] {
  const helperHost = bundledSdkHelperHost();
  return { assetRoot: path.dirname(helperHost.entry ?? helperHost.executable), helperHost };
}

/** Runs this process as the SDK helper or keys command its argv names; otherwise as the Host, exiting 0 once it closed. */
async function main(exit: (code: number) => void): Promise<void> {
  if (await runSdkReservedHelperCommand()) return;
  const layout = resolveHostLayout({ productId: brand.productId, productName: brand.productName });
  const keysExit = await runKeysCommand(process.argv.slice(2), layout.hostStorageRoot);
  if (keysExit !== undefined) {
    exit(keysExit);
    return;
  }
  await superviseHost({
    productId: brand.productId,
    productName: brand.productName,
    releaseVersion: manifest.version,
    storeDir: layout.storeDir,
    hostStorageRoot: layout.hostStorageRoot,
    sdkHosting: hostedBesideExecutable(),
  });
  exit(0);
}

// No top-level await: the Host also runs as a CommonJS bundle and inside a SEA (scripts/package/bundle-host.mjs).
if (import.meta.main) {
  // Exit only after stdout has flushed the last bridge line: pipes are asynchronous on macOS.
  const exit = (code: number) => process.stdout.write('', () => process.exit(code));
  main(exit).catch((error: Error) => {
    console.error(`Host stopped: ${error.stack ?? error.message}`);
    exit(1);
  });
}
