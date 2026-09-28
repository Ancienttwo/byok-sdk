import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';
import { connectControlClient } from '../bin/control-client';
import { acquireDaemonOwner, DaemonOwnerActiveError } from './daemon-owner';
import { INPUT_PREPARATION_RECORD_VERSION } from './input-preparation-store';
import { DeviceStore } from './store';

/**
 * The bounded, operator-invoked retirement of an input-preparation namespace
 * written at an older record schema version (the v8 cut's operator
 * precondition, `docs/spec.md`; research contract C6).
 *
 * It is a MOVE, never a migration: the whole `<storeDir>/input-preparation/`
 * directory is renamed, byte-for-byte, into
 * `<storeDir>/input-preparation-retired/<stamp>-v<versions>/input-preparation/`
 * with a manifest beside it. Nothing is deleted, converted or rewritten, and
 * no old record is read forward: the log is read STRUCTURALLY — each line is
 * `JSON.parse`d and only its `recordId`, `version` and `pin` fields are looked
 * at, as untyped values. It never goes through `InputPreparationStore` or its
 * `replay()`, whose strict startup refusal of an old record stays exactly as
 * it is.
 *
 * Every path is derived from the resolved storeDir; Agent home and Agent
 * memory are never touched.
 *
 * {@link retireInputPreparation} is the one public entry point (preview and
 * execute); the `byok-agent retire-input-preparation` CLI is a thin renderer
 * over the same function, so a branded host CLI can own this step without
 * shipping the SDK CLI.
 */

export const INPUT_PREPARATION_RETIREMENT_COMMAND = 'retire-input-preparation';
export const INPUT_PREPARATION_RETIREMENT_MANIFEST_FORMAT = 'byok.input-preparation.retirement-manifest';
export const INPUT_PREPARATION_RETIREMENT_MANIFEST_VERSION = 1;

const NAMESPACE_DIR = 'input-preparation';
const RECORD_LOG = 'records.jsonl';
const ARTIFACT_DIR = 'artifacts';
const RETIRED_ROOT_DIR = 'input-preparation-retired';
const MANIFEST_FILENAME = 'manifest.json';

export interface RetirementFileDigest {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface InputPreparationNamespaceInspection {
  /** `absent`: no namespace directory. `empty`: no record line and no artifact file. */
  readonly status: 'absent' | 'empty' | 'present';
  readonly namespacePath: string;
  /** Non-empty lines in `records.jsonl`, parseable or not. */
  readonly lineCount: number;
  /** Lines that parsed to a JSON object. */
  readonly recordCount: number;
  /** Keyed by `JSON.stringify(version)`, or `missing` when the field is absent. */
  readonly versionCounts: Readonly<Record<string, number>>;
  /**
   * Records whose EFFECTIVE line carries a `pin` field — a live pin. The fold
   * mirrors `InputPreparationStore.replay()`: keyed by `recordId`, the last
   * line for a key wins. A line whose `recordId` is not a string folds with
   * nothing, so its pin always counts.
   */
  readonly pinnedRecordCount: number;
  /** 1-based line numbers of lines that are not a JSON object. Line content is never reported. */
  readonly unparseableLines: readonly number[];
  readonly artifactFileCount: number;
  /** Entries this namespace should not contain (relative to it); never followed or read. */
  readonly unexpectedEntries: readonly string[];
  readonly recordLog?: RetirementFileDigest;
  readonly artifacts: readonly RetirementFileDigest[];
}

export interface InputPreparationRetirementManifest {
  readonly format: typeof INPUT_PREPARATION_RETIREMENT_MANIFEST_FORMAT;
  readonly version: typeof INPUT_PREPARATION_RETIREMENT_MANIFEST_VERSION;
  readonly command: typeof INPUT_PREPARATION_RETIREMENT_COMMAND;
  readonly retiredAt: string;
  readonly currentRecordVersion: number;
  readonly retiredRecordVersions: readonly number[];
  readonly recordCountsByVersion: Readonly<Record<string, number>>;
  readonly recordCount: number;
  /** Relative to the manifest's own directory. */
  readonly retiredNamespace: typeof NAMESPACE_DIR;
  readonly recordLog: RetirementFileDigest;
  readonly artifacts: readonly RetirementFileDigest[];
}

export type InputPreparationRetirementResult =
  | { readonly status: 'nothing-to-retire'; readonly inspection: InputPreparationNamespaceInspection }
  | {
      readonly status: 'retired';
      readonly inspection: InputPreparationNamespaceInspection;
      readonly retiredDir: string;
      readonly manifestPath: string;
      readonly manifest: InputPreparationRetirementManifest;
    };

export class InputPreparationRetirementConfirmationRequiredError extends Error {
  constructor() {
    super(`${INPUT_PREPARATION_RETIREMENT_COMMAND} executes only with explicit confirmation (CLI: --yes)`);
    this.name = 'InputPreparationRetirementConfirmationRequiredError';
  }
}

export class InputPreparationRetirementDaemonRunningError extends Error {
  constructor() {
    super(`${INPUT_PREPARATION_RETIREMENT_COMMAND} refuses while the daemon control socket is reachable; stop the daemon first`);
    this.name = 'InputPreparationRetirementDaemonRunningError';
  }
}

/** Another process (a daemon, pair, doctor or retirement) holds the store's owner lease. Nothing was written. */
export class InputPreparationRetirementStoreBusyError extends Error {
  constructor(options: { cause: unknown }) {
    super(`${INPUT_PREPARATION_RETIREMENT_COMMAND} refuses while another process holds the store owner lease; nothing was written`, options);
    this.name = 'InputPreparationRetirementStoreBusyError';
  }
}

export type InputPreparationRetirementRefusalReason =
  | 'symlink'
  | 'not_a_directory'
  | 'not_a_regular_file'
  | 'unexpected_entry'
  | 'unparseable_line'
  | 'unsupported_version'
  | 'current_version_present'
  | 'pinned_record'
  | 'orphan_artifacts'
  | 'retired_target_exists';

/** The namespace is not in a state this command may retire. Nothing was written. */
export class InputPreparationRetirementRefusedError extends Error {
  constructor(readonly reason: InputPreparationRetirementRefusalReason, detail: string) {
    super(`${INPUT_PREPARATION_RETIREMENT_COMMAND} refused (${reason}): ${detail}; nothing was written`);
    this.name = 'InputPreparationRetirementRefusedError';
  }
}

/**
 * A step after the rename failed. Nothing is rolled back: the moved namespace
 * stays where it landed, and this names the exact on-disk state.
 */
export class InputPreparationRetirementIncompleteError extends Error {
  constructor(
    readonly step: 'sync_rename' | 'write_manifest',
    readonly retiredNamespacePath: string,
    readonly manifestPath: string,
    options: { cause: unknown },
  ) {
    super(
      `${INPUT_PREPARATION_RETIREMENT_COMMAND} failed at ${step} AFTER the namespace was moved: the original namespace`
      + ` now lives at ${retiredNamespacePath} (bytes unchanged, not deleted), and the manifest at ${manifestPath}`
      + ' may be missing or not durable; nothing was rolled back — record the manifest by hand before any further action',
      options,
    );
    this.name = 'InputPreparationRetirementIncompleteError';
  }
}

function describeVersion(value: unknown): string {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function isRetirableVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < INPUT_PREPARATION_RECORD_VERSION;
}

/** lstat that refuses a symbolic link and answers `undefined` for a missing path. */
async function lstatNoFollow(filePath: string, label: string): Promise<import('node:fs').BigIntStats | undefined> {
  let stat: import('node:fs').BigIntStats;
  try {
    stat = await fs.lstat(filePath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new InputPreparationRetirementRefusedError('symlink', `${label} is a symbolic link`);
  }
  return stat;
}

/**
 * Read one regular file without following a link and confirm the opened file
 * is the one that was named (the `openOperationalHealthFile` pattern).
 */
async function readRegularFile(filePath: string, label: string): Promise<Buffer> {
  const named = await lstatNoFollow(filePath, label);
  if (named === undefined || !named.isFile()) {
    throw new InputPreparationRetirementRefusedError('not_a_regular_file', `${label} is not a regular file`);
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
      throw new InputPreparationRetirementRefusedError('not_a_regular_file', `${label} changed while it was being opened`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function digest(name: string, bytes: Buffer): RetirementFileDigest {
  return { name, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
}

/**
 * Read-only structural inspection of `<storeDir>/input-preparation/`. Writes
 * nothing, and never parses a record past its `recordId`, `version` and `pin`
 * fields.
 */
export async function inspectInputPreparationNamespace(storeDir: string): Promise<InputPreparationNamespaceInspection> {
  const root = path.resolve(storeDir);
  const namespacePath = path.join(root, NAMESPACE_DIR);
  const namespaceStat = await lstatNoFollow(namespacePath, NAMESPACE_DIR);
  const inspection = {
    namespacePath,
    lineCount: 0,
    recordCount: 0,
    versionCounts: {} as Record<string, number>,
    pinnedRecordCount: 0,
    unparseableLines: [] as number[],
    artifactFileCount: 0,
    unexpectedEntries: [] as string[],
    artifacts: [] as RetirementFileDigest[],
  };
  if (namespaceStat === undefined) return { status: 'absent', ...inspection };
  if (!namespaceStat.isDirectory()) {
    throw new InputPreparationRetirementRefusedError('not_a_directory', `${NAMESPACE_DIR} is not a directory`);
  }

  let recordLog: RetirementFileDigest | undefined;
  for (const entry of (await fs.readdir(namespacePath)).sort()) {
    const entryPath = path.join(namespacePath, entry);
    if (entry === RECORD_LOG) {
      const bytes = await readRegularFile(entryPath, `${NAMESPACE_DIR}/${RECORD_LOG}`);
      recordLog = digest(RECORD_LOG, bytes);
      // Effective pin per record: the last line for a `recordId` wins, as in replay().
      const effectivePin = new Map<string, boolean>();
      let unkeyedPins = 0;
      const lines = bytes.toString('utf8').split('\n');
      lines.forEach((line, index) => {
        // Mirrors replay(): an empty line carries no record.
        if (line.length === 0) return;
        inspection.lineCount += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          inspection.unparseableLines.push(index + 1);
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          inspection.unparseableLines.push(index + 1);
          return;
        }
        const fields = parsed as Record<string, unknown>;
        inspection.recordCount += 1;
        const version = describeVersion(fields.version);
        inspection.versionCounts[version] = (inspection.versionCounts[version] ?? 0) + 1;
        const pinned = Object.hasOwn(fields, 'pin');
        if (typeof fields.recordId === 'string') effectivePin.set(fields.recordId, pinned);
        else if (pinned) unkeyedPins += 1;
      });
      inspection.pinnedRecordCount = unkeyedPins + [...effectivePin.values()].filter(Boolean).length;
      continue;
    }
    if (entry === ARTIFACT_DIR) {
      const artifactDirStat = await lstatNoFollow(entryPath, `${NAMESPACE_DIR}/${ARTIFACT_DIR}`);
      if (artifactDirStat === undefined || !artifactDirStat.isDirectory()) {
        throw new InputPreparationRetirementRefusedError('not_a_directory', `${NAMESPACE_DIR}/${ARTIFACT_DIR} is not a directory`);
      }
      for (const artifact of (await fs.readdir(entryPath)).sort()) {
        const artifactPath = path.join(entryPath, artifact);
        const artifactStat = await fs.lstat(artifactPath, { bigint: true });
        if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
          inspection.unexpectedEntries.push(`${ARTIFACT_DIR}/${artifact}`);
          continue;
        }
        inspection.artifacts.push(digest(artifact, await readRegularFile(artifactPath, `${NAMESPACE_DIR}/${ARTIFACT_DIR}/${artifact}`)));
      }
      inspection.artifactFileCount = inspection.artifacts.length;
      continue;
    }
    inspection.unexpectedEntries.push(entry);
  }

  const empty = inspection.lineCount === 0 && inspection.artifactFileCount === 0 && inspection.unexpectedEntries.length === 0;
  return { status: empty ? 'empty' : 'present', ...inspection, ...(recordLog ? { recordLog } : {}) };
}

/** Every refusal an `--yes` execution applies to an inspected, non-empty namespace. */
function assertRetirable(inspection: InputPreparationNamespaceInspection): {
  recordLog: RetirementFileDigest;
  versions: number[];
} {
  if (inspection.unexpectedEntries.length > 0) {
    throw new InputPreparationRetirementRefusedError(
      'unexpected_entry',
      `the namespace holds entries outside records.jsonl and artifacts/: ${inspection.unexpectedEntries.join(', ')}`,
    );
  }
  if (inspection.unparseableLines.length > 0) {
    throw new InputPreparationRetirementRefusedError(
      'unparseable_line',
      `records.jsonl line(s) ${inspection.unparseableLines.join(', ')} are not JSON records`,
    );
  }
  const versions: number[] = [];
  for (const key of Object.keys(inspection.versionCounts)) {
    const value: unknown = key === 'missing' ? undefined : JSON.parse(key);
    if (value === INPUT_PREPARATION_RECORD_VERSION) {
      throw new InputPreparationRetirementRefusedError(
        'current_version_present',
        `records.jsonl holds ${inspection.versionCounts[key]} record(s) at the current record schema version ${INPUT_PREPARATION_RECORD_VERSION}`,
      );
    }
    if (!isRetirableVersion(value)) {
      throw new InputPreparationRetirementRefusedError('unsupported_version', `records.jsonl holds record schema version ${key}`);
    }
    versions.push(value);
  }
  if (inspection.pinnedRecordCount > 0) {
    throw new InputPreparationRetirementRefusedError(
      'pinned_record',
      `${inspection.pinnedRecordCount} record(s) hold a live pin`,
    );
  }
  if (inspection.recordCount === 0 || inspection.recordLog === undefined) {
    throw new InputPreparationRetirementRefusedError(
      'orphan_artifacts',
      `${inspection.artifactFileCount} artifact file(s) have no record in records.jsonl`,
    );
  }
  return { recordLog: inspection.recordLog, versions: versions.sort((a, b) => a - b) };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export interface ExecuteInputPreparationRetirementOptions {
  /** Must be `true` — the CLI's `--yes`. */
  readonly confirmed: boolean;
  /** Whether the daemon control socket answered; checked before the owner lease is taken. */
  readonly controlOnline: boolean;
  readonly clock?: () => Date;
}

/**
 * Retire the namespace (package-internal core; hosts call
 * {@link retireInputPreparation}). Refuses (typed, zero writes) unless confirmed, the
 * control socket is offline, the `doctor` owner lease is acquired, and every
 * record line parses, sits at an integer record version below
 * {@link INPUT_PREPARATION_RECORD_VERSION} and carries no pin. An absent or
 * empty namespace is a no-op.
 */
export async function executeInputPreparationRetirement(
  storeDir: string,
  options: ExecuteInputPreparationRetirementOptions,
): Promise<InputPreparationRetirementResult> {
  if (options.confirmed !== true) throw new InputPreparationRetirementConfirmationRequiredError();
  if (options.controlOnline) throw new InputPreparationRetirementDaemonRunningError();
  const clock = options.clock ?? (() => new Date());
  const root = path.resolve(storeDir);
  let owner: Awaited<ReturnType<typeof acquireDaemonOwner>>;
  try {
    owner = await acquireDaemonOwner(root, 'doctor', clock);
  } catch (err) {
    if (err instanceof DaemonOwnerActiveError) throw new InputPreparationRetirementStoreBusyError({ cause: err });
    throw err;
  }
  try {
    const inspection = await inspectInputPreparationNamespace(root);
    if (inspection.status !== 'present') return { status: 'nothing-to-retire', inspection };
    const { recordLog, versions } = assertRetirable(inspection);

    const retiredRoot = path.join(root, RETIRED_ROOT_DIR);
    const retiredRootStat = await lstatNoFollow(retiredRoot, RETIRED_ROOT_DIR);
    if (retiredRootStat !== undefined && !retiredRootStat.isDirectory()) {
      throw new InputPreparationRetirementRefusedError('not_a_directory', `${RETIRED_ROOT_DIR} is not a directory`);
    }

    const retiredAt = clock().toISOString();
    const manifest: InputPreparationRetirementManifest = {
      format: INPUT_PREPARATION_RETIREMENT_MANIFEST_FORMAT,
      version: INPUT_PREPARATION_RETIREMENT_MANIFEST_VERSION,
      command: INPUT_PREPARATION_RETIREMENT_COMMAND,
      retiredAt,
      currentRecordVersion: INPUT_PREPARATION_RECORD_VERSION,
      retiredRecordVersions: versions,
      recordCountsByVersion: inspection.versionCounts,
      recordCount: inspection.recordCount,
      retiredNamespace: NAMESPACE_DIR,
      recordLog,
      artifacts: inspection.artifacts,
    };
    const retiredDir = path.join(retiredRoot, `${retiredAt.replace(/[:.]/g, '-')}-v${versions.join('_')}`);
    const retiredNamespacePath = path.join(retiredDir, NAMESPACE_DIR);
    const manifestPath = path.join(retiredDir, MANIFEST_FILENAME);

    if (retiredRootStat === undefined) await fs.mkdir(retiredRoot, { mode: 0o700 });
    await ensureSecureDir(retiredRoot);
    const securedRetiredRoot = await fs.lstat(retiredRoot, { bigint: true });
    if (!securedRetiredRoot.isDirectory() || securedRetiredRoot.isSymbolicLink()) {
      throw new InputPreparationRetirementRefusedError('symlink', `${RETIRED_ROOT_DIR} changed during validation`);
    }
    try {
      // Exclusive: a fresh directory is the only rename target, so the move
      // can never land onto (or merge with) an earlier retirement.
      await fs.mkdir(retiredDir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new InputPreparationRetirementRefusedError('retired_target_exists', `${retiredDir} already exists`);
      }
      throw err;
    }

    // The one mutation of the original namespace: an atomic same-filesystem move.
    try {
      await fs.rename(path.join(root, NAMESPACE_DIR), retiredNamespacePath);
    } catch (err) {
      // The namespace did not move. `rmdir` removes only the still-empty
      // directory created just above; it can never remove content.
      await fs.rmdir(retiredDir).catch(() => undefined);
      throw err;
    }

    let step: 'sync_rename' | 'write_manifest' = 'sync_rename';
    try {
      await syncDirectory(root);
      await syncDirectory(retiredDir);
      step = 'write_manifest';
      await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, fsync: true });
      await syncDirectory(retiredRoot);
    } catch (cause) {
      throw new InputPreparationRetirementIncompleteError(step, retiredNamespacePath, manifestPath, { cause });
    }
    return { status: 'retired', inspection, retiredDir, manifestPath, manifest };
  } finally {
    await owner.release();
  }
}

/** The store {@link retireInputPreparation} acts on: the daemon's `productId` and `storeDir`. */
export interface RetireInputPreparationTarget {
  readonly productId: string;
  /** Same value as `DaemonConfig.storeDir`; omitted resolves the product default. */
  readonly storeDir?: string;
}

/**
 * `preview`: read-only structural inspection, no socket probe, no lease, no
 * write. `execute`: requires `confirmed: true` (the CLI's `--yes`).
 */
export type RetireInputPreparationInput =
  | { readonly mode: 'preview' }
  | { readonly mode: 'execute'; readonly confirmed: true };

export type RetireInputPreparationResult =
  | { readonly status: 'inspected'; readonly inspection: InputPreparationNamespaceInspection }
  | InputPreparationRetirementResult;

/**
 * Package-internal test seams (the CLI tests substitute the control probe and
 * clock). The probe is structural so this module's declarations do not pull
 * the CLI control client into the public type surface.
 */
export interface RetireInputPreparationSeams {
  readonly clock?: () => Date;
  readonly connectControl?: (options: { storeDir: string; productId: string }) => Promise<
    { ok: true; client: { close(): void } } | { ok: false; reason: string }
  >;
}

/** Package-internal: {@link retireInputPreparation} with its test seams. */
export async function runInputPreparationRetirement(
  target: RetireInputPreparationTarget,
  input: RetireInputPreparationInput,
  seams: RetireInputPreparationSeams = {},
): Promise<RetireInputPreparationResult> {
  if (typeof target?.productId !== 'string' || target.productId.length === 0 ||
      (target.storeDir !== undefined && typeof target.storeDir !== 'string')) {
    throw new TypeError(`${INPUT_PREPARATION_RETIREMENT_COMMAND} requires the daemon productId and an optional storeDir string`);
  }
  const storeDir = DeviceStore.resolveDir(target.productId, target.storeDir);
  const mode = input?.mode;
  if (mode === 'preview') {
    return { status: 'inspected', inspection: await inspectInputPreparationNamespace(storeDir) };
  }
  if (mode !== 'execute') throw new TypeError(`${INPUT_PREPARATION_RETIREMENT_COMMAND} mode must be 'preview' or 'execute'`);
  if (input.confirmed !== true) throw new InputPreparationRetirementConfirmationRequiredError();

  const connectControl = seams.connectControl ?? connectControlClient;
  const connection = await connectControl({ storeDir, productId: target.productId });
  // A completed authenticated handshake is itself proof a daemon owns this
  // store; the retirement refuses on it without asking anything further.
  if (connection.ok) connection.client.close();
  return executeInputPreparationRetirement(storeDir, {
    confirmed: true,
    controlOnline: connection.ok,
    ...(seams.clock === undefined ? {} : { clock: seams.clock }),
  });
}

/**
 * Programmatic form of `byok-agent retire-input-preparation` for the v8
 * input-preparation record cut (`docs/spec.md`).
 *
 * `preview` inspects `<storeDir>/input-preparation/` and writes nothing.
 * `execute` refuses, typed and with zero writes, while the daemon control
 * socket answers ({@link InputPreparationRetirementDaemonRunningError}), while
 * another process holds the store owner lease
 * ({@link InputPreparationRetirementStoreBusyError}), and for a live pin, a
 * current-version, mixed, unknown or missing record version, an unparseable
 * line, orphan artifacts, an unexpected entry or any symbolic link
 * ({@link InputPreparationRetirementRefusedError} with its `reason`). Otherwise
 * it moves the whole namespace byte-for-byte under
 * `<storeDir>/input-preparation-retired/` beside a manifest of per-file
 * digests; nothing is ever deleted or converted. An absent or empty namespace
 * is `nothing-to-retire`. A failure after the move is
 * {@link InputPreparationRetirementIncompleteError}, naming where the bytes are.
 * Run it before the daemon starts (for example from the host installer).
 */
export function retireInputPreparation(
  target: RetireInputPreparationTarget,
  input: RetireInputPreparationInput,
): Promise<RetireInputPreparationResult> {
  return runInputPreparationRetirement(target, input);
}
