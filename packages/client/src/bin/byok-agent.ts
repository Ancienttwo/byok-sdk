#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createDaemon, DeviceRevokedError, type DaemonConfig } from '../index';

const REQUIRED_FIELDS = ['productName', 'productId', 'serverUrl', 'workspaceRoot'] as const;

function usage(): never {
  console.error(
    [
      'Usage:',
      '  byok-agent pair <code> --server <url> [--config <path>]',
      '  byok-agent start --config <path>',
      '  byok-agent start   (reads config path from BYOK_CONFIG env var)',
    ].join('\n'),
  );
  process.exit(1);
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function loadConfig(configPath: string | undefined, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const base = configPath ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<DaemonConfig>) : {};
  const merged: Partial<DaemonConfig> = { ...base, ...overrides };
  for (const field of REQUIRED_FIELDS) {
    if (!merged[field]) {
      console.error(`config is missing required field "${field}"`);
      process.exit(1);
    }
  }
  return merged as DaemonConfig;
}

async function runPair(args: string[]): Promise<void> {
  const code = args[0];
  const server = argValue(args, '--server');
  if (!code || !server) usage();
  const config = loadConfig(argValue(args, '--config'), { serverUrl: server });
  const daemon = createDaemon(config);
  const result = await daemon.pair(code);
  console.log(`paired: deviceId=${result.deviceId}`);
}

async function runStart(args: string[]): Promise<void> {
  const configPath = argValue(args, '--config') ?? process.env.BYOK_CONFIG;
  if (!configPath) {
    console.error('start requires --config <path> or a BYOK_CONFIG env var');
    process.exit(1);
  }
  const config = loadConfig(configPath);
  const daemon = createDaemon(config);
  await daemon.start();
  console.log(`daemon started: product=${config.productName} server=${config.serverUrl}`);

  // M0 has no rich task/event UX yet (that's M3) — log daemon-level status
  // on an interval so `byok-agent start` gives *some* stdout visibility.
  const statusTimer = setInterval(() => {
    console.log(JSON.stringify({ status: daemon.status() }));
  }, 5000);
  statusTimer.unref();

  const shutdown = (): void => {
    clearInterval(statusTimer);
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'pair') return runPair(rest);
  if (command === 'start') return runStart(rest);
  usage();
}

main().catch((err: unknown) => {
  if (err instanceof DeviceRevokedError) {
    // A cold `daemon.start()` against an already-revoked device fails fast
    // with this typed error (see ConnectionManager.waitForAck) instead of
    // hanging for the ack timeout — give the operator a clear, actionable
    // message instead of a generic one.
    console.error('device revoked — re-pair needed (run: byok-agent pair <code> --server <url>)');
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
