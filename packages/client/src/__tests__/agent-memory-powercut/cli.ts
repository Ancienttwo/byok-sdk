import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { powercutBackend, runDevice } from './device';
import { HOST_KEEPS_ISSUED_WRITES_LAYER, ProcessKillDriver, QemuDriver, type PowerCutDriver, type StorageLayer } from './drivers';
import { runExperiment, type CutTrigger } from './experiment';
import { HostJournal, PowercutHost } from './host';

/**
 * #605 W5 power-cut harness. Bun runs it from source, as the W4 smoke does.
 *
 *   bun cli.ts device --store <dir> [--connect <host>:<port>]
 *       The device program. A guest VM starts it at boot with --connect.
 *   bun cli.ts process-kill --store <dir> [--rounds 24] [--seed 1] [--max-delay-ms 400] [--journal <file>] [--report <file>]
 *   bun cli.ts qemu --config <file.json>
 *       See QemuConfig below. The Host journal is fsynced per entry outside the guest.
 */
const HOST_POINTS: readonly CutTrigger[] = [
  { kind: 'host', on: 'fetch', intent: 1 },
  { kind: 'host', on: 'complete', intent: 1 },
  { kind: 'host', on: 'acked', intent: 1 },
  { kind: 'host', on: 'fetch', intent: 2 },
  { kind: 'host', on: 'complete', intent: 3 },
  { kind: 'host', on: 'acked', intent: 2 },
];

/** Host points first, then seeded random delays in [1, maxDelayMs]. */
export function powercutTriggers(rounds: number, seed: number, maxDelayMs: number): CutTrigger[] {
  const triggers = HOST_POINTS.slice(0, rounds);
  let state = seed >>> 0 || 1;
  while (triggers.length < rounds) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    triggers.push({ kind: 'delay', ms: 1 + (state % maxDelayMs) });
  }
  return triggers;
}

interface QemuConfig {
  readonly fault: 'os-crash' | 'power-loss';
  readonly command: string;
  readonly args: readonly string[];
  readonly qmpSocket: string;
  readonly listenPort: number;
  readonly rounds: number;
  readonly seed: number;
  readonly maxDelayMs: number;
  readonly journal: string;
  readonly report: string;
  readonly bootTimeoutMs?: number;
  /** The operator's storage layer: shell commands run at each power cut and before the next boot. */
  readonly storage?: {
    readonly id: string; readonly description: string; readonly dropsUnflushedWrites: boolean;
    readonly cutCommand: string; readonly prepareBootCommand: string;
  };
}

function storageLayer(config: QemuConfig['storage']): StorageLayer {
  if (config === undefined) return HOST_KEEPS_ISSUED_WRITES_LAYER;
  const run = promisify(exec);
  return {
    profile: { id: config.id, description: config.description, dropsUnflushedWrites: config.dropsUnflushedWrites },
    cut: async () => { await run(config.cutCommand); },
    prepareBoot: async () => { await run(config.prepareBootCommand); },
  };
}

async function connect(target: string): Promise<net.Socket> {
  const [host, port] = [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))];
  for (;;) {
    try {
      const socket = net.connect({ host, port });
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve).once('error', reject); });
      return socket;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function experiment(driver: PowerCutDriver, triggers: CutTrigger[], seed: number, journalFile: string | undefined, reportFile: string | undefined): Promise<number> {
  const journal = new HostJournal(journalFile);
  try {
    const report = await runExperiment({ driver, host: new PowercutHost({ seed, intentsPerHome: 3, journal }), triggers });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (reportFile === undefined) process.stdout.write(text);
    else writeFileSync(reportFile, text);
    console.error(`W5 ${report.fault} (${report.storageProfile.id}) evidence=${report.evidence} cuts=${report.cuts.length} violations=${report.violations} windows=${JSON.stringify(report.windows)}${report.stoppedEarly === undefined ? '' : ` stopped: ${report.stoppedEarly}`}`);
    return report.violations === 0 && report.stoppedEarly === undefined ? 0 : 1;
  } finally {
    journal.close();
    await driver.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      store: { type: 'string' }, connect: { type: 'string' }, rounds: { type: 'string' }, seed: { type: 'string' },
      'max-delay-ms': { type: 'string' }, journal: { type: 'string' }, report: { type: 'string' }, config: { type: 'string' },
    },
  });
  switch (command) {
    case 'device': {
      if (values.store === undefined) throw new Error('--store is required');
      const store = realpathSync(values.store);
      const socket = values.connect === undefined ? undefined : await connect(values.connect);
      await runDevice(store, socket === undefined ? { input: process.stdin, output: process.stdout } : { input: socket, output: socket }, powercutBackend());
      socket?.end();
      return 0;
    }
    case 'process-kill': {
      if (values.store === undefined) throw new Error('--store is required');
      mkdirSync(values.store, { recursive: true });
      const store = realpathSync(values.store);
      const seed = Number(values.seed ?? 1);
      const driver = new ProcessKillDriver({ command: process.execPath, args: [fileURLToPath(import.meta.url), 'device', '--store', store] });
      const triggers = powercutTriggers(Number(values.rounds ?? 24), seed, Number(values['max-delay-ms'] ?? 400));
      return experiment(driver, triggers, seed, values.journal, values.report);
    }
    case 'qemu': {
      if (values.config === undefined) throw new Error('--config is required');
      const config = JSON.parse(readFileSync(values.config, 'utf8')) as QemuConfig;
      const driver = new QemuDriver({
        fault: config.fault, command: config.command, args: config.args, qmpSocket: config.qmpSocket,
        listenPort: config.listenPort, storage: storageLayer(config.storage), ...(config.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: config.bootTimeoutMs }),
      });
      return experiment(driver, powercutTriggers(config.rounds, config.seed, config.maxDelayMs), config.seed, config.journal, config.report);
    }
    default:
      throw new Error('usage: cli.ts device|process-kill|qemu');
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
