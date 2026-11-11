import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDaemonWithAdapters, DaemonHaltError, type Daemon, type DaemonConfig, type DeviceCredentialBackend,
  type RuntimeEnvironmentPolicy, type SdkHelperHostConfig,
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
  /** Re-entry of this Host's own executable for SDK helpers (`bundledSdkHelperHost()`). */
  readonly sdkHelperHost?: SdkHelperHostConfig;
  /** Enrollment custody; omitted, the daemon uses this product's OS credential store. */
  readonly deviceCredentials?: DeviceCredentialBackend;
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
 * the SDK sets that from `runtimes.pi.packageDir` alone.
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

/**
 * Starts the daemon. Whether this device is paired is the daemon's own
 * enrollment authority: `start()` halts with `unpaired` when it holds none, and
 * only then does the Host pair, in process and once, against its own server.
 */
async function startPaired(daemon: Daemon, pair: () => Promise<void>): Promise<void> {
  try {
    await daemon.start();
    return;
  } catch (error) {
    if (!(error instanceof DaemonHaltError) || error.reason !== 'unpaired') throw error;
  }
  await pair();
  await daemon.start();
}

/** Prechecks the stores, then composes the embedded server on loopback and the daemon paired to it (#1499 s1.4). */
export async function composeHost(options: HostCompositionOptions): Promise<ComposedHost> {
  const hostDir = path.join(options.hostStorageRoot, 'host');
  const serverDb = path.join(hostDir, 'server.sqlite');
  await precheckHostStores({ storeDir: options.storeDir, serverDb, keysDb: keysDbPath(options.hostStorageRoot) });
  await mkdir(hostDir, { recursive: true, mode: 0o700 });

  let consumers: ServerConsumers | undefined;
  const bound = () => {
    if (!consumers) throw new Error('The conversation is not open yet');
    return consumers;
  };
  const server = createByokServer({
    productId: options.productId, storage: { kind: 'sqlite', path: serverDb },
    wake: { consume: (wake, signal) => bound().consume(wake, signal) },
    agentMessage: { consume: input => bound().consumeMessage(input) },
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
    const launcher = options.sdkHelperHost ? { piByokLauncher: piByokLauncher(options.sdkHelperHost, options.hostStorageRoot) } : {};
    const adapters = createRuntimeAdapters({
      ...(options.sdkHelperHost ? { sdkHelperHost: options.sdkHelperHost } : {}),
      ...launcher,
      runtimes: { pi: { runtimeEnvironment: LOGIN_SHELL }, claude: { runtimeEnvironment: LOGIN_SHELL }, codex: { runtimeEnvironment: LOGIN_SHELL } },
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
      ...(options.sdkHelperHost ? { sdkHelperHost: options.sdkHelperHost } : {}),
      ...launcher,
    };
    daemon = createDaemonWithAdapters(daemonConfig, adapters, options.deviceCredentials ? { deviceCredentials: options.deviceCredentials } : {});
    const started = daemon;
    await startPaired(started, async () => {
      const { code } = await server.pairing.createPairingCode({ productId: options.productId });
      await started.pair(code);
    });
    domains = await composeDomains({
      daemon: started, daemonConfig, server, storeDir: options.storeDir, hostStorageRoot: options.hostStorageRoot,
      consumers: {
        bind: next => {
          if (consumers) throw new Error('Server consumers are already bound');
          consumers = next;
        },
      },
    });
    return { daemon: started, domains, close };
  } catch (error) {
    await close();
    if (error instanceof DaemonHaltError) throw new HostStoppedError(`Daemon halted at start: ${error.reason}`, { cause: error });
    throw error;
  }
}
