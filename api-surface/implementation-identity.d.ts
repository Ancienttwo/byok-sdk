// ==== @byok-sdk/implementation-identity dist/descendant-launch.d.ts ====
import { type ImplementationSpawnBindingV1 } from './spawn-binding';
import { type RuntimeDescendantPolicyV1, type RuntimeDescendantEdgeV1, type RuntimeEntryV1 } from './identity';
export interface DescendantLimitsV1 {
    readonly maxDepth: number;
    readonly fanout: number;
    readonly parallel: number;
    readonly sessionCap: number;
}
export interface DescendantContextV1 {
    readonly format: 'byok.runtime-descendant-context';
    readonly version: 1;
    readonly templateKind: RuntimeEntryV1;
    readonly edge: {
        readonly parent: RuntimeEntryV1;
        readonly child: RuntimeEntryV1;
    };
    readonly rootTaskId: string;
    readonly parentInstancePath: readonly number[];
    readonly instancePath: readonly number[];
    readonly depth: number;
    readonly remainingDepth: number;
    readonly effectiveLimits: DescendantLimitsV1;
    readonly task: string;
    readonly modelCandidates: readonly {
        readonly provider: string;
        readonly model: string;
    }[];
    readonly attempt: number;
    readonly session: {
        readonly cwd: string;
        readonly root: string;
        readonly file: string | null;
    };
    /** Metadata retains its owning MCP parser; this layer validates the envelope and env, not MCP semantics. */
    readonly mcp: {
        readonly env: Readonly<Record<string, string>>;
        readonly metadata: Readonly<Record<string, unknown>>;
    };
    readonly exactNames: readonly string[];
    readonly envValues: Readonly<Record<string, string | null>>;
    readonly controlledDirValues: Readonly<Record<string, string>>;
}
export interface DescendantLaunchV1 {
    readonly format: 'byok.descendant-launch';
    readonly version: 1;
    readonly template: ImplementationSpawnBindingV1;
    readonly templateDigest: string;
    readonly policy: RuntimeDescendantPolicyV1;
    readonly perLaunch: DescendantContextV1;
}
/** Independently selected from the verified parent, never reconstructed from the submitted child config. */
export interface DescendantSpawnExpectationV1 {
    readonly template: ImplementationSpawnBindingV1;
    readonly policy: RuntimeDescendantPolicyV1;
    readonly edges: readonly RuntimeDescendantEdgeV1[];
    readonly parent: {
        readonly kind: RuntimeEntryV1;
        readonly rootTaskId: string;
        readonly instancePath: readonly number[];
        readonly depth: number;
        readonly effectiveLimits: DescendantLimitsV1;
    };
    readonly inheritedCredentialNames: readonly string[];
}
export interface DescendantSpawnActualV1 {
    readonly command: string;
    readonly entry?: string;
    readonly fixedArgv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}
export declare class DescendantLaunchError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/** Hash original JSON member order, before the V1 parser projects its output. */
export declare function descendantTemplateDigest(template: ImplementationSpawnBindingV1): string;
/** Strict owned shape only. Independent parent and final-env comparisons are mandatory in assertDescendantSpawn. */
export declare function parseDescendantLaunch(value: unknown): DescendantLaunchV1;
/** Necessary launch consistency, not an atomic budget claim or permission to enable recursive execution. */
export declare function validateDescendantSpawn(input: unknown, expected: DescendantSpawnExpectationV1, actual: DescendantSpawnActualV1): DescendantLaunchV1;
// ==== @byok-sdk/implementation-identity dist/environment.d.ts ====
/** Fixed credential-name projection shared by measurement and client stripping. */
export declare const PROVIDER_CREDENTIAL_ENV_DENY_NAMES: readonly ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "ZAI_API_KEY", "ANT_LING_API_KEY", "NVIDIA_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_CODING_CN_API_KEY", "OPENCODE_API_KEY", "RADIUS_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY", "KIMI_API_KEY", "HF_TOKEN", "MOONSHOT_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "PI_PROVIDER_API_KEY"];
export declare const LOADER_ENV_DENY_PATTERNS: readonly string[];
export declare function loaderEnvInjections(env: Readonly<Record<string, string | undefined>>, platform?: NodeJS.Platform): readonly string[];
/** Directory selectors whose trusted values must be explicitly committed by a runtime launch. */
export declare const CONTROLLED_PI_DIRECTORY_ENV_NAMES: readonly ["PI_PACKAGE_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];
/** Fixed names of the credential launcher's inherited environment, shared with admission measurement. */
export declare const KEYS_PI_INHERITED_ENV_NAMES: readonly ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "TZ", "TERM", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"];
export declare const KEYS_PI_WINDOWS_ENV_NAMES: readonly ["SystemRoot", "COMSPEC", "PATHEXT", "windir", "SYSTEMDRIVE", "PROGRAMFILES", "APPDATA", "LOCALAPPDATA"];
// ==== @byok-sdk/implementation-identity dist/identity.d.ts ====
import { type DescendantSpawnExpectationV1, type DescendantSpawnActualV1 } from './descendant-launch';
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
export type ToolImplementationUnavailableReasonV1 = 'implementation_identity_unattested' | 'resolver_unconfigured' | 'unencapsulated_source' | 'interpreter_not_encapsulated' | 'interpreter_form_unsupported' | 'install_record_mismatch' | 'reverify_failed';
export declare const TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS: readonly ToolImplementationUnavailableReasonV1[];
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
export declare function toolImplementationUnavailable(reason: ToolImplementationUnavailableReasonV1): ToolImplementationUnavailableV1;
/** The unconfigured state, which is this SDK's default for every tool. */
export declare const TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED: ToolImplementationUnavailableV1;
/**
 * Every runtime this SDK can ask a host to attest. A closed union, not a
 * string: a runtime id the SDK does not know is not a runtime whose launch it
 * can describe, so there is nothing to fall back to.
 */
export type RuntimeIdV1 = 'pi';
export declare const RUNTIME_IDS: readonly RuntimeIdV1[];
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
export type ToolImplementationSubjectV1 = {
    readonly kind: 'mcp-server';
    readonly toolsetId: string;
    readonly serverName: string;
} | {
    readonly kind: 'runtime';
    readonly runtimeId: RuntimeIdV1;
};
/** What the resolver is asked about: one subject, and where it launches. */
export type ToolImplementationLocatorV1 = {
    readonly subject: Extract<ToolImplementationSubjectV1, {
        kind: 'mcp-server';
    }>;
    readonly command: string;
    readonly args: readonly string[];
    readonly launch: McpLaunchAttestation;
} | {
    readonly subject: Extract<ToolImplementationSubjectV1, {
        kind: 'runtime';
    }>;
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
export type ToolImplementationInstallRecordV1 = Omit<ToolImplementationAttestedV1, 'installStat' | 'interpreterStat' | 'assetStats' | 'launchEnvNamesDigest' | 'loaderEnvValuesDigest'>;
/** Frozen M0 runtime vocabulary; declaration does not enable a dispatcher. */
export type RuntimeEntryV1 = 'pi-prepared' | 'pi-rpc' | 'pi-subagent-print' | 'pi-subagent-runner';
export declare const RUNTIME_ENTRIES: readonly RuntimeEntryV1[];
/** Canonical runtime prefix. Host declares it; the SDK checks exact equality. */
export declare function runtimeEntryFixedArgv(kind: RuntimeEntryV1): readonly string[];
export type McpImplementationLocatorV1 = Extract<ToolImplementationLocatorV1, {
    subject: {
        kind: 'mcp-server';
    };
}>;
export type RuntimeImplementationLocatorV1 = Extract<ToolImplementationLocatorV1, {
    subject: {
        kind: 'runtime';
    };
}>;
/** Finite M0 vocabulary, from pi-subagents0.60.0 producer inventory. No wildcards. */
export declare const DESCENDANT_PER_LAUNCH_ENV_NAMES: readonly string[];
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
export declare const RUNTIME_DESCENDANT_EDGES: readonly RuntimeDescendantEdgeV1[];
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
export type RuntimeInstallationReverifyResult = 'ok' | {
    readonly reason: ToolImplementationMeasurementFailure;
    readonly subject: 'artifact' | 'interpreter' | 'asset';
};
export type ToolImplementationResolutionV1 = ToolImplementationUnavailableV1 | ToolImplementationInstallRecordV1 | RuntimeImplementationRecordV1;
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
export declare const realToolImplementationFsProbe: ToolImplementationFsProbe;
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
export declare const TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES: readonly string[];
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
export declare function unexpectedLaunchEnvControlNames(env: Readonly<Record<string, string>>): readonly string[];
/**
 * The NAMES the child's environment carries, digested. Never their values:
 * this is the fact that catches a variable appearing, disappearing or being
 * renamed between resolve and spawn, and a value digest of the whole
 * environment would bind every task-scoped secret and nonce in it.
 *
 * Taken over {@link launchEnvUnderIdentity}, for the reasons documented there.
 */
export declare function toolImplementationLaunchEnvNamesDigest(env: Readonly<Record<string, string>>): string;
/**
 * §27.2: the loader-affecting VALUES as they would reach the child, digested.
 *
 * The names are the shared {@link loaderEnvInjections} —
 * this module keeps no second copy of that list, and neither may a host. In
 * every environment `buildRuntimeEnv` produces the set is empty, so the
 * expected value is the digest of the empty canonical map; a non-empty one is
 * loader injection that reached the child, and at spawn it is a refusal.
 */
export declare function toolImplementationLoaderEnvValuesDigest(env: Readonly<Record<string, string>>, platform?: NodeJS.Platform): string;
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
export declare function parseToolImplementationIdentity(value: unknown): ToolImplementationIdentityV1 | undefined;
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
/** MCP-only entry; runtime declarations cannot be silently reduced to identity. */
export declare function resolveToolImplementationIdentity(authority: ToolImplementationAuthority | undefined, locator: McpImplementationLocatorV1, launchEnv: LaunchEnvironment, probe?: ToolImplementationFsProbe): Promise<ToolImplementationIdentityV1>;
/** One strict policy parser shared by Host declarations and internal launch plans. */
export declare function parseRuntimeDescendantPolicy(value: unknown): RuntimeDescendantPolicyV1 | undefined;
/** Strict runtime wrapper cutover. No bare record, defaults or shape guessing. */
export declare function parseRuntimeImplementationRecord(value: unknown): RuntimeImplementationRecordV1 | undefined;
export declare function resolveRuntimeImplementation(authority: ToolImplementationAuthority | undefined, locator: RuntimeImplementationLocatorV1, launchEnv: LaunchEnvironment, probe?: ToolImplementationFsProbe): Promise<ResolvedRuntimeImplementationV1>;
/** No process, environment construction, task state or credential observation. */
export declare function measureRuntimeInstallation(authority: ToolImplementationAuthority, locator: RuntimeImplementationLocatorV1, probe?: ToolImplementationFsProbe): Promise<RuntimeInstallationMeasurementResultV1>;
/** Fresh read-only observation, never a pre-spawn authorization or environment claim. */
export declare function reverifyRuntimeInstallation(measurement: RuntimeInstallationMeasurementV1, probe?: ToolImplementationFsProbe): Promise<RuntimeInstallationReverifyResult>;
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
export type ToolImplementationReverifyFailure = ToolImplementationMeasurementFailure | 'launch_env_drift' | 'launch_env_unexpected_control_name';
/**
 * WHICH of the things an identity binds moved. Carried beside the reason
 * because `reverify_failed` on the artifact, on the interpreter and on a sealed
 * asset send an operator to three different files.
 */
export type ToolImplementationReverifySubject = 'artifact' | 'interpreter' | 'asset' | 'launch-env';
export type ToolImplementationReverifyResult = 'ok' | {
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
export declare function reverifyToolImplementationIdentity(identity: ToolImplementationAttestedV1, launchEnv: Readonly<Record<string, string>>, probe?: ToolImplementationFsProbe): Promise<ToolImplementationReverifyResult>;
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
export declare function assertToolImplementationBeforeSpawn(label: string, identity: ToolImplementationIdentityV1 | undefined, launchEnv: Readonly<Record<string, string>>, probe?: ToolImplementationFsProbe): Promise<void>;
/**
 * Raised when an attested server no longer measures the way it was attested.
 * Carries the reason rather than only a message, so a caller refuses on the
 * fact instead of on a substring.
 */
export declare class ToolImplementationReverifyError extends Error {
    readonly reason: ToolImplementationReverifyFailure;
    readonly subject: ToolImplementationReverifySubject;
    constructor(message: string, reason: ToolImplementationReverifyFailure, subject: ToolImplementationReverifySubject);
}
/** Validates delegated consistency and physical bytes, not concurrency/budget custody. */
export declare function assertDescendantSpawn(launch: unknown, expected: DescendantSpawnExpectationV1, actual: DescendantSpawnActualV1, probe?: ToolImplementationFsProbe): Promise<void>;
export {};
// ==== @byok-sdk/implementation-identity dist/index.d.ts ====
export * from './identity';
export * from './environment';
export type { McpLaunchAttestation, ResolvedMcpLaunchCwdLauncher } from './launch-attestation';
export * from './spawn-binding';
export * from './descendant-launch';
// ==== @byok-sdk/implementation-identity dist/launch-attestation.d.ts ====
export type ResolvedMcpLaunchCwdLauncher = 
/** POSIX: `interpreter` is the realpath of the system shell, `script` is the client-owned shell bootstrap. */
{
    readonly kind: 'shell';
    readonly interpreter: string;
    readonly script: string;
}
/** win32: `interpreter` is a plain-Node executable, `script` is this package's `bin/byok-launch-cwd.mjs`. */
 | {
    readonly kind: 'node';
    readonly interpreter: string;
    readonly script: string;
};
export interface McpLaunchAttestation {
    readonly launchCwd: string;
    readonly launcher: ResolvedMcpLaunchCwdLauncher | null;
}
// ==== @byok-sdk/implementation-identity dist/spawn-binding.d.ts ====
import { type ToolImplementationIdentityV1 } from './identity';
export { KEYS_PI_INHERITED_ENV_NAMES, KEYS_PI_WINDOWS_ENV_NAMES } from './environment';
export declare function projectKeysPiInheritedEnvironment(ambient: Readonly<Record<string, string | undefined>>, platform?: NodeJS.Platform): Record<string, string>;
/** Physical projection of a client-decided launch; contains no runtime selection or credential policy. */
export interface ImplementationSpawnBindingV1 {
    readonly format: 'byok.implementation-spawn';
    readonly version: 1;
    readonly identity: ToolImplementationIdentityV1;
    readonly command: string;
    readonly entry?: string;
    readonly fixedArgv: readonly string[];
    readonly cwd: string;
    readonly envCommitments: Readonly<Record<string, string>>;
}
export declare function parseImplementationSpawnBinding(value: unknown): ImplementationSpawnBindingV1 | undefined;
/** Validate exact physical inputs, then remeasure immediately before the caller's spawn. */
export declare function assertImplementationSpawnBinding(binding: ImplementationSpawnBindingV1, actual: {
    readonly command: string;
    readonly entry?: string;
    readonly fixedArgv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}): Promise<void>;
