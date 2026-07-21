import { createDaemon, type Daemon, type DaemonConfig } from '../../index';

export interface PairDeps {
  log?: (line: string) => void;
  /** DI for tests: skip constructing a real `createDaemon(config)` and drive a stub/pre-built instance instead. */
  daemon?: Pick<Daemon, 'pair'>;
}

export async function runPairCommand(config: DaemonConfig, code: string, deps: PairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const daemon = deps.daemon ?? createDaemon(config);
  const result = await daemon.pair(code);
  log(`paired: deviceId=${result.deviceId}`);
}
