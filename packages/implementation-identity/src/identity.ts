import { validateDescendantSpawn, type DescendantSpawnExpectationV1, type DescendantSpawnActualV1 } from './descendant-launch';
import { CONTROLLED_PI_DIRECTORY_ENV_NAMES, KEYS_PI_INHERITED_ENV_NAMES, KEYS_PI_WINDOWS_ENV_NAMES } from './environment';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES, loaderEnvInjections } from './environment';
import type { McpLaunchAttestation } from './launch-attestation';

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
 * WHAT EACH SIDE SUPPLIES, exactly:
 *
 * - For MCP the resolver returns a {@link ToolImplementationInstallRecordV1};
 *   runtime subjects return {@link RuntimeImplementationRecordV1}, retaining
 *   the unchanged record plus the Host descendant policy and edges. The record carries the
 *   manifest revision, the form, the versioned install path, the artifact digest,
 *   the interpreter triple for an `interpreter+bundle`, the entry, the launch
 *   argv and cwd — or an {@link ToolImplementationUnavailableV1} reason. That
 *   is the whole of the host's authority.
 * - The SDK measures everything else and seals it on: `installStat`,
 *   `interpreterStat`, `launchEnvNamesDigest` and `loaderEnvValuesDigest`.
 *   None of the four is a resolver input, and a record that carries one is not
 *   an install record. A host cannot know the environment object this SDK will
 *   hand to `spawn`, and must never guess it from its own `process.env`.
 *
 * What an `attested` identity proves is therefore exactly this: at the moment
 * it was resolved, and again at the moment the server was spawned, the file at
 * that versioned install path — and, for an `interpreter+bundle`, the
 * interpreter beside it — was a root-owned, non-symlink, non-writable regular
 * file, reached through a symlink-free directory chain, whose bytes hash to its
 * attested digest and whose `(dev, ino, size, mtime, mode,
 * uid, gid)` tuple is the one that was measured at resolve, and that the
 * environment handed to that spawn agrees with the environment measured at
 * resolve over the NAMES PROJECTION plus the CONTROLLED LOADER-VALUES SCOPE
 * defined by {@link toolImplementationLaunchEnvNamesDigest} and
 * {@link toolImplementationLoaderEnvValuesDigest}. It is not a claim that the
 * two environments are identical: the projection subtracts an exact,
 * enumerated set of names this SDK itself mints or strips between the two
 * moments ({@link TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES} and
 * {@link PROVIDER_CREDENTIAL_ENV_DENY_NAMES}), and every other name — this
 * SDK's `BYOK_*` control prefix included — is either bound by the names digest
 * or refused outright at the spawn gate.
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
 * - `install_record_mismatch` — the record does not describe the filesystem: a
 *   directory chain that resolves elsewhere, a symlink leaf, not a regular
 *   file, not root-owned, writable, a stat tuple that moved (a different inode
 *   at the same name included), or — AT RESOLVE — bytes that do not hash to the
 *   `closureDigest` the record claims. A digest disagreement at resolve is the
 *   record being wrong about the filesystem, not a verification that decayed:
 *   nothing has been verified yet, so there is nothing to have changed.
 * - `reverify_failed` — a file that could not be READ at all, at either layer;
 *   and, at the spawn gate only, bytes that no longer hash to the digest this
 *   SDK itself measured at resolve. That is the one digest disagreement that
 *   means "it changed since we checked", and the reverify verdict carries the
 *   `subject` (`artifact` or `interpreter`) saying which file it was.
 *
 * The rule across the two layers, stated once: a digest disagreement is
 * `install_record_mismatch` at resolve and `reverify_failed` at reverify,
 * because at resolve the digest is the HOST's claim and at reverify it is this
 * SDK's own prior measurement.
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
 *
 * `path` goes through the same canonical path identity rule as the
 * artifact (symlink-free parent chain, regular non-symlink leaf), at resolve and at every spawn, and is bound to its inode by
 * `interpreterStat` for the same reason.
 */
export interface ToolImplementationInterpreterV1 {
  readonly path: string;
  readonly digest: string;
  readonly loadCommandsDigest: string;
}

/**
 * One file of the release's SEALED ASSET SET: static data the runtime reads at
 * startup or on demand, which is not code and therefore is not covered by the
 * artifact's own closure digest.
 *
 * It exists because an interpreted release is not one file. Probe p5 measured
 * that `dist/modes/interactive/theme/{dark,light}.json` is a HARD startup
 * dependency of the runtime's rpc mode — missing them is an uncaught `initTheme`
 * ENOENT before any frame — and that the export-html templates plus the photon
 * `photon_rs_bg.wasm` are lazy dependencies of individual tools. Probe p4
 * measured that the photon loader falls back to `process.cwd()/photon_rs_bg.wasm`
 * and that a wasm planted there is opened and instantiated for real. A release
 * whose assets are neither measured nor pinned is therefore a release whose
 * behaviour an agent can change without touching a single byte of attested code.
 *
 * `path` is RELATIVE to {@link ToolImplementationAttestedV1.assetRoot} and must
 * stay under it; `digest` is the sha256 hex of the file's bytes. The list is
 * Host-declared — the SDK never discovers assets — and every entry is measured
 * at resolve exactly as the artifact is, and re-measured before every spawn.
 */
export interface ToolImplementationAssetV1 {
  readonly path: string;
  readonly digest: string;
}

/**
 * The native runtime's SEMANTIC identity, as the host declares it from the one
 * exact pin it built the release from plus that build's own inputs.
 *
 * Separate from the artifact digest on purpose: the digest says which bytes ran,
 * and this says which published package, which upstream commit and which fork
 * build those bytes were produced from. A consumer that must know the compiler
 * contract — input preparation counts against it — needs the second fact, and
 * §10.3.1 forbids deriving it from caller text or a version label.
 *
 * A writable `package.json` under an agent's HOME is never a source for any of
 * this. That is the entire reason this component is part of the immutable
 * install record: a manifest the agent can rewrite would be an execution-identity
 * authority the agent controls.
 */
export interface ToolImplementationNativeProvenanceV1 {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly upstreamBase: string;
  readonly upstreamCommit: string;
  readonly forkBuild: number;
  readonly compilerVersion: number;
}

/**
 * The filesystem tuple measured at resolve and required to be unchanged at
 * every later spawn. One is measured for the artifact (`installStat`) and, for
 * an `interpreter+bundle`, one for the interpreter (`interpreterStat`).
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
 * An attested identity, and what makes one unconstructible by a caller.
 *
 * Not a type-level brand. A `unique symbol` brand is nominal per DECLARATION
 * site, so the one emitted into this package's `.d.ts` is a different type from
 * the one in its source — the brand would make the package incompatible with
 * itself rather than protect anything. Two structural facts carry the
 * guarantee instead, and both are tested:
 *
 * 1. NOTHING ON THE WIRE CAN CARRY ONE. `daemon/control-protocol.ts` is
 *    key-exact everywhere and has no field, anywhere, in which a control
 *    client could put an implementation identity. There is no shape to reject
 *    because there is no slot to fill.
 * 2. A FORGED ONE BUYS NOTHING. The only two producers are
 *    {@link resolveToolImplementationIdentity}, which measures the filesystem
 *    before it returns, and {@link parseToolImplementationIdentity}, which
 *    reads a daemon-authored task-scoped file and is deliberately not part of
 *    the client package's public surface. Whatever either returns is measured AGAIN
 *    before every spawn, so an identity nobody earned names a file that is not
 *    a root-owned, non-writable artifact hashing to its own claimed digest, and
 *    the spawn is refused.
 */
export interface ToolImplementationAttestedV1 {
  readonly kind: 'attested';
  /** The only authority this SDK recognises. A resolver cannot name another. */
  readonly authority: 'host-install-record';
  readonly manifestRevision: string;
  readonly form: 'compiled-executable' | 'interpreter+bundle';
  /**
   * The versioned immutable install path: an absolute path whose directory
   * chain is symlink-free and whose leaf is a regular, non-symlink file. It is
   * the NAME; the identity is the inode it named, carried in
   * {@link installStat}. The rule: symlink-free parent chain, regular
   * non-symlink leaf, identity bound by the inode.
   */
  readonly installPath: string;
  /** sha256 hex of the executable or bundle artifact's bytes. */
  readonly closureDigest: string;
  readonly closureKind: 'artifact';
  /** Required iff `form === 'interpreter+bundle'`, forbidden otherwise. */
  readonly interpreter?: ToolImplementationInterpreterV1;
  readonly entry?: string;
  readonly launchArgv: readonly string[];
  readonly launchCwd: string;
  /**
   * The release's own asset directory: an absolute, symlink-free directory
   * every {@link assets} entry is resolved under, and the value the launch
   * description commits `PI_PACKAGE_DIR` to for a runtime subject.
   *
   * Present iff {@link assets} is. Both-or-neither, in both directions: an
   * asset list with no root names files nothing can resolve, and a root with no
   * list is a directory nothing measures.
   */
  readonly assetRoot?: string;
  /**
   * The sealed asset set, sorted by `path` and free of duplicates. See
   * {@link ToolImplementationAssetV1}.
   */
  readonly assets?: readonly ToolImplementationAssetV1[];
  /** See {@link ToolImplementationNativeProvenanceV1}. */
  readonly nativeProvenance?: ToolImplementationNativeProvenanceV1;
  /**
   * SDK-measured at resolve: the digest of the NAMES the child's environment
   * carries, never their values. See
   * {@link toolImplementationLaunchEnvNamesDigest} for the projection it is
   * taken over and why that projection exists.
   */
  readonly launchEnvNamesDigest: string;
  /**
   * SDK-measured at resolve. §27.2: digest of the sanitized loader-affecting
   * env VALUES as they would reach the child — the values of the names
   * the client's `daemon/environment.ts` denies, which is expected to be the empty
   * canonical map. Never the full task environment: the probe carries no
   * execution nonce, and binding a task or server nonce into an identity would
   * make every task's identity different for reasons that have nothing to do
   * with the implementation.
   */
  readonly loaderEnvValuesDigest: string;
  /** SDK-measured at resolve. See {@link ToolImplementationStatTupleV1}. */
  readonly installStat: ToolImplementationStatTupleV1;
  /**
   * SDK-measured at resolve, present iff {@link interpreter} is. The
   * interpreter half of an `interpreter+bundle` is re-measured at every spawn
   * exactly as the artifact is, and a tuple it cannot be compared against
   * would make that half a digest check alone — blind to a replaced inode, a
   * touched mtime, and an interpreter that stopped being root-owned.
   */
  readonly interpreterStat?: ToolImplementationStatTupleV1;
  /**
   * SDK-measured at resolve, present iff {@link assets} is, and in the SAME
   * ORDER. Each sealed asset is bound to its inode for the same reason the
   * artifact and the interpreter are: a theme JSON that still hashes right but
   * is a different file at the same name is not the file that was attested.
   */
  readonly assetStats?: readonly ToolImplementationStatTupleV1[];
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

/**
 * Every runtime this SDK can ask a host to attest. A closed union, not a
 * string: a runtime id the SDK does not know is not a runtime whose launch it
 * can describe, so there is nothing to fall back to.
 */
export type RuntimeIdV1 = 'pi';

export const RUNTIME_IDS: readonly RuntimeIdV1[] = Object.freeze(['pi']);

/**
 * WHAT is being attested, as an explicit discriminated subject rather than a
 * shape a caller infers.
 *
 * There are two, and they are not interchangeable. An `mcp-server` subject
 * names one configured server inside one toolset: it is addressed by the pair
 * the daemon already uses everywhere else, and what it attests is the binary
 * behind a tool. A `runtime` subject names the coding-agent runtime the task
 * itself executes in: it is addressed by the runtime id alone, because there is
 * one selected runtime per task and no toolset owns it; runtimeEntry chooses
 * one of the four exact logical entries without granting execution by itself.
 *
 * The union exists so an MCP locator can never stand in for a runtime locator.
 * The two carry different contracts — a runtime record additionally declares
 * the sealed asset set and the native fork provenance, and an unattested
 * runtime DECLINES the task where an unattested server merely reports itself
 * unproven — and a subject-less locator would make those two contracts one
 * shape that the resolver, not this SDK, got to choose between.
 */
export type ToolImplementationSubjectV1 =
  | {
    readonly kind: 'mcp-server';
    readonly toolsetId: string;
    readonly serverName: string;
  }
  | {
    readonly kind: 'runtime';
    readonly runtimeId: RuntimeIdV1;
  };

/** What the resolver is asked about: one subject, and where it launches. */
export type ToolImplementationLocatorV1 = {
  readonly subject: Extract<ToolImplementationSubjectV1, { kind: 'mcp-server' }>;
  readonly command: string;
  readonly args: readonly string[];
  readonly launch: McpLaunchAttestation;
} | {
  readonly subject: Extract<ToolImplementationSubjectV1, { kind: 'runtime' }>;
  readonly runtimeEntry: RuntimeEntryV1;
  readonly command?: never;
  readonly args?: never;
  readonly launch?: never;
};

/**
 * The install record a resolver returns, which is an attested identity MINUS
 * everything a host does not get to assert:
 *
 * - `installStat` / `interpreterStat` / `assetStats` — the filesystem tuples
 *   this SDK measures itself. A host that could choose them would be the
 *   authority on whether its own install moved.
 * - `launchEnvNamesDigest` / `loaderEnvValuesDigest` — facts about the exact
 *   environment object THIS SDK will hand to `spawn`. A host does not have
 *   that object: it is `daemon/environment.ts`'s `buildRuntimeEnv` output for
 *   one task on one device, not the host's `process.env`, and a resolver that
 *   reconstructed it from its own environment (or from a copy of this
 *   package's deny list) would be attesting a guess.
 */
export type ToolImplementationInstallRecordV1 = Omit<
  ToolImplementationAttestedV1,
  'installStat' | 'interpreterStat' | 'assetStats' | 'launchEnvNamesDigest' | 'loaderEnvValuesDigest'
>;

/** Frozen M0 runtime vocabulary; declaration does not enable a dispatcher. */
export type RuntimeEntryV1 = 'pi-prepared' | 'pi-rpc' | 'pi-subagent-print' | 'pi-subagent-runner';
export const RUNTIME_ENTRIES: readonly RuntimeEntryV1[] = Object.freeze([
  'pi-prepared', 'pi-rpc', 'pi-subagent-print', 'pi-subagent-runner',
]);
/** Canonical runtime prefix. Host declares it; the SDK checks exact equality. */
export function runtimeEntryFixedArgv(kind: RuntimeEntryV1): readonly string[] {
  return Object.freeze(['__byok_sdk_helper', kind]);
}
export type McpImplementationLocatorV1 = Extract<ToolImplementationLocatorV1, { subject: { kind: 'mcp-server' } }>;
export type RuntimeImplementationLocatorV1 = Extract<ToolImplementationLocatorV1, { subject: { kind: 'runtime' } }>;

/** Finite M0 vocabulary, from pi-subagents0.60.0 producer inventory. No wildcards. */
export const DESCENDANT_PER_LAUNCH_ENV_NAMES: readonly string[] = Object.freeze([
  'MCP_DIRECT_TOOLS',
  'PI_INTERCOM_SESSION_ID',
  'PI_INTERCOM_STABLE_ID',
  'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT',
  'PI_SUBAGENT_CAPABILITY_CEILING_V1',
  'PI_SUBAGENT_CHILD',
  'PI_SUBAGENT_CHILD_AGENT',
  'PI_SUBAGENT_CHILD_INDEX',
  'PI_SUBAGENT_DEPTH',
  'PI_SUBAGENT_EXTENSION_BINDINGS',
  'PI_SUBAGENT_FANOUT_CHILD',
  'PI_SUBAGENT_FORK_CACHE_KEY',
  'PI_SUBAGENT_INHERIT_GLOBAL_CONTEXT',
  'PI_SUBAGENT_INHERIT_PROJECT_CONTEXT',
  'PI_SUBAGENT_INHERIT_SKILLS',
  'PI_SUBAGENT_INTERCOM_SESSION_NAME',
  'PI_SUBAGENT_MAX_DEPTH',
  'PI_SUBAGENT_MAX_SPAWNS_PER_RUN',
  'PI_SUBAGENT_MAX_SPAWNS_PER_SESSION',
  'PI_SUBAGENT_MCP_DIRECT_TOOLS',
  'PI_SUBAGENT_ORCHESTRATOR_SESSION_ID',
  'PI_SUBAGENT_ORCHESTRATOR_TARGET',
  'PI_SUBAGENT_PARENT_CAPABILITY_TOKEN',
  'PI_SUBAGENT_PARENT_CHILD_INDEX',
  'PI_SUBAGENT_PARENT_CONTROL_INBOX',
  'PI_SUBAGENT_PARENT_DEPTH',
  'PI_SUBAGENT_PARENT_EVENT_SINK',
  'PI_SUBAGENT_PARENT_PATH',
  'PI_SUBAGENT_PARENT_ROOT_RUN_ID',
  'PI_SUBAGENT_PARENT_RUN_ID',
  'PI_SUBAGENT_PARENT_SESSION',
  'PI_SUBAGENT_PERMISSION_AUDIT_PATH',
  'PI_SUBAGENT_PERMISSION_POLICY',
  'PI_SUBAGENT_REQUIRED_TOOLS',
  'PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS',
  'PI_SUBAGENT_RUN_FANOUT_BUDGET',
  'PI_SUBAGENT_RUN_ID',
  'PI_SUBAGENT_SESSION_NAME',
  'PI_SUBAGENT_STEER_ACK_DIR',
  'PI_SUBAGENT_STEER_CAPABILITY',
  'PI_SUBAGENT_STEER_INBOX',
  'PI_SUBAGENT_STRUCTURED_OUTPUT_ACCEPTANCE_CAPTURE',
  'PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE',
  'PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA',
  'PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR',
  'PI_SUBAGENT_THINKING_CEILING',
  'PI_SUBAGENT_TOOL_BUDGET',
  'PI_SUBAGENT_TOOL_BUDGET_ZERO_AUTH',
  'PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH',
  'PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS',
  'PI_SUBAGENT_WAIT_TOOL_ENABLED',
  'PI_SUBAGENT_WATCHDOG_CHILD_CONFIG',
]);

export interface RuntimeDescendantPolicyV1 {
  readonly envNameAllowlist: readonly string[];
  readonly maxDepth: number;
  readonly fanout: number;
  readonly parallel: number;
  readonly sessionCap: number;
}
export interface RuntimeDescendantEdgeV1 {
  readonly parent: RuntimeEntryV1;
  readonly child: RuntimeEntryV1;
  readonly inheritsCredential: true;
}
/** Type edges only. Instance/budget custody must be enforced before any spawn. */
export const RUNTIME_DESCENDANT_EDGES: readonly RuntimeDescendantEdgeV1[] = Object.freeze([
  Object.freeze({ parent: 'pi-rpc', child: 'pi-subagent-print', inheritsCredential: true }),
  Object.freeze({ parent: 'pi-rpc', child: 'pi-subagent-runner', inheritsCredential: true }),
  Object.freeze({ parent: 'pi-subagent-print', child: 'pi-subagent-print', inheritsCredential: true }),
  Object.freeze({ parent: 'pi-subagent-print', child: 'pi-subagent-runner', inheritsCredential: true }),
  Object.freeze({ parent: 'pi-subagent-runner', child: 'pi-subagent-print', inheritsCredential: true }),
]);
export interface RuntimeImplementationRecordV1 {
  readonly record: ToolImplementationInstallRecordV1;
  readonly descendantPolicy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
}
export type RuntimeImplementationResolutionV1 = ToolImplementationUnavailableV1 | RuntimeImplementationRecordV1;
/** Measured identity and immutable Host declaration stay together in the daemon. */
export type ResolvedRuntimeImplementationV1 = ToolImplementationUnavailableV1 | {
  readonly kind: 'attested';
  readonly identity: ToolImplementationAttestedV1;
  readonly descendantPolicy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
};

/** Read-only installation facts. Deliberately not a launch identity: no environment digests. */
export interface RuntimeInstallationMeasurementV1 {
  readonly kind: 'measured-installation';
  readonly record: ToolImplementationInstallRecordV1;
  readonly installStat: ToolImplementationStatTupleV1;
  readonly interpreterStat?: ToolImplementationStatTupleV1;
  readonly assetStats?: readonly ToolImplementationStatTupleV1[];
  readonly descendantPolicy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
}
export type RuntimeInstallationMeasurementResultV1 = RuntimeInstallationMeasurementV1 | ToolImplementationUnavailableV1;
type PhysicalMeasurements = Pick<RuntimeInstallationMeasurementV1, 'installStat' | 'interpreterStat' | 'assetStats'>;
type PhysicalIdentity = Omit<ToolImplementationAttestedV1, 'launchEnvNamesDigest' | 'loaderEnvValuesDigest'>;
export type RuntimeInstallationReverifyResult = 'ok' | {
  readonly reason: ToolImplementationMeasurementFailure;
  readonly subject: 'artifact' | 'interpreter' | 'asset';
};

export type ToolImplementationResolutionV1 =
  | ToolImplementationUnavailableV1
  | ToolImplementationInstallRecordV1
  | RuntimeImplementationRecordV1;

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
// Launch environment measurement
// ---------------------------------------------------------------------------

/** This SDK's own control-plane prefix, as `daemon/environment.ts` hard-denies it. */
const BYOK_CONTROL_ENV_PREFIX = 'BYOK_';

/**
 * The EXACT names this SDK itself mints into a gated child's environment
 * between the moment an identity is resolved and the moment the server it
 * describes is spawned.
 *
 * An identity is resolved ONCE, by the daemon, off the environment
 * `buildRuntimeEnv` produced — which hard-denies the whole `BYOK_*` prefix, so
 * it contains none of these. It then travels to two spawns in two processes:
 * the daemon's own admission probe, and the Pi extension's server pool inside
 * the runtime child. Each of those layers a per-task or per-server control
 * value on top, and the list is enumerated here rather than matched by prefix
 * because the prefix is not intrinsically inert — a `BYOK_*` name is a knob
 * this SDK reads elsewhere, so "starts with BYOK_" is not a reason to project
 * a name away unnoticed.
 *
 * Every entry, with where it is minted — five names, and each one is here
 * because this SDK itself puts it on a GATED CHILD's environment after the
 * identity was measured. A name that never reaches a gated child does not
 * belong on this list: projecting it away would blind the gate to a control
 * variable that, arriving anyway, could only have come from somewhere this SDK
 * does not mint.
 *
 * - `BYOK_HOST_TOOLSET_CONTEXT` — the per-server task-lane nonce minted at
 *   `daemon/task-runner.ts:3355` (name at `:1148`) into the server's own `env`
 *   block, which `mcp/client.ts:244` layers onto the child environment the
 *   gate below measures.
 * - `BYOK_STORE_DIR` / `BYOK_PRODUCT_ID` — minted into the same per-server
 *   `env` block at `daemon/task-runner.ts:3353-3354`, and reaching the gated
 *   child by the same path.
 * - `BYOK_SDK_CUSTODY_LAUNCH_RECORD` / `BYOK_SDK_CUSTODY_PARENT_DEPTH` — the
 *   custody pair minted by the SDK custody dispatcher between resolve and
 *   spawn as preset-entry inputs: the parent's contract depth commitment and
 *   the per-launch descendant record path. The custody preset entries
 *   (`custody/pi-subagent-print-entry.ts`, `custody/pi-subagent-runner-entry.ts`)
 *   consume and re-project them; neither is ever part of the attested exec env.
 *
 * OUT OF SCOPE, deliberately, and NOT exempt — a name below appearing on a
 * gated child environment is a refusal, not a projection:
 *
 * - `BYOK_PI_MCP_CONFIG_PATH` (`adapters/pi/mcp-config.ts:1`) and
 *   `BYOK_PI_PERMISSION_MODE` (`adapters/pi/subagents-policy-config.ts:1`) are
 *   set on the PI PROCESS at `adapters/pi/pi-adapter.ts:491-492`, and the
 *   server pool strips the whole `/^BYOK_PI_/` shape back off
 *   (`adapters/pi/mcp-server-pool.ts:42,271`) before it spawns a server. They
 *   address this SDK's own Pi entries, not a toolset server, so neither ever
 *   reaches a gated child: the pool's children are spawned without them, and
 *   the daemon's admission probe spawns off `buildRuntimeEnv`'s output, which
 *   hard-denies the whole `BYOK_*` prefix (`daemon/environment.ts:202`).
 * - `adapters/claude/resolve-bin.ts:29` / `resolve-approval-mcp-bin.ts:49`'s
 *   `BYOK_*_BIN` overrides are daemon-pre-child inputs read out of the
 *   daemon's own `process.env`; they are never placed on a spawned child's
 *   environment.
 * - `BYOK_MCP_ENV_KEY` / `BYOK_MCP_PAYLOAD_*` (`adapters/codex/codex-adapter
 *   .ts:467,484`, `bin/mcp-env-launcher.ts:8-26`) are the Codex CLI's own
 *   launcher knobs. The Codex lane's MCP children are spawned by the CLI, not
 *   through this package's gate, so they are not names an attested spawn here
 *   may carry.
 * - The SDK-reserved helper servers' `BYOK_STORE_DIR`/`BYOK_TASK_ID`/
 *   `BYOK_*_CONTEXT` blocks (`bin/sdk-reserved-helper-runners.ts`) back this
 *   package's own bins, which carry no host install record and therefore never
 *   reach an attested gate.
 */
export const TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES: readonly string[] = Object.freeze([
  'BYOK_HOST_TOOLSET_CONTEXT',
  'BYOK_PRODUCT_ID',
  'BYOK_SDK_CUSTODY_LAUNCH_RECORD',
  'BYOK_SDK_CUSTODY_PARENT_DEPTH',
  'BYOK_STORE_DIR',
]);

const LIFECYCLE_ENV_NAMES = new Set<string>(TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES);
const CREDENTIAL_ENV_NAMES = new Set<string>(PROVIDER_CREDENTIAL_ENV_DENY_NAMES as readonly string[]);

/**
 * The environment an MCP toolset child is spawned with, as an identity is
 * allowed to bind it: everything, minus two named projections.
 *
 * - {@link TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES} — the exact
 *   lifecycle names above, which this SDK adds between resolve and spawn.
 * - {@link PROVIDER_CREDENTIAL_ENV_DENY_NAMES} — the credential-surface
 *   projection, controlled by the existing custody/credential-stripping
 *   authority (`adapters/provider-credential-environment.ts`, applied by
 *   `withoutProviderCredentials` at the subscription and BYOK-custody
 *   boundaries), so a task dispatched with a hosted manifest selection reaches
 *   the pool with fewer names than the daemon measured.
 *
 * Binding either set would make the names digest a value that legitimately
 * differs between the two spawn points, and every attested spawn in the hosted
 * Pi lane would be refused for a difference this SDK made on purpose — the
 * same reasoning §27.2 already applies to the task and server nonces added at
 * launch.
 *
 * Nothing that can influence a loader is excluded: the loader deny list and
 * these two sets are disjoint, so the §27.2 values digest is unweakened, and
 * the names digest still catches every added, removed or renamed variable
 * outside them — `PYTHONPATH`, `PERL5LIB`, `CLASSPATH`, `GEM_HOME` included.
 * An unenumerated `BYOK_*` name is NOT projected away here; it stays in the
 * names digest and is refused separately by
 * {@link unexpectedLaunchEnvControlNames}.
 */
function launchEnvUnderIdentity(env: Readonly<Record<string, string>>): Record<string, string> {
  const bound: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (LIFECYCLE_ENV_NAMES.has(name)) continue;
    if (CREDENTIAL_ENV_NAMES.has(name)) continue;
    bound[name] = env[name]!;
  }
  return bound;
}

/**
 * Every `BYOK_*` name on a child environment that this SDK cannot account for.
 *
 * `buildRuntimeEnv` hard-denies the whole prefix, and the only names that may
 * legitimately be layered back on afterwards are the enumerated lifecycle ones
 * above. Anything else wearing this SDK's control prefix on the environment of
 * a child about to be started under an attested identity is a control-plane
 * name from somewhere this SDK does not mint — so the gate refuses rather than
 * projecting it away or letting it pass as an ordinary bound name.
 */
export function unexpectedLaunchEnvControlNames(
  env: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(BYOK_CONTROL_ENV_PREFIX) && !LIFECYCLE_ENV_NAMES.has(name))
    .sort();
}

/**
 * sha256 over the canonical JSON of one already-ordered value. Keys are
 * inserted in sorted order by every caller below, and `JSON.stringify`
 * preserves insertion order for non-index string keys, so the bytes hashed are
 * a function of the content alone.
 */
function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * The NAMES the child's environment carries, digested. Never their values:
 * this is the fact that catches a variable appearing, disappearing or being
 * renamed between resolve and spawn, and a value digest of the whole
 * environment would bind every task-scoped secret and nonce in it.
 *
 * Taken over {@link launchEnvUnderIdentity}, for the reasons documented there.
 */
export function toolImplementationLaunchEnvNamesDigest(env: Readonly<Record<string, string>>): string {
  return canonicalDigest(Object.keys(launchEnvUnderIdentity(env)));
}

/**
 * §27.2: the loader-affecting VALUES as they would reach the child, digested.
 *
 * The names are the shared {@link loaderEnvInjections} —
 * this module keeps no second copy of that list, and neither may a host. In
 * every environment `buildRuntimeEnv` produces the set is empty, so the
 * expected value is the digest of the empty canonical map; a non-empty one is
 * loader injection that reached the child, and at spawn it is a refusal.
 */
export function toolImplementationLoaderEnvValuesDigest(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const bound = launchEnvUnderIdentity(env);
  const values: Record<string, string> = {};
  // `loaderEnvInjections` returns the present names already sorted.
  const controlled = Object.keys(bound).filter((name) => (CONTROLLED_PI_DIRECTORY_ENV_NAMES as readonly string[])
    .includes(platform === 'win32' ? name.toUpperCase() : name));
  for (const name of [...new Set([...loaderEnvInjections(bound, platform), ...controlled])].sort()) values[name] = bound[name]!;
  return canonicalDigest(values);
}

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

const ASSET_KEYS = ['path', 'digest'] as const;

/**
 * The one rule for an asset's relative path, applied before anything is
 * measured: it must be relative, already normalized, and must not climb.
 *
 * `path.normalize` is compared against the declared spelling rather than used
 * to repair it. A record that says `theme/../../../etc/hosts` is a record that
 * is wrong about its own release, and rewriting it into something measurable
 * would be this SDK choosing a file the host did not declare.
 */
function normalizedRelativeAssetPath(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  if (path.isAbsolute(value)) return undefined;
  if (path.normalize(value) !== value) return undefined;
  const segments = value.split(path.sep);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return value;
}

/**
 * Validate the sealed asset set. Sorted and duplicate-free is REQUIRED rather
 * than repaired: the list is bound positionally to `assetStats`, and two
 * spellings of the same set would be two records describing one release.
 */
function validateAssets(value: unknown): readonly ToolImplementationAssetV1[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const assets: ToolImplementationAssetV1[] = [];
  let previous: string | undefined;
  for (const entry of value) {
    if (!plainRecord(entry) || !exactKeys(entry, ASSET_KEYS)) return undefined;
    const relative = normalizedRelativeAssetPath(entry.path);
    if (relative === undefined) return undefined;
    if (typeof entry.digest !== 'string' || !SHA256_HEX.test(entry.digest)) return undefined;
    if (previous !== undefined && relative <= previous) return undefined;
    previous = relative;
    assets.push(Object.freeze({ path: relative, digest: entry.digest }));
  }
  return Object.freeze(assets);
}

const NATIVE_PROVENANCE_KEYS = [
  'packageName',
  'packageVersion',
  'upstreamBase',
  'upstreamCommit',
  'forkBuild',
  'compilerVersion',
] as const;

function validateNativeProvenance(value: unknown): ToolImplementationNativeProvenanceV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, NATIVE_PROVENANCE_KEYS)) return undefined;
  if (!nonEmptyString(value.packageName)) return undefined;
  if (!nonEmptyString(value.packageVersion)) return undefined;
  if (!nonEmptyString(value.upstreamBase)) return undefined;
  if (!nonEmptyString(value.upstreamCommit)) return undefined;
  if (!Number.isSafeInteger(value.forkBuild)) return undefined;
  if (!Number.isSafeInteger(value.compilerVersion)) return undefined;
  return Object.freeze({
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    upstreamBase: value.upstreamBase,
    upstreamCommit: value.upstreamCommit,
    forkBuild: value.forkBuild as number,
    compilerVersion: value.compilerVersion as number,
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
  'assetRoot',
  'assets',
  'nativeProvenance',
] as const;

/**
 * The facts this SDK measures and seals onto a record. `interpreterStat` is
 * present iff the record names an interpreter and `assetStats` iff it declares
 * assets; the other two always are.
 */
const SEALED_KEYS = [
  'installStat',
  'interpreterStat',
  'assetStats',
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
  if (!nonEmptyString(value.launchCwd) || !path.isAbsolute(value.launchCwd)) return 'not_a_record';
  if (!Array.isArray(value.launchArgv) || value.launchArgv.some((arg) => typeof arg !== 'string')) {
    return 'not_a_record';
  }
  if (value.entry !== undefined && !nonEmptyString(value.entry)) return 'not_a_record';
  // The sealed asset set, both-or-neither with its root. A root that is not
  // absolute names a directory this SDK would have to resolve against
  // something, and there is nothing it may legitimately resolve against.
  let assetRoot: string | undefined;
  let assets: readonly ToolImplementationAssetV1[] | undefined;
  if (value.assetRoot !== undefined || value.assets !== undefined) {
    if (value.assetRoot === undefined || value.assets === undefined) return 'not_a_record';
    if (!nonEmptyString(value.assetRoot) || !path.isAbsolute(value.assetRoot)) return 'not_a_record';
    if (path.normalize(value.assetRoot) !== value.assetRoot) return 'not_a_record';
    assets = validateAssets(value.assets);
    if (assets === undefined) return 'not_a_record';
    assetRoot = value.assetRoot;
  }
  let nativeProvenance: ToolImplementationNativeProvenanceV1 | undefined;
  if (value.nativeProvenance !== undefined) {
    nativeProvenance = validateNativeProvenance(value.nativeProvenance);
    if (nativeProvenance === undefined) return 'not_a_record';
  }
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
    ...(assetRoot === undefined || assets === undefined ? {} : { assetRoot, assets }),
    ...(nativeProvenance === undefined ? {} : { nativeProvenance }),
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
  if (!exactKeys(value, [...INSTALL_RECORD_KEYS, ...SEALED_KEYS])) return undefined;
  const {
    installStat: rawStat,
    interpreterStat: rawInterpreterStat,
    assetStats: rawAssetStats,
    launchEnvNamesDigest,
    loaderEnvValuesDigest,
    ...rest
  } = value;
  const record = validateInstallRecord(rest);
  if (typeof record === 'string') return undefined;
  const installStat = validateStatTuple(rawStat);
  if (installStat === undefined) return undefined;
  if (typeof launchEnvNamesDigest !== 'string' || !SHA256_HEX.test(launchEnvNamesDigest)) return undefined;
  if (typeof loaderEnvValuesDigest !== 'string' || !SHA256_HEX.test(loaderEnvValuesDigest)) return undefined;
  // Present iff the record declares assets, both directions and position for
  // position. An asset list with no tuples could only be reverified by digest,
  // and a tuple list that does not line up with it names measurements of files
  // nobody declared.
  let assetStats: readonly ToolImplementationStatTupleV1[] | undefined;
  if (record.assets === undefined) {
    if (rawAssetStats !== undefined) return undefined;
  } else {
    if (!Array.isArray(rawAssetStats) || rawAssetStats.length !== record.assets.length) return undefined;
    const tuples: ToolImplementationStatTupleV1[] = [];
    for (const raw of rawAssetStats) {
      const tuple = validateStatTuple(raw);
      if (tuple === undefined) return undefined;
      tuples.push(tuple);
    }
    assetStats = Object.freeze(tuples);
  }
  // Present iff the record names an interpreter, both directions. A bundle
  // whose interpreter carries no tuple is an identity whose interpreter half
  // could only be reverified by digest, and an artifact-only identity that
  // carries one describes a measurement nothing here made.
  if (record.interpreter === undefined) {
    if (rawInterpreterStat !== undefined) return undefined;
    return seal(record, { installStat, assetStats, launchEnvNamesDigest, loaderEnvValuesDigest });
  }
  const interpreterStat = validateStatTuple(rawInterpreterStat);
  if (interpreterStat === undefined) return undefined;
  return seal(record, { installStat, interpreterStat, assetStats, launchEnvNamesDigest, loaderEnvValuesDigest });
}

/** Everything an install record is missing before it is an identity. */
interface ToolImplementationSealedMeasurements {
  readonly installStat: ToolImplementationStatTupleV1;
  /** Present iff the record names an interpreter. */
  readonly interpreterStat?: ToolImplementationStatTupleV1;
  /** Present iff the record declares assets, in the record's own order. */
  readonly assetStats?: readonly ToolImplementationStatTupleV1[];
  readonly launchEnvNamesDigest: string;
  readonly loaderEnvValuesDigest: string;
}

/**
 * The only place an `attested` value comes into existence. Both callers have
 * already validated the record against {@link INSTALL_RECORD_KEYS}; this adds
 * the fields a host does not get to choose ({@link SEALED_KEYS}).
 */
function seal(
  record: ToolImplementationInstallRecordV1,
  measured: ToolImplementationSealedMeasurements,
): ToolImplementationAttestedV1 {
  return Object.freeze({
    ...record,
    launchEnvNamesDigest: measured.launchEnvNamesDigest,
    loaderEnvValuesDigest: measured.loaderEnvValuesDigest,
    installStat: measured.installStat,
    ...(measured.interpreterStat === undefined ? {} : { interpreterStat: measured.interpreterStat }),
    ...(measured.assetStats === undefined ? {} : { assetStats: measured.assetStats }),
  });
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Why one measured path is not the artifact the record describes. Split by
 * WHICH fact failed, because the two mean different things operationally:
 * `install_record_mismatch` is "this is not the file that was attested" (a
 * directory chain that resolves elsewhere, replaced inode, wrong owner,
 * writable, a symlink leaf), and
 * `reverify_failed` is "this IS the file, and its bytes are no longer the bytes
 * that were attested" (or could not be read at all).
 */
export type ToolImplementationMeasurementFailure = 'install_record_mismatch' | 'reverify_failed';

/**
 * The ONE canonicalization every attested path goes through — the artifact and
 * the interpreter, at resolve and at every later spawn. Nothing else in this
 * module decides whether a path names the file it claims to.
 *
 * What it asserts:
 *
 * 1. THE PARENT CHAIN IS SYMLINK-FREE AND NOT REPLACEABLE: every directory
 *    component resolves to itself, `realpath(dirname(p)) === dirname(p)`. That
 *    is the property the check exists for — a path whose directories resolve
 *    elsewhere is a path whoever owns the intervening link chooses, and it also
 *    rejects a `..` or a non-normalized component before anything is measured.
 * 2. THE LEAF IS A REGULAR FILE AND NOT A SYMLINK, by `lstat` rather than
 *    `stat`, so a link is rejected rather than followed.
 * 3. IDENTITY IS THE INODE, not the name. The caller binds the returned
 *    `(dev, ino, size, mtimeMs, mode, uid, gid)` tuple and the content digest;
 *    `sameStatTuple` then refuses anything that is not that exact inode with
 *    those exact bits. Because (2) has already proven the leaf is not a
 *    symlink, `lstat`'s `(dev, ino)` here ARE `stat`'s.
 *
 * What it deliberately does NOT assert, and why the leaf's own `realpath` is
 * not compared against the target: a HARDLINK ALIAS of the attested artifact —
 * a second name in the same release directory for the same inode — is the same
 * file, not a different one, and refusing it would refuse a legitimate release
 * layout. `realpath` cannot be used to tell the two apart in any case: probed
 * on Darwin under Bun 1.4.2, `fs.realpath` on a hardlinked regular file
 * returned a SIBLING link's name (same device, same inode, neither entry a
 * symlink) in 2 of 96 checks, while Node 24 and Linux returned the queried name
 * in 96 of 96. Binding the leaf name through `realpath` therefore bound a value
 * that is not stable for the file it describes, and a Bun-compiled daemon would
 * have refused a good artifact with `install_record_mismatch`.
 *
 * Nothing is weakened by dropping it. A SYMLINK leaf is still refused by (2). A
 * symlinked or `..`-bearing PARENT is still refused by (1) — which is where a
 * path substitution attack actually lives, since replacing the leaf's own name
 * with a symlink is exactly what (2) catches. A DIFFERENT FILE at the same name
 * is refused by the tuple and the digest: same name, new inode is a tuple
 * mismatch, and a hardlink alias that is NOT the recorded inode fails the same
 * way. Ownership, mode and digest checks are untouched.
 */
async function measureCanonicalPathIdentity(
  target: string,
  probe: ToolImplementationFsProbe,
): Promise<ToolImplementationStatEntry | ToolImplementationMeasurementFailure> {
  const parent = path.dirname(target);
  let resolvedParent: string;
  try {
    resolvedParent = await probe.realpath(parent);
  } catch {
    return 'install_record_mismatch';
  }
  if (resolvedParent !== parent) return 'install_record_mismatch';
  let stats: ToolImplementationStatEntry;
  try {
    stats = await probe.lstat(target);
  } catch {
    return 'install_record_mismatch';
  }
  if (stats.isSymbolicLink) return 'install_record_mismatch';
  if (!stats.isFile) return 'install_record_mismatch';
  return stats;
}

/**
 * The two OWNERSHIP facts, asserted once — at resolve — because they are
 * properties of the install rather than of this particular launch:
 *
 * 1. It is root-owned. A file owned by the uid the daemon and the agent share
 *    is a file the agent can `chmod` and rewrite, so a cleared write bit on its
 *    own proves nothing.
 * 2. No write bit is set for anyone. Owner included: the owner is root, and a
 *    root-writable install is one a compromised root service rewrites without a
 *    `chmod` first.
 *
 * They are NOT re-asserted as absolutes at spawn, and do not need to be:
 * `uid`, `gid` and `mode` are part of the stat tuple this SDK measured here,
 * and {@link reverifyToolImplementationIdentity} requires that whole tuple to
 * be unchanged. An install that stopped being root-owned, or grew a write bit,
 * fails that comparison for exactly the reason it would fail the absolute
 * check — with the added strength that it also fails when it changed into some
 * OTHER root-owned, non-writable file.
 */
function measureOwnership(stats: ToolImplementationStatEntry): ToolImplementationMeasurementFailure | undefined {
  if (stats.uid !== 0) return 'install_record_mismatch';
  if ((stats.mode & 0o222) !== 0) return 'install_record_mismatch';
  return undefined;
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

function statTupleOf(stats: ToolImplementationStatEntry): ToolImplementationStatTupleV1 {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
  });
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

/**
 * Where one declared asset actually is, or nothing.
 *
 * The containment check is done on the RESOLVED absolute path rather than on
 * the declared spelling alone, so a path that passed
 * {@link normalizedRelativeAssetPath} but still lands outside the root — which
 * `path.normalize` cannot produce for a climb-free relative path, and which a
 * future root spelling change could — is refused rather than measured. Nothing
 * here follows a link: {@link measureCanonicalPathIdentity} requires the parent
 * chain to resolve to itself and the leaf to be a regular non-symlink file, so
 * an asset symlinked out of the release fails on the leaf and an asset reached
 * through a symlinked release subdirectory fails on the chain.
 */
function assetAbsolutePath(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) return undefined;
  return resolved;
}

/**
 * Measure the sealed asset set the way the artifact is measured: canonical path
 * identity, ownership, and the declared digest.
 *
 * Returns the per-asset stat tuples in the record's order, or the failure that
 * stopped it. A record whose asset root does not resolve to itself is an
 * `install_record_mismatch` for the same reason a symlinked install directory
 * is: it names a directory whoever owns the intervening link chooses.
 */
async function measureDeclaredAssets(
  assetRoot: string,
  assets: readonly ToolImplementationAssetV1[],
  probe: ToolImplementationFsProbe,
): Promise<readonly ToolImplementationStatTupleV1[] | ToolImplementationMeasurementFailure> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await probe.realpath(assetRoot);
  } catch {
    return 'install_record_mismatch';
  }
  if (resolvedRoot !== assetRoot) return 'install_record_mismatch';
  const tuples: ToolImplementationStatTupleV1[] = [];
  for (const asset of assets) {
    const target = assetAbsolutePath(assetRoot, asset.path);
    if (target === undefined) return 'install_record_mismatch';
    const measured = await measureCanonicalPathIdentity(target, probe);
    if (typeof measured === 'string') return measured;
    const ownership = measureOwnership(measured);
    if (ownership !== undefined) return ownership;
    const matches = await digestMatches(target, asset.digest, probe);
    if (matches === 'unreadable') return 'reverify_failed';
    if (!matches) return 'install_record_mismatch';
    tuples.push(statTupleOf(measured));
  }
  return Object.freeze(tuples);
}

/**
 * Re-measure the sealed asset set before a spawn: the same canonical path
 * identity, the tuple this SDK measured at resolve, and the digest again.
 *
 * The split between the two failure words is the module's rule, unchanged: a
 * tuple that moved is `install_record_mismatch` (this is not the file that was
 * attested) and bytes that no longer hash are `reverify_failed` (it is the
 * file, and it changed).
 */
async function reverifyDeclaredAssets(
  assetRoot: string,
  assets: readonly ToolImplementationAssetV1[],
  assetStats: readonly ToolImplementationStatTupleV1[],
  probe: ToolImplementationFsProbe,
): Promise<ToolImplementationMeasurementFailure | undefined> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await probe.realpath(assetRoot);
  } catch {
    return 'install_record_mismatch';
  }
  if (resolvedRoot !== assetRoot) return 'install_record_mismatch';
  if (assetStats.length !== assets.length) return 'install_record_mismatch';
  for (const [index, asset] of assets.entries()) {
    const target = assetAbsolutePath(assetRoot, asset.path);
    if (target === undefined) return 'install_record_mismatch';
    const measured = await measureCanonicalPathIdentity(target, probe);
    if (typeof measured === 'string') return measured;
    if (!sameStatTuple(measured, assetStats[index]!)) return 'install_record_mismatch';
    const matches = await digestMatches(target, asset.digest, probe);
    if (matches !== true) return 'reverify_failed';
  }
  return undefined;
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
type LaunchEnvironment = Readonly<Record<string, string>> | ((record: ToolImplementationInstallRecordV1) => Readonly<Record<string, string>>);

async function readResolution(
  authority: ToolImplementationAuthority | undefined,
  locator: ToolImplementationLocatorV1,
): Promise<unknown> {
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
  return answer;
}

/** MCP-only entry; runtime declarations cannot be silently reduced to identity. */
export async function resolveToolImplementationIdentity(
  authority: ToolImplementationAuthority | undefined,
  locator: McpImplementationLocatorV1,
  launchEnv: LaunchEnvironment,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<ToolImplementationIdentityV1> {
  if (locator.subject.kind !== 'mcp-server') return toolImplementationUnavailable('implementation_identity_unattested');
  const answer = await readResolution(authority, locator);
  if (plainRecord(answer) && answer.kind === 'unavailable') return answer as unknown as ToolImplementationUnavailableV1;
  const record = validateInstallRecord(answer);
  if (record === 'interpreter_form_unsupported') return toolImplementationUnavailable('interpreter_form_unsupported');
  if (record === 'not_a_record') return toolImplementationUnavailable('implementation_identity_unattested');
  return measureInstallRecord(record, launchEnv, probe);
}

/** One strict policy parser shared by Host declarations and internal launch plans. */
export function parseRuntimeDescendantPolicy(value: unknown): RuntimeDescendantPolicyV1 | undefined {
  const policy = value;
  if (!plainRecord(policy) || !exactKeys(policy, ['envNameAllowlist', 'maxDepth', 'fanout', 'parallel', 'sessionCap'])) return undefined;
  // Base names frozen by M0; additional per-launch names come only from the producer inventory.
  const vocabulary = new Set<string>([...KEYS_PI_INHERITED_ENV_NAMES, ...KEYS_PI_WINDOWS_ENV_NAMES, ...CONTROLLED_PI_DIRECTORY_ENV_NAMES, ...DESCENDANT_PER_LAUNCH_ENV_NAMES]);
  if (!Array.isArray(policy.envNameAllowlist)) return undefined;
  for (const [index, name] of policy.envNameAllowlist.entries()) {
    if (typeof name !== 'string' || !vocabulary.has(name) || (index > 0 && policy.envNameAllowlist[index - 1] >= name)) return undefined;
  }
  for (const key of ['maxDepth', 'fanout', 'parallel', 'sessionCap'] as const) {
    const count = policy[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || Object.is(count, -0) || count < (key === 'maxDepth' ? 0 : 1)) return undefined;
  }
  return Object.freeze({
    envNameAllowlist: Object.freeze([...policy.envNameAllowlist]) as readonly string[],
    maxDepth: policy.maxDepth as number, fanout: policy.fanout as number,
    parallel: policy.parallel as number, sessionCap: policy.sessionCap as number,
  });
}

/** Strict runtime wrapper cutover. No bare record, defaults or shape guessing. */
export function parseRuntimeImplementationRecord(value: unknown): RuntimeImplementationRecordV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['record', 'descendantPolicy', 'edges'])) return undefined;
  const record = validateInstallRecord(value.record);
  if (typeof record === 'string') return undefined;
  const policy = parseRuntimeDescendantPolicy(value.descendantPolicy);
  if (policy === undefined) return undefined;
  if (!Array.isArray(value.edges) || value.edges.length !== RUNTIME_DESCENDANT_EDGES.length) return undefined;
  for (const [index, edge] of value.edges.entries()) {
    const expected = RUNTIME_DESCENDANT_EDGES[index]!;
    if (!plainRecord(edge) || !exactKeys(edge, ['parent', 'child', 'inheritsCredential']) ||
      edge.parent !== expected.parent || edge.child !== expected.child || edge.inheritsCredential !== true) return undefined;
  }
  return Object.freeze({ record, descendantPolicy: policy, edges: RUNTIME_DESCENDANT_EDGES });
}

async function resolveRuntimeDeclaration(
  authority: ToolImplementationAuthority | undefined,
  locator: RuntimeImplementationLocatorV1,
): Promise<RuntimeImplementationRecordV1 | ToolImplementationUnavailableV1> {
  if (locator.subject.kind !== 'runtime' || locator.subject.runtimeId !== 'pi' || !RUNTIME_ENTRIES.includes(locator.runtimeEntry)) {
    return toolImplementationUnavailable('implementation_identity_unattested');
  }
  const answer = await readResolution(authority, locator);
  if (plainRecord(answer) && answer.kind === 'unavailable') return answer as unknown as ToolImplementationUnavailableV1;
  const declaration = parseRuntimeImplementationRecord(answer);
  if (declaration === undefined) return toolImplementationUnavailable('implementation_identity_unattested');
  const fixedArgv = runtimeEntryFixedArgv(locator.runtimeEntry);
  if (declaration.record.launchArgv.length !== fixedArgv.length || declaration.record.launchArgv.some((arg, i) => arg !== fixedArgv[i])) {
    return toolImplementationUnavailable('install_record_mismatch');
  }
  return declaration;
}

export async function resolveRuntimeImplementation(
  authority: ToolImplementationAuthority | undefined,
  locator: RuntimeImplementationLocatorV1,
  launchEnv: LaunchEnvironment,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<ResolvedRuntimeImplementationV1> {
  const declaration = await resolveRuntimeDeclaration(authority, locator);
  if ('kind' in declaration) return declaration;
  const identity = await measureInstallRecord(declaration.record, launchEnv, probe);
  if (identity.kind === 'unavailable') return identity;
  return Object.freeze({ kind: 'attested', identity, descendantPolicy: declaration.descendantPolicy, edges: declaration.edges });
}

/** No process, environment construction, task state or credential observation. */
export async function measureRuntimeInstallation(
  authority: ToolImplementationAuthority,
  locator: RuntimeImplementationLocatorV1,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<RuntimeInstallationMeasurementResultV1> {
  const declaration = await resolveRuntimeDeclaration(authority, locator);
  if ('kind' in declaration) return declaration;
  const physical = await measurePhysicalRecord(declaration.record, probe);
  if ('kind' in physical) return physical;
  return Object.freeze({ kind: 'measured-installation', record: declaration.record, ...physical,
    descendantPolicy: declaration.descendantPolicy, edges: declaration.edges });
}

/** Fresh read-only observation, never a pre-spawn authorization or environment claim. */
export async function reverifyRuntimeInstallation(
  measurement: RuntimeInstallationMeasurementV1,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<RuntimeInstallationReverifyResult> {
  return reverifyPhysicalImplementation({ ...measurement.record,
    installStat: measurement.installStat,
    ...(measurement.interpreterStat === undefined ? {} : { interpreterStat: measurement.interpreterStat }),
    ...(measurement.assetStats === undefined ? {} : { assetStats: measurement.assetStats }),
  }, probe);
}

/** Single physical measurement authority, shared by the two subject-specific consumers. */
async function measureInstallRecord(
  record: ToolImplementationInstallRecordV1,
  launchEnv: LaunchEnvironment,
  probe: ToolImplementationFsProbe,
): Promise<ToolImplementationIdentityV1> {
  let environment!: Pick<ToolImplementationSealedMeasurements, 'launchEnvNamesDigest' | 'loaderEnvValuesDigest'>;
  const physical = await measurePhysicalRecord(record, probe, () => {
    // Preserve the existing callback/check order: assets, env, interpreter.
    const resolvedLaunchEnv = typeof launchEnv === 'function' ? launchEnv(record) : launchEnv;
    environment = {
      launchEnvNamesDigest: toolImplementationLaunchEnvNamesDigest(resolvedLaunchEnv),
      loaderEnvValuesDigest: toolImplementationLoaderEnvValuesDigest(resolvedLaunchEnv),
    };
  });
  return 'kind' in physical ? physical : seal(record, { ...physical, ...environment });
}

async function measurePhysicalRecord(
  record: ToolImplementationInstallRecordV1,
  probe: ToolImplementationFsProbe,
  beforeInterpreter?: () => void,
): Promise<PhysicalMeasurements | ToolImplementationUnavailableV1> {
  const measured = await measureCanonicalPathIdentity(record.installPath, probe);
  if (typeof measured === 'string') return toolImplementationUnavailable(measured);
  const ownership = measureOwnership(measured);
  if (ownership !== undefined) return toolImplementationUnavailable(ownership);
  const matches = await digestMatches(record.installPath, record.closureDigest, probe);
  if (matches === 'unreadable') return toolImplementationUnavailable('reverify_failed');
  // A digest disagreement HERE is the record being wrong about the filesystem,
  // not a verification that decayed: this is the first measurement, so there is
  // no earlier one to have moved away from. `reverify_failed` is the spawn
  // gate's word for the same disagreement against the SDK's own prior digest.
  if (!matches) return toolImplementationUnavailable('install_record_mismatch');
  // This physical core does not invent an environment. The launch consumer
  // computes its original env facts at beforeInterpreter; observation does not.
  // The sealed asset set is measured HERE, per file, exactly as the artifact
  // was: a release whose static startup data is unmeasured is a release whose
  // behaviour changes without a byte of attested code changing.
  let assetStats: readonly ToolImplementationStatTupleV1[] | undefined;
  if (record.assetRoot !== undefined && record.assets !== undefined) {
    const measuredAssets = await measureDeclaredAssets(record.assetRoot, record.assets, probe);
    if (typeof measuredAssets === 'string') return toolImplementationUnavailable(measuredAssets);
    assetStats = measuredAssets;
  }
  beforeInterpreter?.();
  const measurements: PhysicalMeasurements = {
    installStat: statTupleOf(measured),
    ...(assetStats === undefined ? {} : { assetStats }),
  };
  if (record.interpreter === undefined) return Object.freeze(measurements);
  const interpreter = await measureCanonicalPathIdentity(record.interpreter.path, probe);
  if (typeof interpreter === 'string') return toolImplementationUnavailable(interpreter);
  const interpreterOwnership = measureOwnership(interpreter);
  if (interpreterOwnership !== undefined) return toolImplementationUnavailable(interpreterOwnership);
  const interpreterMatches = await digestMatches(record.interpreter.path, record.interpreter.digest, probe);
  if (interpreterMatches === 'unreadable') return toolImplementationUnavailable('reverify_failed');
  if (!interpreterMatches) return toolImplementationUnavailable('install_record_mismatch');
  // The interpreter's own tuple, kept for the same reason the artifact's is:
  // without it the spawn gate can only re-hash the interpreter's bytes, and a
  // replaced inode, a touched mtime or an interpreter that stopped being
  // root-owned would all pass.
  return Object.freeze({ ...measurements, interpreterStat: statTupleOf(interpreter) });
}

// ---------------------------------------------------------------------------
// Reverify
// ---------------------------------------------------------------------------

/**
 * The one failure that exists only at spawn.
 *
 * `launch_env_drift` is not a {@link ToolImplementationUnavailableReasonV1}
 * and never will be: at resolve there is nothing to disagree with, because
 * that is the moment the environment is MEASURED. It can only be reached by a
 * later spawn whose environment is not the one that was measured, and a
 * resolver cannot claim it because a resolver never sees an environment.
 *
 * `launch_env_unexpected_control_name` is the second, and exists for the same
 * reason: a child about to be started under an attested identity carries a
 * `BYOK_*` control name this SDK does not mint on any gated path
 * ({@link TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES}). It is a distinct
 * reason rather than drift because drift is "the environment moved" and this
 * is "the environment carries control-plane authority from nowhere" — and
 * because it must fail closed even when the same name was already present at
 * resolve, which drift alone would not catch.
 *
 * Neither is a {@link ToolImplementationUnavailableReasonV1}: the host-facing
 * resolution contract is unchanged, and a resolver can claim neither.
 */
export type ToolImplementationReverifyFailure =
  | ToolImplementationMeasurementFailure
  | 'launch_env_drift'
  | 'launch_env_unexpected_control_name';

/**
 * WHICH of the things an identity binds moved. Carried beside the reason
 * because `reverify_failed` on the artifact, on the interpreter and on a sealed
 * asset send an operator to three different files.
 */
export type ToolImplementationReverifySubject = 'artifact' | 'interpreter' | 'asset' | 'launch-env';

export type ToolImplementationReverifyResult =
  | 'ok'
  | {
    readonly reason: ToolImplementationReverifyFailure;
    readonly subject: ToolImplementationReverifySubject;
  };

/**
 * Re-measure an attested identity immediately before the server it describes is
 * spawned.
 *
 * The path is canonicalized again — symlink-free parent chain, regular
 * non-symlink leaf — and the artifact's
 * bytes are hashed again. On top of that runs the check that
 * only exists once there is something to compare against: the stat tuple must
 * be the tuple that was measured at resolve, `uid`, `gid` and `mode` included.
 * That is what catches a replacement whose bytes happen to agree, a touch that
 * changed nothing but the mtime, and an install that stopped being root-owned
 * or grew a write bit since it was attested.
 *
 * The interpreter of an `interpreter+bundle` runs the SAME two checks against
 * the SAME two recorded facts. It is the thing that maps the bundle in and
 * decides what else gets mapped beside it, so an identity that re-hashed the
 * artifact byte for byte while accepting any interpreter that still hashed
 * right — replaced inode, cleared ownership, new mtime — would be strictly
 * weaker at spawn than it was at resolve.
 *
 * `launchEnv` is the exact environment object the caller is about to hand to
 * `spawn`. It is checked twice, and the check is over the names projection
 * plus the controlled loader-values scope, never over the whole environment.
 * A `BYOK_*` name this SDK does not mint on a gated path is
 * `launch_env_unexpected_control_name` — control-plane authority from nowhere,
 * refused whether or not it was there at resolve. Otherwise the two digests
 * are recomputed: a name that appeared, vanished or was renamed, or a
 * loader-affecting value that reached the child, is `launch_env_drift`, the
 * identity having been measured against one environment while the child would
 * be started in another.
 *
 * Not memoized and not cached. The whole point is that resolve and spawn are
 * two different moments, and a cached answer would assert the first moment's
 * facts about the second one.
 */
export async function reverifyToolImplementationIdentity(
  identity: ToolImplementationAttestedV1,
  launchEnv: Readonly<Record<string, string>>,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<ToolImplementationReverifyResult> {
  const physical = await reverifyPhysicalImplementation(identity, probe);
  if (physical !== 'ok') return physical;
  // Asked BEFORE the digests, so an unaccountable control name is reported as
  // itself rather than as generic drift — and so it still refuses when the
  // same name was present at resolve and the digests therefore agree.
  if (unexpectedLaunchEnvControlNames(launchEnv).length > 0) {
    return { reason: 'launch_env_unexpected_control_name', subject: 'launch-env' };
  }
  if (toolImplementationLaunchEnvNamesDigest(launchEnv) !== identity.launchEnvNamesDigest
    || toolImplementationLoaderEnvValuesDigest(launchEnv) !== identity.loaderEnvValuesDigest) {
    return { reason: 'launch_env_drift', subject: 'launch-env' };
  }
  return 'ok';
}

/**
 * The shared pre-spawn gate, so both spawn points refuse on the same evidence
 * with the same words.
 *
 * `launchEnv` must be the env the CALLER is about to spawn with, not the one
 * it resolved with — that is the whole comparison.
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
  launchEnv: Readonly<Record<string, string>>,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<void> {
  if (identity === undefined || identity.kind !== 'attested') return;
  const result = await reverifyToolImplementationIdentity(identity, launchEnv, probe);
  if (result === 'ok') return;
  throw new ToolImplementationReverifyError(
    `${label} failed implementation reverification before launch: ${result.reason} (${result.subject})`,
    result.reason,
    result.subject,
  );
}

/**
 * Raised when an attested server no longer measures the way it was attested.
 * Carries the reason rather than only a message, so a caller refuses on the
 * fact instead of on a substring.
 */
export class ToolImplementationReverifyError extends Error {
  constructor(
    message: string,
    readonly reason: ToolImplementationReverifyFailure,
    readonly subject: ToolImplementationReverifySubject,
  ) {
    super(message);
    this.name = 'ToolImplementationReverifyError';
  }
}


/** Physical checks have one implementation; existing V1 env semantics remain at their caller. */
async function reverifyPhysicalImplementation(
  identity: PhysicalIdentity, probe: ToolImplementationFsProbe,
): Promise<RuntimeInstallationReverifyResult> {
  const measured = await measureCanonicalPathIdentity(identity.installPath, probe);
  if (typeof measured === 'string') return { reason: measured, subject: 'artifact' };
  if (!sameStatTuple(measured, identity.installStat)) {
    return { reason: 'install_record_mismatch', subject: 'artifact' };
  }
  const matches = await digestMatches(identity.installPath, identity.closureDigest, probe);
  if (matches !== true) return { reason: 'reverify_failed', subject: 'artifact' };
  if (identity.interpreter !== undefined) {
    const interpreter = await measureCanonicalPathIdentity(identity.interpreter.path, probe);
    if (typeof interpreter === 'string') return { reason: interpreter, subject: 'interpreter' };
    // `interpreterStat` is present on every identity this module seals for an
    // `interpreter+bundle`, and `parseToolImplementationIdentity` refuses one
    // that arrives without it, so an absent tuple here is an identity from
    // nowhere rather than an older shape to tolerate.
    if (identity.interpreterStat === undefined || !sameStatTuple(interpreter, identity.interpreterStat)) {
      return { reason: 'install_record_mismatch', subject: 'interpreter' };
    }
    const interpreterMatches = await digestMatches(
      identity.interpreter.path,
      identity.interpreter.digest,
      probe,
    );
    if (interpreterMatches !== true) return { reason: 'reverify_failed', subject: 'interpreter' };
  }
  if (identity.assetRoot !== undefined && identity.assets !== undefined) {
    // `assetStats` is present on every identity this module seals for a record
    // that declares assets, and `parseToolImplementationIdentity` refuses one
    // that arrives without it, so an absent list here is an identity from
    // nowhere rather than an older shape to tolerate.
    if (identity.assetStats === undefined) return { reason: 'install_record_mismatch', subject: 'asset' };
    const assetFailure = await reverifyDeclaredAssets(
      identity.assetRoot,
      identity.assets,
      identity.assetStats,
      probe,
    );
    if (assetFailure !== undefined) return { reason: assetFailure, subject: 'asset' };
  }
  return 'ok';
}

/** Validates delegated consistency and physical bytes, not concurrency/budget custody. */
export async function assertDescendantSpawn(
  launch: unknown, expected: DescendantSpawnExpectationV1, actual: DescendantSpawnActualV1,
  probe: ToolImplementationFsProbe = realToolImplementationFsProbe,
): Promise<void> {
  const parsed = validateDescendantSpawn(launch, expected, actual);
  if (parsed.template.identity.kind !== 'attested') throw new Error('descendant_invalid_template');
  const result = await reverifyPhysicalImplementation(parsed.template.identity, probe);
  if (result !== 'ok') throw new ToolImplementationReverifyError(
    `Descendant failed implementation reverification before launch: ${result.reason} (${result.subject})`, result.reason, result.subject,
  );
}
