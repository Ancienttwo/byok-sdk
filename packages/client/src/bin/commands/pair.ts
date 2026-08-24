import { createDaemon, type Daemon, type DaemonConfig } from '../../index';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';

export interface PairDeps {
  log?: (line: string) => void;
  /** DI for tests: skip constructing a real `createDaemon(config)` and drive a stub/pre-built instance instead. */
  daemon?: Pick<Daemon, 'pair'>;
  /** DI for tests: substitute the authenticated local control connection. */
  connectControl?: typeof connectControlClient;
}

export async function runPairCommand(config: DaemonConfig, code: string, deps: PairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (deps.daemon) {
    const result = await deps.daemon.pair(code);
    log(`paired: deviceId=${result.deviceId}`);
    return;
  }

  const connectControl = deps.connectControl ?? connectControlClient;
  const conn = await connectControl({ storeDir: resolveStoreDir(config), productId: config.productId });
  if (conn.ok) {
    try {
      const result = await conn.client.request<{ deviceId: string }>('enrollment.pair', { pairingCode: code });
      log(`paired: deviceId=${result.deviceId}`);
      return;
    } finally {
      conn.client.close();
    }
  }

  const daemon = createDaemon(config);
  const result = await daemon.pair(code);
  log(`paired: deviceId=${result.deviceId}`);
}
