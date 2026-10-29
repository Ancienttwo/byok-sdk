import { readFileSync } from 'node:fs';
import type { DaemonConfig } from '../daemon/create-daemon';
import { DeviceStore } from '../daemon/store';
import { validateDaemonConfig, type DaemonConfigIssue } from '../daemon/config-schema/validate';
import { removedFieldError } from '../daemon/config-schema/errors';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from './official-release';

/**
 * Shared CLI plumbing: config-file loading and a tiny hand-rolled arg
 * parser. Deliberately no arg-parsing library — every subcommand in this
 * bin has at most one or two flags, so a generic parser would be more
 * machinery than the surface it serves. See `byok-agent.ts`'s header
 * comment for the overall command/read-model design this supports.
 */

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

type CliConfigInput = Omit<DaemonConfig, 'localAgentRelease'>;

/**
 * The parsed JSON of a config file, or `{}` without a path. Not validated:
 * {@link loadConfig} and `config check` validate it.
 */
export function readConfigFile(configPath: string | undefined): Record<string, unknown> {
  if (!configPath) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigError(`could not read config at "${configPath}"; check the path and read permissions`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // SyntaxError.message may quote the config contents; the path and fixed
    // failure category are sufficient for the operator to repair the file.
    throw new ConfigError(`config at "${configPath}" is not valid JSON`);
  }
}

/** One line per issue, with the migration note of a removed field. */
export function formatConfigIssue(issue: DaemonConfigIssue): string {
  return issue.migration === undefined ? issue.message : `${issue.message} (migration: ${issue.migration})`;
}

/**
 * Loads a `DaemonConfig` from a JSON file, if given, merged with explicit
 * overrides (e.g. `pair`'s `--server`). Every subcommand in this bin —
 * including the read-only ones (`status`/`runtimes`/`tasks`) — loads
 * config the same way: they all need `productId`/`storeDir`/`branding`/
 * `runtimeAllowlist` from the same one product install, so there is only
 * ever one config shape to reason about.
 *
 * Validated by the shared {@link validateDaemonConfig} as a `cli` config:
 * removed fields throw `DaemonConfigFieldRemovedError`; other errors throw
 * a {@link ConfigError}. Unknown fields pass (Q4'); the
 * daemon logs them, and `byok-agent config check --strict` fails on them.
 */
export function loadConfig(configPath: string | undefined, overrides: Partial<CliConfigInput> = {}): DaemonConfig {
  const { $schema: _schema, ...base } = readConfigFile(configPath);
  const merged: Record<string, unknown> = { ...base, ...overrides };
  const { issues } = validateDaemonConfig(merged, { source: 'cli' });
  const removed = issues.find((issue) => issue.code === 'removed_field');
  if (removed !== undefined) throw removedFieldError(removed.path);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) throw new ConfigError(errors.map(formatConfigIssue).join('; '));
  return { ...merged, localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE } as DaemonConfig;
}

/**
 * Same `storeDir` resolution `create-daemon.ts` uses internally
 * (`config.storeDir ?? DeviceStore.defaultDir(config.productId)`) — reused
 * here via `DeviceStore`'s own static helper (not reimplemented) so a query
 * subcommand always looks in the exact same place `createDaemon`/
 * `createDaemonWithAdapters` would persist to.
 */
export function resolveStoreDir(config: Pick<DaemonConfig, 'storeDir' | 'productId'>): string {
  return DeviceStore.resolveDir(config.productId, config.storeDir);
}

/** Value following `flag` in `args` (e.g. `--config <path>`), or `undefined`. */
export function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  const value = idx >= 0 ? args[idx + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : undefined;
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
