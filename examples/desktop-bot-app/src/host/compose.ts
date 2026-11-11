import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDaemonWithAdapters, DaemonHaltError, EmbeddedPairingError, resolveSdkHosting, SdkHostingAssetsMissingError,
  type Daemon, type DaemonConfig, type DeviceCredentialBackend, type RuntimeEnvironmentPolicy, type SdkHosting, type SdkHostingOptions,
} from '@byok-sdk/client';
import { createRuntimeAdapters } from '@byok-sdk/client/adapters';
import { createBotPersonaProjection } from '@byok-sdk/example-bot-collaboration';
import { createByokServer, listenLoopback, type LoopbackPortStore } from '@byok-sdk/server';
import { AGENT_EGRESS_POLICY } from './conversation/catalog.ts';
import { composeDomains, type ComposedDomains, type ServerConsumers } from './domains.ts';
import { keysDbPath, piByokLauncher } from './keys/launcher.ts';
import { precheckHostStores } from './precheck.ts';

export interface HostCompositionOptions {
  readonly productId: string;
  readonly productName: string;
  /** The app's release version, reported as the daemon's Local Agent release. */
  readonly releaseVersion: string;
  /** `resolveHostLayout` output: the SDK's `storeDir` and the Host's `hostStorageRoot`. */
  readonly storeDir: string;
  readonly hostStorageRoot: string;
  /**
   * This Host's SDK asset root and the re-entry of its own executable for SDK helpers (`resolveSdkHosting` input).
   * Omitted, the Host runs without SDK assets, as the tests do.
   */
  readonly sdkHosting?: SdkHostingOptions;
  /** Enrollment custody; omitted, the daemon uses this product's OS credential store. */
  readonly deviceCredentials?: DeviceCredentialBackend;
  /** Called when a bridge domain's views changed (`HostContext.changed`). */
  readonly onChanged: () => void;
}

/** The running server, daemon and bridge domains of one Host process. */
export interface ComposedHost {
  readonly daemon: Daemon;
  readonly domains: ComposedDomains;
  /** Closes the domains, then stops the daemon, the loopback listener and the server. */
  close(): Promise<void>;
}

/** The Host cannot run with this store or enrollment; restarting would fail the same way. */
export class HostStoppedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostStoppedError';
  }
}

/**
 * Desktop apps start without the user's login shell, so every runtime takes
 * its environment from it. Pi gets the same policy and no `PI_PACKAGE_DIR`:
 * the SDK sets that from `runtimes.pi.packageDir` (the asset root's) alone.
 */
const LOGIN_SHELL: RuntimeEnvironmentPolicy = { base: 'login-shell' };

/** The loopback port, claimed once and kept beside the Host stores; a damaged file stops the Host. */
function filePortStore(file: string): LoopbackPortStore {
  const read = async (): Promise<number | null> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const port = Number(text);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new HostStoppedError(`Loopback port file ${file} is damaged`);
    return port;
  };
  return {
    read,
    claim: async candidate => {
      let handle;
      try {
        handle = await open(file, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const port = await read();
        if (port === null) throw new HostStoppedError(`Loopback port file ${file} vanished during claim`);
        return port;
      }
      try {
        await handle.writeFile(String(candidate));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return candidate;
    },
  };
}

type ServerOptions = Parameters<typeof createByokServer>[0];

/**
 * The embedded server's wake and Agent message consumers, bound later. The server delivers wakes from its creation (a
 * wake left due by the last run, at once) and Agent messages once the daemon runs, both before the k8 domain binds its
 * consumers: a delivery waits for the binding, and one still waiting when the Host closes is refused, so the server
 * retries it on the next run.
 */
export function lateServerConsumers(): {
  readonly wake: NonNullable<ServerOptions['wake']>;
  readonly agentMessage: NonNullable<ServerOptions['agentMessage']>;
  bind(consumers: ServerConsumers): void;
  refuse(reason: Error): void;
} {
  let bind!: (consumers: ServerConsumers) => void;
  let refuse!: (reason: Error) => void;
  const consumers = new Promise<ServerConsumers>((resolve, reject) => { bind = resolve; refuse = reject; });
  // Every waiting delivery gets the refusal; with none waiting, it is not an unhandled rejection.
  consumers.catch(() => {});
  let bound = false;
  return {
    wake: {
      consume: async (wake, signal) => {
        const ready = await consumers;
        // The server gave up on this delivery while it waited.
        signal.throwIfAborted();
        return ready.consume(wake, signal);
      },
    },
    agentMessage: { consume: async input => (await consumers).consumeMessage(input) },
    bind: next => {
      if (bound) throw new Error('Server consumers are already bound');
      bound = true;
      bind(next);
    },
    refuse,
  };
}

/** A missing SDK asset cannot heal by restarting: the Host stops with the missing paths. */
function hostingOf(options: SdkHostingOptions | undefined): SdkHosting | undefined {
  try {
    return options && resolveSdkHosting(options);
  } catch (error) {
    if (error instanceof SdkHostingAssetsMissingError) throw new HostStoppedError(error.message, { cause: error });
    throw error;
  }
}

/**
 * Resolves the SDK assets, prechecks the stores, then composes the embedded server on loopback and the daemon paired
 * to it (#1499 s1.4). Pairing is the daemon's own reconciliation with this server (`pairEmbedded`): a fresh store pairs
 * against an empty server, a paired store whose device the server lists goes on, and every other state stops the Host.
 */
export async function composeHost(options: HostCompositionOptions): Promise<ComposedHost> {
  const hosting = hostingOf(options.sdkHosting);
  const hostDir = path.join(options.hostStorageRoot, 'host');
  const serverDb = path.join(hostDir, 'server.sqlite');
  await precheckHostStores({ storeDir: options.storeDir, serverDb, keysDb: keysDbPath(options.hostStorageRoot) });
  await mkdir(hostDir, { recursive: true, mode: 0o700 });

  const late = lateServerConsumers();
  const server = createByokServer({
    productId: options.productId, storage: { kind: 'sqlite', path: serverDb },
    wake: late.wake, agentMessage: late.agentMessage,
  });
  const listener = await listenLoopback({
    portStore: filePortStore(path.join(hostDir, 'loopback-port')),
    createHandler: () => request => server.hono.fetch(request),
  }).catch(async (error: unknown) => {
    await server.close();
    throw error;
  });
  let daemon: Daemon | undefined;
  let domains: ComposedDomains | undefined;
  const close = async () => {
    late.refuse(new Error('The Host closed before the conversation opened'));
    try {
      await domains?.close();
    } finally {
      await stopDaemon();
    }
  };
  const stopDaemon = async () => {
    try {
      await daemon?.stop();
    } finally {
      await listener.close();
      await server.close();
    }
  };
  try {
    const launcher = hosting ? { piByokLauncher: piByokLauncher(hosting.daemon.sdkHelperHost, options.hostStorageRoot) } : {};
    const adapters = createRuntimeAdapters({
      ...hosting?.adapters,
      ...launcher,
      runtimes: {
        pi: { ...hosting?.adapters.runtimes.pi, runtimeEnvironment: LOGIN_SHELL },
        claude: { runtimeEnvironment: LOGIN_SHELL },
        codex: { runtimeEnvironment: LOGIN_SHELL },
      },
    });
    const daemonConfig: DaemonConfig = {
      productId: options.productId,
      productName: options.productName,
      serverUrl: listener.serverUrl,
      storeDir: options.storeDir,
      // K8 projects each Bot's persona into its Agent home; without it no Bot becomes ready.
      agentHome: { hostStorageRoot: options.hostStorageRoot, projection: createBotPersonaProjection() },
      agentEgress: { policy: AGENT_EGRESS_POLICY },
      localAgentRelease: { version: options.releaseVersion },
      ...hosting?.daemon,
      ...launcher,
    };
    daemon = createDaemonWithAdapters(daemonConfig, adapters, options.deviceCredentials ? { deviceCredentials: options.deviceCredentials } : {});
    const started = daemon;
    await started.pairEmbedded(server);
    await started.start();
    domains = await composeDomains({
      daemon: started, daemonConfig, server, storeDir: options.storeDir, hostStorageRoot: options.hostStorageRoot,
      consumers: { bind: late.bind },
      changed: options.onChanged,
    });
    return { daemon: started, domains, close };
  } catch (error) {
    await close();
    if (error instanceof DaemonHaltError) throw new HostStoppedError(`Daemon halted at start: ${error.reason}`, { cause: error });
    if (error instanceof EmbeddedPairingError) throw new HostStoppedError(`Pairing with the embedded server refused: ${error.reason}`, { cause: error });
    throw error;
  }
}
