import { readFileSync } from 'node:fs';
import { type DaemonConfig } from '../index';
import { DeviceStore } from '../daemon/store';

/**
 * Shared CLI plumbing: config-file loading and a tiny hand-rolled arg
 * parser. Deliberately no arg-parsing library — every subcommand in this
 * bin has at most one or two flags, so a generic parser would be more
 * machinery than the surface it serves. See `byok-agent.ts`'s header
 * comment for the overall command/read-model design this supports.
 */

const REQUIRED_FIELDS = ['productName', 'productId', 'serverUrl', 'workspaceRoot'] as const;

/**
 * Thrown by {@link loadConfig} on a missing/unreadable/invalid config.
 * Never calls `process.exit` itself (unlike the pre-M3-2b bin, which did) —
 * every caller, including tests, controls its own exit behavior; only
 * `byok-agent.ts`'s top-level `main().catch(...)` turns this into a clean
 * stderr message + `exit(1)`.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Loads a `DaemonConfig` from a JSON file, if given, merged with explicit
 * overrides (e.g. `pair`'s `--server`). Every subcommand in this bin —
 * including the read-only ones (`status`/`runtimes`/`tasks`) — loads
 * config the same way: they all need `productId`/`storeDir`/`branding`/
 * `runtimeAllowlist` from the same one product install, so there is only
 * ever one config shape to reason about.
 */
export function loadConfig(configPath: string | undefined, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  let base: Partial<DaemonConfig> = {};
  if (configPath) {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`could not read config at "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      base = JSON.parse(raw) as Partial<DaemonConfig>;
    } catch (err) {
      throw new ConfigError(`config at "${configPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const merged: Partial<DaemonConfig> = { ...base, ...overrides };
  for (const field of REQUIRED_FIELDS) {
    if (!merged[field]) {
      throw new ConfigError(`config is missing required field "${field}"`);
    }
  }
  return merged as DaemonConfig;
}

/**
 * Same `storeDir` resolution `create-daemon.ts` uses internally
 * (`config.storeDir ?? DeviceStore.defaultDir(config.productId)`) — reused
 * here via `DeviceStore`'s own static helper (not reimplemented) so a query
 * subcommand always looks in the exact same place `createDaemon`/
 * `createDaemonWithAdapters` would persist to.
 */
export function resolveStoreDir(config: Pick<DaemonConfig, 'storeDir' | 'productId'>): string {
  return config.storeDir ?? DeviceStore.defaultDir(config.productId);
}

/** Value following `flag` in `args` (e.g. `--config <path>`), or `undefined`. */
export function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/** Whether a bare boolean flag (e.g. `--follow`, `--yes`) is present anywhere in `args`. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Positional (non-flag) arguments, in order, with a fixed set of known
 * `--flag <value>` pairs removed (flag AND its value). Bare boolean flags
 * (e.g. `--follow`/`--yes`) are handled separately via {@link hasFlag} and
 * don't need to be named here unless they'd otherwise be mistaken for a
 * positional. Order-independent: `pair CODE --server URL` and
 * `pair --server URL CODE` both yield `["CODE"]`.
 */
export function positionalArgs(args: string[], valueFlags: string[] = []): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      i++; // also skip the value that belongs to this flag
      continue;
    }
    result.push(arg);
  }
  return result;
}
