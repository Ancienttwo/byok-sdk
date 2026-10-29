import { encodePairingVerificationSecret, parsePairingInput } from '@byok-sdk/core/sealed-payload';
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

/**
 * The CLI pair input. With `e2ee`, it is `<pairing code>.<verification
 * secret>` and splits on the last `.`; without it, the whole input is the
 * code. The flag, never the text, decides: a Host's own code may hold a `.`.
 */
export function readPairInput(input: string, e2ee: boolean): { readonly code: string; readonly verificationSecret?: string } {
  if (!e2ee) return { code: input };
  const { pairingCode, pv } = parsePairingInput(input);
  const verificationSecret = encodePairingVerificationSecret(pv);
  pv.fill(0);
  return { code: pairingCode, verificationSecret };
}

/**
 * `verificationSecret` is the base32 `pv` of an E2EE pairing (#654 §7.2): the
 * device keeps it and sends only the code to the Host.
 */
/**
 * `replaceOtherStore` is `--replace-other-store`: replace an enrollment that
 * another storeDir of this productId paired. A daemon reachable over control
 * is waiting for its first enrollment, so it holds none to replace.
 */
export async function runPairCommand(
  config: DaemonConfig,
  code: string,
  deps: PairDeps = {},
  verificationSecret?: string,
  replaceOtherStore = false,
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const options = verificationSecret === undefined ? undefined : { verificationSecret };
  const pairOptions = { ...options, ...(replaceOtherStore ? { replaceOtherStore } : {}) };
  const pair = (daemon: Pick<Daemon, 'pair'>) => (Object.keys(pairOptions).length === 0 ? daemon.pair(code) : daemon.pair(code, pairOptions));
  if (deps.daemon) {
    const result = await pair(deps.daemon);
    log(`paired: deviceId=${result.deviceId}`);
    return;
  }

  const connectControl = deps.connectControl ?? connectControlClient;
  const conn = await connectControl({ storeDir: resolveStoreDir(config), productId: config.productId });
  if (conn.ok) {
    try {
      const result = await conn.client.request<{ deviceId: string }>('enrollment.pair', { pairingCode: code, ...options });
      log(`paired: deviceId=${result.deviceId}`);
      return;
    } finally {
      conn.client.close();
    }
  }

  const result = await pair(createDaemon(config));
  log(`paired: deviceId=${result.deviceId}`);
}
