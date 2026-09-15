import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpLaunchAttestation } from './trusted-launch-cwd';

/**
 * The ONE authority for "which implementation backs this tool", and the only
 * file in this package that may produce an `attested` identity
 * (`docs/researches/runtime-input-preparation-contract.md` §17/§19/§22/§26).
 *
 * The split this module encodes:
 *
 * - The HOST owns the install record. It knows where it put a versioned
 *   immutable release, what manifest revision it came from, and which
 *   interpreter (if any) is encapsulated with it. That knowledge arrives
 *   through {@link ToolImplementationAuthority}, which this SDK declares and
 *   never implements: there is NO default resolver. An unconfigured daemon
 *   resolves every identity to `unavailable: 'resolver_unconfigured'`.
 * - The SDK owns the ASSERTION. A record the resolver hands over is not
 *   believed; it is measured — realpath, lstat, ownership, mode, content
 *   digest — here, before it becomes an identity, and measured again before
 *   every spawn. An absolute path is not an attestation, and a resolver that
 *   reports one is answered with a refusal rather than a promotion.
 *
 * What an `attested` identity proves is therefore exactly this: at the moment
 * it was resolved, and again at the moment the server was spawned, the file at
 * that versioned realpath was a root-owned, non-symlink, non-writable regular
 * file whose bytes hash to `closureDigest` and whose `(dev, ino, size, mtime,
 * mode, uid, gid)` tuple is the one that was measured at resolve.
 *
 * What it does NOT prove (§26, carried honestly rather than implied away):
 * post-hoc modification by root, the integrity of the kernel, dyld, SIP-owned
 * system libraries or anything the loader maps in beside the artifact,
 * injection into the live process after exec, and anything about the network
 * peers the server talks to. Release signing is a separate authority and is
 * not claimed here.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Every way an implementation identity can be absent. Absence is always
 * REPORTED, never defaulted away: each reason names who could not answer and
 * why, so a receipt that carries one says something an operator can act on.
 *
 * - `resolver_unconfigured` — no {@link ToolImplementationAuthority} is wired
 *   into this daemon. The SDK ships none, so this is the unconfigured state.
 * - `implementation_identity_unattested` — a resolver answered, but not with a
 *   record this SDK can measure (it threw, or returned a shape that is not an
 *   install record).
 * - `unencapsulated_source` — the resolver's own verdict: what backs this tool
 *   is a source tree or a directory the host cannot freeze, not an artifact.
 * - `interpreter_not_encapsulated` — the resolver's own verdict: the bundle
 *   runs under an interpreter that is not part of the frozen install.
 * - `interpreter_form_unsupported` — the record pairs `form` and `interpreter`
 *   in a way no attestation covers (an interpreter on a compiled executable, or
 *   a bundle with no interpreter).
 * - `install_record_mismatch` — the record does not describe the filesystem:
 *   wrong realpath, a symlink, not a regular file, not root-owned, writable, or
 *   a stat tuple that moved.
 * - `reverify_failed` — the artifact's own bytes no longer hash to the digest
 *   that was attested, or could not be read at all.
 */
export type ToolImplementationUnavailableReasonV1 =
  | 'implementation_identity_unattested'
  | 'resolver_unconfigured'
  | 'unencapsulated_source'
  | 'interpreter_not_encapsulated'
  | 'interpreter_form_unsupported'
  | 'install_record_mismatch'
  | 'reverify_failed';

export const TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS: readonly ToolImplementationUnavailableReasonV1[] =
  Object.freeze([
    'implementation_identity_unattested',
    'resolver_unconfigured',
    'unencapsulated_source',
    'interpreter_not_encapsulated',
    'interpreter_form_unsupported',
    'install_record_mismatch',
    'reverify_failed',
  ]);

export interface ToolImplementationUnavailableV1 {
  readonly kind: 'unavailable';
  readonly reason: ToolImplementationUnavailableReasonV1;
}

/**
 * The interpreter half of an `interpreter+bundle` install, present if and only
 * if the form says so. `loadCommandsDigest` is the host's digest of the
 * interpreter's own load/link directives — the thing that decides what else
 * gets mapped in beside the bundle — and is carried because the interpreter's
 * file digest alone does not describe that.
 */
export interface ToolImplementationInterpreterV1 {
  readonly path: string;
  readonly digest: string;
  readonly loadCommandsDigest: string;
}

/**
 * The filesystem tuple measured at resolve and required to be unchanged at
 * every later spawn.
 *
 * SDK-measured, never resolver-supplied: it is the one field of an attested
 * identity whose value a host cannot choose. A record whose digest still
 * matches but whose inode moved is a replaced file, and a replaced file is not
 * the file that was attested even when its bytes agree today.
 */
export interface ToolImplementationStatTupleV1 {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/**
 * Nominal brand. Declared, never present at runtime, and never assignable from
 * outside this module — so `attested` is unconstructible from any parsed
 * value, and the only paths that produce one are
 * {@link resolveToolImplementationIdentity} (which measures the filesystem
 * first) and {@link parseToolImplementationIdentity} (which the daemon's own
 * task-scoped configuration reader calls, and which is deliberately NOT part of
 * this package's public surface).
 *
 * The control surface needs no such defence in depth and does not rely on it:
 * `daemon/control-protocol.ts` has no field anywhere in which a caller could
 * put an identity at all.
 */
declare const TOOL_IMPLEMENTATION_ATTESTED: unique symbol;

export interface ToolImplementationAttestedV1 {
  readonly kind: 'attested';
  /** The only authority this SDK recognises. A resolver cannot name another. */
  readonly authority: 'host-install-record';
  readonly manifestRevision: string;
  readonly form: 'compiled-executable' | 'interpreter+bundle';
  /** The versioned immutable realpath. Equal to its own `realpath`, or it is not one. */
  readonly installPath: string;
  /** sha256 hex of the executable or bundle artifact's bytes. */
  readonly closureDigest: string;
  readonly closureKind: 'artifact';
  /** Required iff `form === 'interpreter+bundle'`, forbidden otherwise. */
  readonly interpreter?: ToolImplementationInterpreterV1;
  readonly entry?: string;
  readonly launchArgv: readonly string[];
  readonly launchCwd: string;
  /** Digest of the NAMES the child's environment carries. Never their values. */
  readonly launchEnvNamesDigest: string;
  /**
   * §27.2: digest of the sanitized loader-affecting env VALUES as they would
   * reach the child — the values of the names `daemon/environment.ts` already
   * denies, which is expected to be the empty canonical map. Never the full
   * task environment: the probe carries no execution nonce, and binding a task
   * or server nonce into an identity would make every task's identity
   * different for reasons that have nothing to do with the implementation.
   */
  readonly loaderEnvValuesDigest: string;
  /** SDK-measured at resolve. See {@link ToolImplementationStatTupleV1}. */
  readonly installStat: ToolImplementationStatTupleV1;
  readonly [TOOL_IMPLEMENTATION_ATTESTED]: true;
}

export type ToolImplementationIdentityV1 = ToolImplementationUnavailableV1 | ToolImplementationAttestedV1;

export function toolImplementationUnavailable(
  reason: ToolImplementationUnavailableReasonV1,
): ToolImplementationUnavailableV1 {
  return Object.freeze({ kind: 'unavailable' as const, reason });
}

/** The unconfigured state, which is this SDK's default for every tool. */
export const TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED: ToolImplementationUnavailableV1 =
  toolImplementationUnavailable('resolver_unconfigured');

// ---------------------------------------------------------------------------
// The host authority this SDK declares and never implements
// ---------------------------------------------------------------------------

/** What the resolver is asked about: one configured server, and where it launches. */
export interface ToolImplementationLocatorV1 {
  readonly toolsetId: string;
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly launch: McpLaunchAttestation;
}

/**
 * The install record a resolver returns, which is an attested identity MINUS
 * the two things a host does not get to assert: the brand, and the stat tuple
 * this SDK measures itself.
 */
export type ToolImplementationInstallRecordV1 = Omit<
  ToolImplementationAttestedV1,
  typeof TOOL_IMPLEMENTATION_ATTESTED | 'installStat'
>;

export type ToolImplementationResolutionV1 =
  | ToolImplementationUnavailableV1
  | ToolImplementationInstallRecordV1;

/**
 * The host's install-record authority.
 *
 * This package declares it and ships NO implementation and NO default. A
 * daemon constructed without one resolves every identity to
 * `unavailable: 'resolver_unconfigured'` and every receipt built on those
 * identities carries `executor_identity_unproven`.
 *
 * There is deliberately no `reverify` method here. Reverification is the SDK's
 * assertion, not the resolver's report — see
 * {@link reverifyToolImplementationIdentity}. A resolver that could answer
 * "still fine" would be the authority on its own record, which is the exact
 * thing this boundary exists to prevent.
 */
export interface ToolImplementationAuthority {
  resolve(input: ToolImplementationLocatorV1): Promise<ToolImplementationResolutionV1>;
}

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

export interface ToolImplementationStatEntry extends ToolImplementationStatTupleV1 {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The `node:fs` reads this module makes, as one injectable triple — the same
 * seam, for the same reason, as `LaunchCwdShellStat` in
 * `./trusted-launch-cwd.ts`: the checks below require a ROOT-OWNED file, and a
 * non-root test process cannot create one. Tests wrap the real implementation
 * and override ownership alone, so the digest, the size and the mtime under
 * test are still read off a real file on disk.
 *
 * Production never passes one.
 */
export interface ToolImplementationFsProbe {
  lstat(target: string): Promise<ToolImplementationStatEntry>;
  realpath(target: string): Promise<string>;
  /** sha256 hex of the file's bytes, streamed. */
  digest(target: string): Promise<string>;
}

async function streamDigest(target: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(target);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export const realToolImplementationFsProbe: ToolImplementationFsProbe = Object.freeze({
  async lstat(target: string): Promise<ToolImplementationStatEntry> {
    const stats = await fs.lstat(target);
    return Object.freeze({
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
    });
  },
  realpath: (target: string) => fs.realpath(target),
  digest: streamDigest,
});

// ---------------------------------------------------------------------------
// Strict record validation
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) return false;
  }
  return true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const INTERPRETER_KEYS = ['path', 'digest', 'loadCommandsDigest'] as const;

function validateInterpreter(value: unknown): ToolImplementationInterpreterV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, INTERPRETER_KEYS)) return undefined;
  if (!nonEmptyString(value.path) || !path.isAbsolute(value.path)) return undefined;
  if (typeof value.digest !== 'string' || !SHA256_HEX.test(value.digest)) return undefined;
  if (typeof value.loadCommandsDigest !== 'string' || !SHA256_HEX.test(value.loadCommandsDigest)) return undefined;
  return Object.freeze({
    path: value.path,
    digest: value.digest,
    loadCommandsDigest: value.loadCommandsDigest,
  });
}

const UNAVAILABLE_KEYS = ['kind', 'reason'] as const;

const INSTALL_RECORD_KEYS = [
  'kind',
  'authority',
  'manifestRevision',
  'form',
  'installPath',
  'closureDigest',
  'closureKind',
  'interpreter',
  'entry',
  'launchArgv',
  'launchCwd',
  'launchEnvNamesDigest',
  'loaderEnvValuesDigest',
] as const;

/**
 * Why one candidate record is not an install record. Returned rather than
 * thrown so the caller can map it onto the unavailable reason that describes
 * the failure honestly instead of collapsing every malformation into one code.
 */
type RecordRejection = 'not_a_record' | 'interpreter_form_unsupported';

/**
 * Validate one resolver answer, strictly. Unknown keys reject; every string is
 * checked for the shape it claims; absolute paths must be absolute and digests
 * must be sha256 hex.
 *
 * This produces an install RECORD, not an identity: nothing has been measured
 * yet, so nothing is attested yet.
 */
function validateInstallRecord(
  value: unknown,
): ToolImplementationInstallRecordV1 | RecordRejection {
  if (!plainRecord(value) || !exactKeys(value, INSTALL_RECORD_KEYS)) return 'not_a_record';
  if (value.kind !== 'attested') return 'not_a_record';
  if (value.authority !== 'host-install-record') return 'not_a_record';
  if (value.closureKind !== 'artifact') return 'not_a_record';
  if (!nonEmptyString(value.manifestRevision)) return 'not_a_record';
  if (value.form !== 'compiled-executable' && value.form !== 'interpreter+bundle') return 'not_a_record';
  if (!nonEmptyString(value.installPath) || !path.isAbsolute(value.installPath)) return 'not_a_record';
  if (typeof value.closureDigest !== 'string' || !SHA256_HEX.test(value.closureDigest)) return 'not_a_record';
  if (typeof value.launchEnvNamesDigest !== 'string' || !SHA256_HEX.test(value.launchEnvNamesDigest)) {
    return 'not_a_record';
  }
  if (typeof value.loaderEnvValuesDigest !== 'string' || !SHA256_HEX.test(value.loaderEnvValuesDigest)) {
    return 'not_a_record';
  }
  if (!nonEmptyString(value.launchCwd) || !path.isAbsolute(value.launchCwd)) return 'not_a_record';
  if (!Array.isArray(value.launchArgv) || value.launchArgv.some((arg) => typeof arg !== 'string')) {
    return 'not_a_record';
  }
  if (value.entry !== undefined && !nonEmptyString(value.entry)) return 'not_a_record';
  // The form decides whether an interpreter is part of the frozen install.
  // Neither direction is repaired: a compiled executable that names one, and a
  // bundle that names none, each describe an install nothing here can attest.
  let interpreter: ToolImplementationInterpreterV1 | undefined;
  if (value.form === 'interpreter+bundle') {
    if (value.interpreter === undefined) return 'interpreter_form_unsupported';
    interpreter = validateInterpreter(value.interpreter);
    if (interpreter === undefined) return 'interpreter_form_unsupported';
  } else if (value.interpreter !== undefined) {
    return 'interpreter_form_unsupported';
  }
  return Object.freeze({
    kind: 'attested' as const,
    authority: 'host-install-record' as const,
    manifestRevision: value.manifestRevision,
    form: value.form,
    installPath: value.installPath,
    closureDigest: value.closureDigest,
    closureKind: 'artifact' as const,
    ...(interpreter === undefined ? {} : { interpreter }),
    ...(value.entry === undefined ? {} : { entry: value.entry as string }),
    launchArgv: Object.freeze([...(value.launchArgv as string[])]),
    launchCwd: value.launchCwd,
    launchEnvNamesDigest: value.launchEnvNamesDigest,
    loaderEnvValuesDigest: value.loaderEnvValuesDigest,
  });
}

function validateStatTuple(value: unknown): ToolImplementationStatTupleV1 | undefined {
  const keys = ['dev', 'ino', 'size', 'mtimeMs', 'mode', 'uid', 'gid'] as const;
  if (!plainRecord(value) || !exactKeys(value, keys)) return undefined;
  for (const key of keys) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key] as number)) return undefined;
  }
  return Object.freeze({
    dev: value.dev as number,
    ino: value.ino as number,
    size: value.size as number,
    mtimeMs: value.mtimeMs as number,
    mode: value.mode as number,
    uid: value.uid as number,
    gid: value.gid as number,
  });
}

/**
 * Read one identity back out of a daemon-authored task-scoped file.
 *
 * Deliberately NOT exported from this package's index: it is the one function
 * that turns a parsed value into an `attested` identity, and the only caller is
 * `adapters/pi/mcp-extension.ts`, reading the file the pi adapter wrote for
 * exactly one task. Nothing a control client sends reaches it — the control
 * surface carries no identity field at all — and the value it produces is
 * re-measured against the filesystem before any server is spawned, so a forged
 * file buys an immediate refusal rather than a trusted identity.
 */
export function parseToolImplementationIdentity(value: unknown): ToolImplementationIdentityV1 | undefined {
  if (!plainRecord(value)) return undefined;
  if (value.kind === 'unavailable') {
    if (!exactKeys(value, UNAVAILABLE_KEYS)) return undefined;
    if (typeof value.reason !== 'string') return undefined;
    if (!TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS.includes(value.reason as ToolImplementationUnavailableReasonV1)) {
      return undefined;
    }
    return toolImplementationUnavailable(value.reason as ToolImplementationUnavailableReasonV1);
  }
  if (!exactKeys(value, [...INSTALL_RECORD_KEYS, 'installStat'])) return undefined;
  const { installStat: rawStat, ...rest } = value;
  const record = validateInstallRecord(rest);
  if (typeof record === 'string') return undefined;
  const installStat = validateStatTuple(rawStat);
  if (installStat === undefined) return undefined;
  return brand(record, installStat);
}

/**
 * The single cast in this module, and the only place an `attested` value comes
 * into existence. Both callers have already validated the record; the brand is
 * type-level and never present at runtime, so it never reaches a digest, a
 * JSON file or the wire.
 */
function brand(
  record: ToolImplementationInstallRecordV1,
  installStat: ToolImplementationStatTupleV1,
): ToolImplementationAttestedV1 {
  return Object.freeze({ ...record, installStat }) as ToolImplementationAttestedV1;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Why one measured path is not the artifact the record describes. Split by
 * WHICH fact failed, because the two mean different things operationally:
 * `install_record_mismatch` is "this is not the file that was attested" (wrong
 * path, replaced inode, wrong owner, writable, a symlink), and
 * `reverify_failed` is "this IS the file, and its bytes are no longer the bytes
 * that were attested" (or could not be read at all).
 */
export type ToolImplementationMeasurementFailure = 'install_record_mismatch' | 'reverify_failed';

/**
 * The four facts every attested path has to satisfy, in the order that makes
 * each one meaningful:
 *
 * 1. It is its own realpath. A path that resolves elsewhere is a path whoever
 *    owns the intervening link chooses.
 * 2. `lstat`, not `stat`: a symlink is rejected rather than followed, and the
 *    entry is a regular file.
 * 3. It is root-owned. A file owned by the uid the daemon and the agent share
 *    is a file the agent can `chmod` and rewrite, so a cleared write bit on its
 *    own proves nothing.
 * 4. No write bit is set for anyone. Owner included: the owner is root, and a
 *    root-writable install is one a compromised root service rewrites without
 *    a `chmod` first.
 */
async function measurePath(
  target: string,
  probe: ToolImplementationFsProbe,
): Promise<ToolImplementationStatEntry | ToolImplementationMeasurementFailure> {
  let resolved: string;
  try {
    resolved = await probe.realpath(target);
  } catch {
    return 'install_record_mismatch';
  }
  if (resolved !== target) return 'install_record_mismatch';
  let stats: ToolImplementationStatEntry;
  try {
    stats = await probe.lstat(target);
  } catch {
    return 'install_record_mismatch';
  }
  if (stats.isSymbolicLink) return 'install_record_mismatch';
  if (!stats.isFile) return 'install_record_mismatch';
  if (stats.uid !== 0) return 'install_record_mismatch';
  if ((stats.mode & 0o222) !== 0) return 'install_record_mismatch';
  return stats;
}

async function digestMatches(
  target: string,
  expected: string,
  probe: ToolImplementationFsProbe,
): Promise<boolean | 'unreadable'> {
  try {
    return (await probe.digest(target)) === expected;
  } catch {
    return 'unreadable';
  }
}

function sameStatTuple(left: ToolImplementationStatTupleV1, right: ToolImplementationStatTupleV1): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Turn one locator into the identity this daemon will carry for it.
 *
 * Every failure path lands on a REASON rather than a throw: a tool whose
 * implementation cannot be proven is not an error, it is a tool whose identity
 * is `unavailable`, and the receipt says so. The one thing that never happens
 * is an identity being promoted past a check — the measurement below runs on
 * every record the resolver returns, including the ones it is most confident
 * about.
 */
export async function resolveToolImplementationIdentity(
  authority: ToolImplementationAuthority | undefined,
  locator: ToolImplementationLocatorV1,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<ToolImplementationIdentityV1> {
  if (authority === undefined) return TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED;
  let answer: unknown;
  try {
    answer = await authority.resolve(locator);
  } catch {
    // A resolver that throws has not attested anything. It is not this
    // module's job to decide whether the throw was transient: an identity that
    // is not proven is unavailable, and the caller refuses or carries the
    // reason.
    return toolImplementationUnavailable('implementation_identity_unattested');
  }
  if (plainRecord(answer) && answer.kind === 'unavailable') {
    if (!exactKeys(answer, UNAVAILABLE_KEYS)) return toolImplementationUnavailable('implementation_identity_unattested');
    if (!TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS.includes(answer.reason as ToolImplementationUnavailableReasonV1)) {
      return toolImplementationUnavailable('implementation_identity_unattested');
    }
    return toolImplementationUnavailable(answer.reason as ToolImplementationUnavailableReasonV1);
  }
  const record = validateInstallRecord(answer);
  if (record === 'interpreter_form_unsupported') return toolImplementationUnavailable('interpreter_form_unsupported');
  if (record === 'not_a_record') return toolImplementationUnavailable('implementation_identity_unattested');
  const measured = await measurePath(record.installPath, probe);
  if (typeof measured === 'string') return toolImplementationUnavailable(measured);
  const matches = await digestMatches(record.installPath, record.closureDigest, probe);
  if (matches === 'unreadable') return toolImplementationUnavailable('reverify_failed');
  if (!matches) return toolImplementationUnavailable('install_record_mismatch');
  if (record.interpreter !== undefined) {
    const interpreter = await measurePath(record.interpreter.path, probe);
    if (typeof interpreter === 'string') return toolImplementationUnavailable(interpreter);
    const interpreterMatches = await digestMatches(record.interpreter.path, record.interpreter.digest, probe);
    if (interpreterMatches === 'unreadable') return toolImplementationUnavailable('reverify_failed');
    if (!interpreterMatches) return toolImplementationUnavailable('install_record_mismatch');
  }
  return brand(record, {
    dev: measured.dev,
    ino: measured.ino,
    size: measured.size,
    mtimeMs: measured.mtimeMs,
    mode: measured.mode,
    uid: measured.uid,
    gid: measured.gid,
  });
}

// ---------------------------------------------------------------------------
// Reverify
// ---------------------------------------------------------------------------

export type ToolImplementationReverifyResult =
  | 'ok'
  | { readonly reason: ToolImplementationMeasurementFailure };

/**
 * Re-measure an attested identity immediately before the server it describes is
 * spawned.
 *
 * Every check `resolveToolImplementationIdentity` made runs again, plus the one
 * that only exists once there is something to compare against: the stat tuple
 * must be the tuple that was measured at resolve. That is what catches a
 * replacement whose bytes happen to agree, and a touch that changed nothing but
 * the mtime.
 *
 * Not memoized and not cached. The whole point is that resolve and spawn are
 * two different moments, and a cached answer would assert the first moment's
 * facts about the second one.
 */
export async function reverifyToolImplementationIdentity(
  identity: ToolImplementationAttestedV1,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<ToolImplementationReverifyResult> {
  const measured = await measurePath(identity.installPath, probe);
  if (typeof measured === 'string') return { reason: measured };
  if (!sameStatTuple(measured, identity.installStat)) return { reason: 'install_record_mismatch' };
  const matches = await digestMatches(identity.installPath, identity.closureDigest, probe);
  if (matches === 'unreadable') return { reason: 'reverify_failed' };
  if (!matches) return { reason: 'reverify_failed' };
  if (identity.interpreter !== undefined) {
    const interpreter = await measurePath(identity.interpreter.path, probe);
    if (typeof interpreter === 'string') return { reason: interpreter };
    const interpreterMatches = await digestMatches(
      identity.interpreter.path,
      identity.interpreter.digest,
      probe,
    );
    if (interpreterMatches === 'unreadable') return { reason: 'reverify_failed' };
    if (!interpreterMatches) return { reason: 'reverify_failed' };
  }
  return 'ok';
}

/**
 * The shared pre-spawn gate, so both spawn points refuse on the same evidence
 * with the same words.
 *
 * An identity that is `unavailable` carries no claim to break, so there is
 * nothing to re-measure and the spawn proceeds — the receipt already says the
 * implementation is unproven. An `attested` identity is re-measured on EVERY
 * spawn, and a failure is a refusal: it is never downgraded to
 * unavailable-and-continue, because a server that was attested and no longer
 * measures the same is a server that changed under a claim somebody relied on.
 */
export async function assertToolImplementationBeforeSpawn(
  label: string,
  identity: ToolImplementationIdentityV1 | undefined,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<void> {
  if (identity === undefined || identity.kind !== 'attested') return;
  const result = await reverifyToolImplementationIdentity(identity, probe);
  if (result === 'ok') return;
  throw new ToolImplementationReverifyError(
    `${label} failed implementation reverification before launch: ${result.reason}`,
    result.reason,
  );
}

/**
 * Raised when an attested server no longer measures the way it was attested.
 * Carries the reason rather than only a message, so a caller refuses on the
 * fact instead of on a substring.
 */
export class ToolImplementationReverifyError extends Error {
  constructor(message: string, readonly reason: ToolImplementationMeasurementFailure) {
    super(message);
    this.name = 'ToolImplementationReverifyError';
  }
}
