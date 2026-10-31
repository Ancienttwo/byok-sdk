import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuntimeVersionChange, RuntimeVersionChangeDirection, RuntimeObservation } from '../runtime-detection';
import { atomicWriteFile } from '../util/atomic-write';

/**
 * The restart-only runtime version baseline (#1103 §2.6).
 *
 * The daemon owns `<storeDir>/runtime-versions.json`: one normalized version
 * token and observation time per runtime present at the last start. It is a
 * diagnostic, not a security gate, so an unreadable or corrupt file is
 * ignored with one warning and startup continues. Versions never enter
 * `conn.hello`, presence, `audit.jsonl` or `DaemonRecord`; only the local
 * `status`/`doctor` surfaces and startup stderr see them.
 */

export const RUNTIME_VERSIONS_FILE = 'runtime-versions.json';
export const RUNTIME_VERSIONS_SCHEMA_VERSION = 1;

export interface RuntimeVersionRecord {
  readonly version: string;
  readonly observedAt: string;
}

export interface RuntimeVersionsState {
  readonly schemaVersion: typeof RUNTIME_VERSIONS_SCHEMA_VERSION;
  readonly runtimes: Readonly<Record<string, RuntimeVersionRecord>>;
}

const MAX_VERSION_CHARS = 256;
const NUMERIC_CORE = /^v?(\d+)\.(\d+)\.(\d+)/;

/** `<storeDir>/runtime-versions.json`, the one path authority. */
export function runtimeVersionsPath(storeDir: string): string {
  return path.join(storeDir, RUNTIME_VERSIONS_FILE);
}

function numericCore(version: string): readonly [number, number, number] | undefined {
  const match = NUMERIC_CORE.exec(version);
  if (match === null) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return core.every(Number.isSafeInteger) ? core : undefined;
}

function compareCore(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/**
 * The one direction rule (#1103 §2.6): a higher numeric core is an upgrade, a
 * lower one a downgrade, an equal core with a different token (build suffix,
 * prerelease label) `changed`, and any unparseable side `unknown`. Identical
 * tokens are not a change and return `undefined`.
 */
export function compareRuntimeVersionTokens(fromVersion: string, toVersion: string): RuntimeVersionChangeDirection | undefined {
  if (fromVersion === toVersion) return undefined;
  const from = numericCore(fromVersion);
  const to = numericCore(toVersion);
  if (from === undefined || to === undefined) return 'unknown';
  const order = compareCore(to, from);
  return order > 0 ? 'upgrade' : order < 0 ? 'downgrade' : 'changed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(text: string): RuntimeVersionsState | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(raw) || raw.schemaVersion !== RUNTIME_VERSIONS_SCHEMA_VERSION || !isRecord(raw.runtimes)) return undefined;
  const runtimes: Record<string, RuntimeVersionRecord> = {};
  for (const [id, entry] of Object.entries(raw.runtimes)) {
    if (id.length === 0 || id.length > 128 || /[\r\n\t]/.test(id)) return undefined;
    if (!isRecord(entry) || typeof entry.version !== 'string' || entry.version.length === 0 || entry.version.length > MAX_VERSION_CHARS
      || /[\r\n\t]/.test(entry.version) || typeof entry.observedAt !== 'string'
      || entry.observedAt.length === 0 || entry.observedAt.length > 64 || Number.isNaN(Date.parse(entry.observedAt))) return undefined;
    runtimes[id] = { version: entry.version, observedAt: entry.observedAt };
  }
  return { schemaVersion: RUNTIME_VERSIONS_SCHEMA_VERSION, runtimes };
}

/**
 * Read the baseline. A missing file is a first run (no warning); an
 * unreadable or corrupt file is ignored with one warning. Never throws.
 */
export async function readRuntimeVersions(
  storeDir: string,
  onWarning: (message: string) => void = (message) => console.warn(message),
): Promise<RuntimeVersionsState> {
  const file = runtimeVersionsPath(storeDir);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Closed category only: this warning reaches the durable daemon log, so
      // it never carries a path or a raw filesystem error.
      onWarning('[byok/client] runtime version history is unreadable; version-change notices are off for this run');
    }
    return { schemaVersion: RUNTIME_VERSIONS_SCHEMA_VERSION, runtimes: {} };
  }
  const state = parseState(text);
  if (state === undefined) {
    onWarning('[byok/client] runtime version history is corrupt; ignoring it and recording this run as the new baseline');
    return { schemaVersion: RUNTIME_VERSIONS_SCHEMA_VERSION, runtimes: {} };
  }
  return state;
}

export interface RecordRuntimeVersionChangesOptions {
  readonly storeDir: string;
  readonly observations: readonly RuntimeObservation[];
  /** Deterministic clock for tests; defaults to now. */
  readonly now?: Date;
  /** Diagnostic sink; defaults to the daemon's `console.warn` convention. */
  readonly onWarning?: (message: string) => void;
}

function isRecordedVersion(observation: RuntimeObservation): observation is RuntimeObservation & { readonly version: string } {
  return observation.present && observation.outcome === 'available'
    && typeof observation.version === 'string' && observation.version.length > 0
    && observation.version.length <= MAX_VERSION_CHARS && !/[\r\n\t]/.test(observation.version);
}

/**
 * Compare this run's observed tokens with the stored baseline, return the
 * changes by runtime id, and write the new baseline. Version text and the
 * whole file stay local: the caller projects only the change objects into
 * `status`/`doctor` and a stderr line. Never throws; a write failure is a
 * diagnostic warning, not a start failure.
 */
export async function recordRuntimeVersionChanges(
  options: RecordRuntimeVersionChangesOptions,
): Promise<ReadonlyMap<string, RuntimeVersionChange>> {
  const { storeDir, observations } = options;
  const now = options.now ?? new Date();
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const previous = await readRuntimeVersions(storeDir, warn);
  const observedAt = now.toISOString();
  const next: Record<string, RuntimeVersionRecord> = {};
  const changes = new Map<string, RuntimeVersionChange>();
  for (const observation of observations) {
    if (!isRecordedVersion(observation)) continue;
    next[observation.id] = { version: observation.version, observedAt };
    const before = previous.runtimes[observation.id];
    if (before === undefined) continue;
    const direction = compareRuntimeVersionTokens(before.version, observation.version);
    if (direction === undefined) continue;
    changes.set(observation.id, Object.freeze({
      fromVersion: before.version,
      toVersion: observation.version,
      direction,
      observedAt,
    }));
  }
  try {
    await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(runtimeVersionsPath(storeDir), `${JSON.stringify({ schemaVersion: RUNTIME_VERSIONS_SCHEMA_VERSION, runtimes: next })}\n`, {
      mode: 0o600,
      fsync: true,
    });
  } catch {
    // Same closed-category rule as the read path; a failed diagnostic write
    // must not leak a path into the daemon log.
    warn('[byok/client] failed to record the runtime version baseline; the next restart compares against the previous file');
  }
  return changes;
}
