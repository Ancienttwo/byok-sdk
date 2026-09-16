import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeIdV1, ToolImplementationAttestedV1, ToolImplementationIdentityV1, ToolImplementationUnavailableReasonV1 } from '@byok-sdk/implementation-identity';

export * from '@byok-sdk/implementation-identity';

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Runtime launch description
// ---------------------------------------------------------------------------

/**
 * WHICH logical entry of the runtime a launch addresses.
 *
 * Two, and they are the two this SDK owns: the ordinary rpc lane and the
 * prepared lane. Both start through the reserved-helper entry shape
 * `<interpreter> <entry> __byok_sdk_helper <kind> …`, so the kind is the only
 * thing that differs between them and it is bound, not passed as text.
 */
export type RuntimeLaunchKindV1 = 'pi-rpc' | 'pi-prepared';

export const RUNTIME_LAUNCH_KINDS: readonly RuntimeLaunchKindV1[] = Object.freeze([
  'pi-rpc',
  'pi-prepared',
]);

/** The SDK-reserved helper dispatch token, as `sdk-reserved-helper-host.ts` reads it. */
const SDK_RESERVED_HELPER_TOKEN = '__byok_sdk_helper';

/**
 * The FIXED argv prefix for each kind, bound here and nowhere else.
 *
 * It is a constant of this SDK rather than a record field the host chooses,
 * and it is separate from every task flag on purpose: the prefix says which
 * entry inside the sealed bundle runs, and task flags say what that entry is
 * asked to do. A host that could choose the prefix could point an attested
 * interpreter at a different entry of the same attested bundle; a consumer that
 * could fold task flags into it could smuggle a flag past the binding. The
 * record must DECLARE the same prefix as its `launchArgv` — that is how the
 * prefix becomes part of what the artifact was attested with — and
 * {@link deriveRuntimeLaunchDescription} refuses a record that declares
 * anything else.
 */
const RUNTIME_LAUNCH_FIXED_ARGV: Readonly<Record<RuntimeLaunchKindV1, readonly string[]>> = Object.freeze({
  'pi-rpc': Object.freeze([SDK_RESERVED_HELPER_TOKEN, 'pi-rpc']),
  'pi-prepared': Object.freeze([SDK_RESERVED_HELPER_TOKEN, 'pi-prepared']),
});

/**
 * The environment NAMES a runtime launch description commits a value for.
 *
 * Exactly one today: `PI_PACKAGE_DIR`, which probe p3 measured to be the
 * runtime's single read point for its own package layout (`config.js:313`) and
 * which probe p5 measured to be a hard startup dependency in the interpreted
 * layout. The description points it at {@link RuntimeLaunchDescriptionV1.assetRoot}
 * — the release's own asset directory — so the runtime reads the measured,
 * read-only theme JSON rather than whatever a writable projection directory
 * happens to contain.
 *
 * This is a commitment of NAMES, not values: it says which variables the launch
 * description is the authority for, so a consumer that sets one of them from
 * anywhere else is visibly wrong rather than quietly last-write-wins.
 */
export const RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES: readonly string[] = Object.freeze([
  'PI_PACKAGE_DIR',
]);

/**
 * The ONE description of how a runtime child starts. Strict, immutable, and
 * derived from nothing but an attested install record plus the exact pin this
 * build of the SDK declares.
 *
 * Every field exists because the alternative was a value discovered at launch
 * time from something writable:
 *
 * - `command` / `entry` — the interpreter and the sealed bundle, taken from the
 *   attested identity itself, never rebuilt from a package shape, a resolved
 *   bin or `import.meta.resolve`. The object that was checked is the object
 *   that is spawned.
 * - `fixedArgv` — the reserved-helper prefix for {@link kind}, bound separately
 *   from task flags.
 * - `processCwd` — the SEALED launch cwd, which is the child's `process.cwd()`.
 *   It is not the Agent home. A writable process cwd executes `bunfig.toml`
 *   preload and `.env` before any JavaScript inside the entry can check
 *   anything, and probe p4 measured that a `photon_rs_bg.wasm` planted in it is
 *   opened and instantiated for real.
 * - `sessionCwd` — the Agent home, passed to the runtime EXPLICITLY. Probe p2
 *   measured that every tool resolves against the session cwd rather than the
 *   process cwd, so the two decouple safely; this field is what makes the split
 *   a stated contract instead of an inherited accident.
 * - `assetRoot` — the release's own asset directory, and the value the launch
 *   commits `PI_PACKAGE_DIR` to.
 * - `envCommitments` — see {@link RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES}.
 *
 * What it deliberately does NOT carry: task flags, model selection, session ids,
 * credentials, or anything else that differs per task. Those are the consumer's
 * to append after the fixed prefix, and folding them in here would make the
 * description — and its digest — a per-task value that binds nothing.
 */
export interface RuntimeLaunchDescriptionV1 {
  readonly runtimeId: RuntimeIdV1;
  readonly kind: RuntimeLaunchKindV1;
  /** The interpreter's path, or the compiled artifact's. */
  readonly command: string;
  /** The sealed bundle the interpreter runs. Present iff the form is `interpreter+bundle`. */
  readonly entry?: string;
  readonly fixedArgv: readonly string[];
  readonly processCwd: string;
  readonly sessionCwd: string;
  readonly assetRoot: string;
  readonly envCommitments: readonly string[];
}

/** The per-launch inputs a description cannot derive from the record alone. */
export interface RuntimeLaunchInputV1 {
  readonly runtimeId: RuntimeIdV1;
  readonly kind: RuntimeLaunchKindV1;
  /**
   * The Agent home this task runs in, passed to the runtime explicitly. It is
   * NOT the process cwd and must not be: that is the whole split.
   */
  readonly sessionCwd: string;
  /**
   * The exact pin this build of the SDK declares — `adapters/pi/resolve-bin.ts`'s
   * `resolvePiRuntimeIdentity()`. Passed in rather than read here so this module
   * performs no package resolution of its own: the identity authority reads the
   * filesystem to MEASURE, never to discover.
   */
  readonly pin: { readonly name: string; readonly version: string };
}

/**
 * The canonical digest of one description, for binding.
 *
 * Taken over the description alone, with the keys inserted in sorted order so
 * the hashed bytes are a function of the content. It is what a consumer carries
 * from the moment the launch was decided to the moment the child is spawned:
 * the attested identity already binds the interpreter, the bundle, the sealed
 * assets, the asset root, the fixed argv (as the record's own `launchArgv`) and
 * the process cwd, and this digest additionally binds the per-launch session
 * cwd and the resolved kind — the two facts an identity cannot carry without
 * becoming a different identity for every task.
 */
export function runtimeLaunchDescriptionDigest(description: RuntimeLaunchDescriptionV1): string {
  return canonicalDigest({
    assetRoot: description.assetRoot,
    command: description.command,
    ...(description.entry === undefined ? {} : { entry: description.entry }),
    envCommitments: [...description.envCommitments],
    fixedArgv: [...description.fixedArgv],
    kind: description.kind,
    processCwd: description.processCwd,
    runtimeId: description.runtimeId,
    sessionCwd: description.sessionCwd,
  });
}

/**
 * Turn one attested identity into the description of the child it starts, or
 * say why it cannot.
 *
 * Every refusal below is `install_record_mismatch`, and for one reason: each is
 * the record failing to describe a launch this SDK can perform, not a file that
 * changed or a resolver that declined. There is no repair path and no default —
 * a missing asset root, a missing fork provenance, an argv prefix the host chose
 * for itself, or a sealed cwd that is the Agent home are all records that cannot
 * be launched, and a description invented over the top of one would be this SDK
 * attesting its own guess.
 */
export function deriveRuntimeLaunchDescription(
  identity: ToolImplementationAttestedV1,
  input: RuntimeLaunchInputV1,
): RuntimeLaunchDescriptionV1 | 'install_record_mismatch' {
  if (!path.isAbsolute(input.sessionCwd)) return 'install_record_mismatch';
  if (path.normalize(input.sessionCwd) !== input.sessionCwd) return 'install_record_mismatch';
  // The defect this whole contract exists to close: a process cwd that IS the
  // Agent home hands the agent a `bunfig.toml` preload on the next launch.
  if (input.sessionCwd === identity.launchCwd) return 'install_record_mismatch';
  // A second entry authority. §77 ruling 5: one release-derived launch
  // description, so the interpreter runs the artifact that was measured and
  // nothing else may name a different one.
  if (identity.entry !== undefined) return 'install_record_mismatch';
  if (identity.assetRoot === undefined || identity.assets === undefined) return 'install_record_mismatch';
  const provenance = identity.nativeProvenance;
  if (provenance === undefined) return 'install_record_mismatch';
  if (provenance.packageName !== input.pin.name || provenance.packageVersion !== input.pin.version) {
    return 'install_record_mismatch';
  }
  const fixedArgv = RUNTIME_LAUNCH_FIXED_ARGV[input.kind];
  if (identity.launchArgv.length !== fixedArgv.length) return 'install_record_mismatch';
  if (identity.launchArgv.some((arg, index) => arg !== fixedArgv[index])) return 'install_record_mismatch';
  let command: string;
  let entry: string | undefined;
  if (identity.form === 'interpreter+bundle') {
    // `validateInstallRecord` already refuses this form without an interpreter,
    // so the guard is the type's, not a second policy.
    if (identity.interpreter === undefined) return 'install_record_mismatch';
    command = identity.interpreter.path;
    entry = identity.installPath;
  } else {
    command = identity.installPath;
  }
  return Object.freeze({
    runtimeId: input.runtimeId,
    kind: input.kind,
    command,
    ...(entry === undefined ? {} : { entry }),
    fixedArgv,
    processCwd: identity.launchCwd,
    sessionCwd: input.sessionCwd,
    assetRoot: identity.assetRoot,
    envCommitments: RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES,
  });
}

/**
 * Why a runtime launch was declined. Every unavailable reason EXCEPT
 * `resolver_unconfigured`, which is not a decline at all — see
 * {@link RuntimeLaunchDecisionV1}.
 */
export type RuntimeLaunchDeclineReasonV1 = Exclude<
  ToolImplementationUnavailableReasonV1,
  'resolver_unconfigured'
>;

/**
 * What a consumer is allowed to do with a runtime subject, as three cases that
 * cannot be confused for one another.
 *
 * The runtime subject is STRICTER than the MCP subject, and this type is where
 * that asymmetry is stated (§77 ruling 3). An MCP server whose implementation
 * is unproven still runs and the receipt says it is unproven; a RUNTIME whose
 * implementation is unproven does not run at all, because it is the process the
 * whole task executes inside and an unattested one makes every downstream
 * attestation decorative.
 *
 * - `attested` — the description and the identity it came from. The consumer
 *   spawns exactly this, after re-measuring.
 * - `unconfigured` — no {@link ToolImplementationAuthority} is wired in. This
 *   SDK ships no resolver, so it is the default state and it is the DEV path:
 *   the launch proceeds unattested, exactly as it does today. It is a separate
 *   arm rather than a decline reason so a consumer cannot decline the dev path
 *   by reading `kind` alone.
 * - `declined` — an authority IS configured and the runtime is not attested.
 *   The consumer refuses the task. It is a separate arm rather than a reason on
 *   `unconfigured` so a consumer cannot let a configured-but-unattested runtime
 *   through by reading `kind` alone either. The distinction is carried by the
 *   TYPE because it is the one distinction that decides whether credentials
 *   reach a child.
 */
export type RuntimeLaunchDecisionV1 =
  | {
    readonly kind: 'attested';
    readonly description: RuntimeLaunchDescriptionV1;
    readonly identity: ToolImplementationAttestedV1;
  }
  | {
    readonly kind: 'unconfigured';
    readonly reason: 'resolver_unconfigured';
  }
  | {
    readonly kind: 'declined';
    readonly reason: RuntimeLaunchDeclineReasonV1;
  };

/**
 * Decide one runtime launch from an already-resolved identity.
 *
 * Pure: it measures nothing and reads nothing. The measurement happened in
 * {@link resolveToolImplementationIdentity}, and it happens AGAIN in
 * {@link reverifyToolImplementationIdentity} immediately before the child is
 * spawned. This function only says which of the three cases the consumer is in.
 */
export function decideRuntimeLaunch(
  identity: ToolImplementationIdentityV1,
  input: RuntimeLaunchInputV1,
): RuntimeLaunchDecisionV1 {
  if (identity.kind === 'unavailable') {
    return identity.reason === 'resolver_unconfigured'
      ? Object.freeze({ kind: 'unconfigured' as const, reason: 'resolver_unconfigured' as const })
      : Object.freeze({ kind: 'declined' as const, reason: identity.reason });
  }
  const description = deriveRuntimeLaunchDescription(identity, input);
  if (typeof description === 'string') {
    return Object.freeze({ kind: 'declined' as const, reason: description });
  }
  return Object.freeze({ kind: 'attested' as const, description, identity });
}
