import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PreparedSessionInputV1 } from '@earendil-works/pi-coding-agent/prepared-session-input';
import type { PermissionMode } from '@byok-sdk/protocol';
import type {
  InputPreparationModelV1,
  InputPreparationOptionsV1,
  InputPreparationReadinessReasonV1,
  InputPreparationRuntimeIdentityV1,
  InputPreparationSnapshotV1,
} from '../../input-preparation';
import type { McpToolsetServerObservation } from '../../mcp/observation';
import type { McpLaunchAttestation } from '../../daemon/trusted-launch-cwd';
import { filterMcpObservationForPolicy, projectMcpTools, qualifiedMcpToolName } from '../../mcp/projection';
import { PI_PACKAGE_NAME, resolvePiRuntimeIdentity } from './resolve-bin';

/**
 * The ONE place in this package that imports the native
 * `@earendil-works/pi-coding-agent/prepared-session-input` subpath
 * (`docs/researches/runtime-input-preparation-contract.md` §10.4).
 *
 * It does two things and nothing else:
 *
 * 1. Verifies the INSTALLED native artifact closure and derives the runtime /
 *    compiler identity from it — the manifest actually on disk, cross-checked
 *    against the exact alias `packages/client/package.json` pins, plus the
 *    fork provenance that manifest records. §10.3.1 forbids deriving this from
 *    caller text or a version label, so nothing on the wire can influence it.
 * 2. Hands already-resolved immutable data to the native pure compile and
 *    returns the envelope's digests, bytes and coverage.
 *
 * Step 2 is PURE by native contract (§11.2): no home discovery, no settings or
 * resource loading, no session/MCP startup, no tool execution, no credentials,
 * no network. Step 1 reads the installed manifest exactly once per compiler
 * instance, at construction — outside the pure stage — so a compile call
 * performs no filesystem work at all.
 *
 * The native subpath is loaded with a DYNAMIC import, once, on the first
 * compile. Its own module graph reaches the fork's provider layer and the
 * `openai` client, and this module is reachable from the SDK root through the
 * daemon; a static import would therefore evaluate that whole graph for every
 * consumer of `@byok-sdk/client`, including the ones that never prepare input.
 * Identity verification stays at construction, because it reads the installed
 * MANIFEST rather than the module.
 */

type PrepareCodingAgentSessionInput =
  typeof import('@earendil-works/pi-coding-agent/prepared-session-input').prepareCodingAgentSessionInput;

/** Memoized so the native graph is evaluated at most once per process. */
let nativePrepare: Promise<PrepareCodingAgentSessionInput> | undefined;

function loadNativePrepare(): Promise<PrepareCodingAgentSessionInput> {
  nativePrepare ??= import('@earendil-works/pi-coding-agent/prepared-session-input').then(
    (module) => module.prepareCodingAgentSessionInput,
  );
  return nativePrepare;
}

/** The immutable compile output, in this package's own vocabulary. */
export interface CompiledPreparedInput {
  /** The exact low-level provider request body D. */
  readonly requestBody: string;
  /** P(D): the counted projection, in the unchanged native format. */
  readonly counterProjection: string;
  readonly requestBytes: number;
  readonly projectionBytes: number;
  /** Native digest of D. */
  readonly requestDigest: string;
  /** Native digest of the whole envelope. */
  readonly envelopeDigest: string;
  readonly toolManifestDigest: string;
  /** Whatever the native compiler proved. It currently proves `"unknown"`. */
  readonly coverage: string;
  /** The full native envelope, retained verbatim for the durable artifact. */
  readonly envelope: PreparedSessionInputV1;
}

/** Explicit, already-authorized and already-authority-resolved compile input. */
export interface CompilePreparedInputRequest {
  readonly snapshot: InputPreparationSnapshotV1;
  readonly model: InputPreparationModelV1;
  readonly options: InputPreparationOptionsV1;
  readonly binding: {
    readonly inputIdentity: string;
    readonly runtimeIdentity: string;
    readonly policyIdentity: string;
    readonly profileRevision: string;
  };
  readonly toolExecutors: Readonly<Record<string, string>>;
}

/**
 * Raised when the compiler refuses the input. The service maps it to the
 * `unsupported_input` wire code: nothing is filled in, defaulted or downgraded.
 */
export class InputPreparationCompileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InputPreparationCompileError';
  }
}

/** Raised when the installed native closure cannot be verified. */
export class InputPreparationRuntimeIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InputPreparationRuntimeIdentityError';
  }
}

/**
 * The seam `input-preparation-service.ts` depends on. Declared here rather than
 * in the service so the service never names a native type, and so a test can
 * supply a stub compiler without pulling the native package into its module
 * graph.
 */
export interface InputPreparationCompiler {
  readonly runtime: InputPreparationRuntimeIdentityV1;
  compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput>;
}

interface ForkProvenance {
  upstreamBase?: unknown;
  upstreamCommit?: unknown;
  forkBuild?: unknown;
}

interface InstalledPiManifest {
  name?: unknown;
  version?: unknown;
  byokFork?: ForkProvenance;
}

/**
 * Walk up from the native package's resolved main entry to its enclosing
 * package root. Mirrors `resolve-bin.ts`'s own walk for the same reason it
 * exists there: this package is pure ESM with no `require` condition and does
 * not export `./package.json`, so the manifest is only reachable by resolving
 * an exported entry and walking upward.
 */
function findInstalledManifest(startDir: string): { dir: string; manifest: InstalledPiManifest } | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as InstalledPiManifest;
        if (typeof manifest.name === 'string') return { dir, manifest };
      } catch {
        // A malformed manifest is not a reason to keep climbing into an
        // unrelated parent package — fail closed at the caller instead.
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Derive the runtime / compiler identity from the VERIFIED installed artifact
 * closure.
 *
 * Two independent facts must agree before anything is compiled: the exact alias
 * the client manifest pins (`resolvePiRuntimeIdentity()`), and the manifest of
 * the package that actually resolved on disk. A mismatch is a hard failure with
 * no PATH or version-label fallback — an artifact whose compiler identity is
 * not exactly known cannot be counted against, so there is nothing to degrade
 * to.
 *
 * `byokFork` provenance is required, not optional: the prepared-session-input
 * seam only exists in the fork, so an installed package without that record is
 * by definition not the closure this SDK verified.
 */
export function resolveInstalledPiRuntimeIdentity(): InputPreparationRuntimeIdentityV1 {
  const pinned = resolvePiRuntimeIdentity();
  let mainEntry: string;
  try {
    mainEntry = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
  } catch (cause) {
    throw new InputPreparationRuntimeIdentityError(
      `${PI_PACKAGE_NAME} could not be resolved; input preparation cannot derive a runtime identity`,
      { cause },
    );
  }
  const installed = findInstalledManifest(path.dirname(mainEntry));
  if (installed === undefined) {
    throw new InputPreparationRuntimeIdentityError(
      `${PI_PACKAGE_NAME} resolved to ${mainEntry}, which has no readable enclosing package manifest`,
    );
  }
  const { manifest } = installed;
  if (manifest.name !== pinned.name || manifest.version !== pinned.version) {
    throw new InputPreparationRuntimeIdentityError(
      `${PI_PACKAGE_NAME} resolved to ${String(manifest.name)}@${String(manifest.version)}, but @byok-sdk/client pins ${pinned.name}@${pinned.version}`,
    );
  }
  const fork = manifest.byokFork;
  if (
    fork === undefined ||
    typeof fork.upstreamBase !== 'string' ||
    typeof fork.upstreamCommit !== 'string' ||
    !Number.isSafeInteger(fork.forkBuild)
  ) {
    throw new InputPreparationRuntimeIdentityError(
      `${pinned.name}@${pinned.version} carries no byokFork provenance; the prepared-session-input seam is fork-only and its closure must be verifiable`,
    );
  }
  return Object.freeze({
    packageName: pinned.name,
    packageVersion: pinned.version,
    upstreamBase: fork.upstreamBase,
    upstreamCommit: fork.upstreamCommit,
    forkBuild: fork.forkBuild as number,
    envelopeFormat: 'pi.session.prepared-input',
    requestFormat: 'pi.openai-completions.prepared',
    compilerVersion: 1,
  });
}

/**
 * Build the compiler bound to the installed native closure.
 *
 * The identity is resolved ONCE, here, and frozen onto the instance: a compile
 * call must not re-read the filesystem, both because §10.3.2 forbids I/O in the
 * pure portion and because an identity that can change between two compiles is
 * not an identity.
 */
export function createPiInputPreparationCompiler(): InputPreparationCompiler {
  const runtime = resolveInstalledPiRuntimeIdentity();
  return {
    runtime,
    async compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      // Outside the try below on purpose: a native package that cannot be
      // LOADED is a closure fault, not an input this compiler refused.
      let prepare: PrepareCodingAgentSessionInput;
      try {
        prepare = await loadNativePrepare();
      } catch (cause) {
        throw new InputPreparationRuntimeIdentityError(
          `${PI_PACKAGE_NAME}/prepared-session-input could not be loaded; no input can be prepared`,
          { cause },
        );
      }
      let envelope: PreparedSessionInputV1;
      try {
        envelope = await prepare({
          // Structurally the native `CodingAgentInputSnapshot`. The wire cannot
          // carry a typebox `TSchema` brand or a `Tool`'s executable fields, so
          // the already key-exact validated JSON schema crosses here as the
          // model-visible `parameters` it is. This is a pass-through, not a
          // translation: no field is renamed, defaulted or inferred, and the
          // native compiler remains the only authority on what it means.
          snapshot: {
            prompt: {
              ...(request.snapshot.prompt.customPrompt === undefined
                ? {}
                : { customPrompt: request.snapshot.prompt.customPrompt }),
              ...(request.snapshot.prompt.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: request.snapshot.prompt.appendSystemPrompt }),
              cwd: request.snapshot.prompt.cwd,
              selectedTools: [...request.snapshot.prompt.selectedTools],
              toolSnippets: { ...request.snapshot.prompt.toolSnippets },
              promptGuidelines: [...request.snapshot.prompt.promptGuidelines],
              contextFiles: request.snapshot.prompt.contextFiles.map((file) => ({ path: file.path, content: file.content })),
              formattedSkills: request.snapshot.prompt.formattedSkills,
              docsPaths: { ...request.snapshot.prompt.docsPaths },
            },
            messages: request.snapshot.messages.map((message) => ({
              role: 'user' as const,
              content: message.content,
              timestamp: message.timestamp,
            })),
            tools: request.snapshot.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as never,
            })),
          },
          model: {
            id: request.model.id,
            name: request.model.name,
            api: 'openai-completions',
            provider: request.model.provider as never,
            baseUrl: request.model.baseUrl,
            reasoning: request.model.reasoning,
            input: [...request.model.input],
            cost: { ...request.model.cost },
            contextWindow: request.model.contextWindow,
            maxTokens: request.model.maxTokens,
          },
          options: {
            cacheRetention: request.options.cacheRetention,
            maxTokens: request.options.maxTokens,
            ...(request.options.temperature === undefined ? {} : { temperature: request.options.temperature }),
            ...(request.options.toolChoice === undefined ? {} : { toolChoice: request.options.toolChoice }),
            ...(request.options.reasoningEffort === undefined ? {} : { reasoningEffort: request.options.reasoningEffort }),
          },
          binding: { ...request.binding },
          toolExecutors: { ...request.toolExecutors },
        });
      } catch (cause) {
        throw new InputPreparationCompileError(
          `the native compiler refused this input: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      // Belt-and-suspenders on the two format tags the artifact claims. The
      // identity above was derived from the installed manifest; this proves the
      // code that actually ran produced the envelope shape that identity
      // promises, rather than trusting the manifest alone.
      if (envelope.format !== runtime.envelopeFormat || envelope.providerRequest.format !== runtime.requestFormat) {
        throw new InputPreparationCompileError(
          `the native compiler produced ${envelope.format}/${envelope.providerRequest.format}, not ${runtime.envelopeFormat}/${runtime.requestFormat}`,
        );
      }
      return {
        requestBody: envelope.providerRequest.body,
        counterProjection: envelope.providerRequest.counterProjection,
        requestBytes: Buffer.byteLength(envelope.providerRequest.body, 'utf8'),
        projectionBytes: Buffer.byteLength(envelope.providerRequest.counterProjection, 'utf8'),
        requestDigest: envelope.providerRequest.digest,
        envelopeDigest: envelope.digest,
        toolManifestDigest: envelope.toolManifest.digest,
        coverage: envelope.providerRequest.coverage,
        envelope,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool executor observation fingerprints
// ---------------------------------------------------------------------------

/**
 * What the native compiler calls a tool "executor identity" is, on this
 * device, an OBSERVATION FINGERPRINT — and the two must not be confused.
 *
 * The fingerprint binds everything that was actually established about a tool:
 * the toolset definition revision the daemon resolved it from, the server's
 * own `serverInfo`, the negotiated protocol version, the tool name, and a
 * digest of the exact schema the model was shown. Change any of those and the
 * fingerprint changes, which is what makes drift between preparation and
 * launch a hard refusal.
 *
 * What it does NOT bind is which executable will serve the call. The daemon
 * holds a server only as `command`/`args`; observation and launch are two
 * separate spawns, so even hashing the binary in between would be a TOCTOU
 * claim rather than a proof. Folding `command`/`args` into the fingerprint and
 * calling the result an identity would be worse than leaving the gap open —
 * it would read as an integrity guarantee that nothing verifies. So the gap is
 * carried explicitly instead, as {@link ToolImplementationIdentityV1}, and it
 * travels into the receipt as a readiness reason that no preparation can clear
 * (`executor_identity_unproven`).
 */

/**
 * Proof of which implementation backs a tool. There is exactly one value
 * today, and it is the absence of proof.
 *
 * A typed marker rather than an omitted field on purpose: it is part of what
 * every fingerprint hashes, so the day a real proof exists, every previously
 * issued fingerprint changes — which is correct. A tool whose implementation
 * is proven is not the same tool as one whose implementation was merely
 * assumed, and nothing frozen under the weaker claim should silently validate
 * under the stronger one.
 */
export type ToolImplementationIdentityV1 = {
  readonly kind: 'unavailable';
  readonly reason: 'implementation_identity_unattested';
};

export const TOOL_IMPLEMENTATION_IDENTITY_UNAVAILABLE: ToolImplementationIdentityV1 = Object.freeze({
  kind: 'unavailable',
  reason: 'implementation_identity_unattested',
});

type CanonicalPreparedValue =
  typeof import('@earendil-works/pi-coding-agent/prepared-session-input').canonicalPreparedValue;

/** Memoized for the same reason the compiler is: the native graph is evaluated at most once. */
let nativeCanonical: Promise<CanonicalPreparedValue> | undefined;

function loadCanonicalPreparedValue(): Promise<CanonicalPreparedValue> {
  nativeCanonical ??= import('@earendil-works/pi-coding-agent/prepared-session-input').then(
    (module) => module.canonicalPreparedValue,
  );
  return nativeCanonical;
}

/**
 * Digest one value with the NATIVE canonical form.
 *
 * `canonicalPreparedValue` is the one canonicalization authority in this
 * package. The native compiler hashes the tool manifest with it, so a
 * fingerprint computed with a locally written key-sorted serializer could
 * agree with it today and diverge on the first value where the two definitions
 * differ.
 */
async function canonicalDigest(value: unknown): Promise<string> {
  const canonical = await loadCanonicalPreparedValue();
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

/** Everything one MCP tool's fingerprint binds. */
export interface McpToolFingerprintInput {
  readonly toolsetId: string;
  /** `toolset-registry.ts`'s digest of the toolset's canonical server list. */
  readonly toolsetDefinitionRevision: string;
  readonly serverName: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersion: string;
  readonly toolName: string;
  /** The server's own schema; digested, not embedded. */
  readonly inputSchema: unknown;
  /** The resolved native runtime identity string the binding already uses. */
  readonly runtimeIdentity: string;
  /**
   * WHERE this tool's server is launched, and through what.
   *
   * Carried beside the toolset's `definitionRevision` rather than inside it
   * (`daemon/toolset-registry.ts`): that digest is the operator's configured
   * intent — the `command`/`args` they wrote and the classification they
   * declared — and an SDK launcher upgrade is not a change to their
   * configuration. Both are still bound here, so a launch directory or a
   * launcher that changed between preparation and launch is drift and the
   * frozen manifest is refused, without churning the operator's revision on
   * every SDK release.
   */
  readonly launch: McpLaunchAttestation;
}

/** Everything one Pi-native tool's fingerprint binds. */
export interface NativeToolFingerprintInput {
  readonly toolName: string;
  /** The tool's model-visible schema; digested, not embedded. */
  readonly parameters: unknown;
  readonly runtimeIdentity: string;
}

export async function mcpToolObservationFingerprint(input: McpToolFingerprintInput): Promise<string> {
  return canonicalDigest({
    v: 1,
    source: 'mcp',
    toolsetId: input.toolsetId,
    toolsetDefinitionRevision: input.toolsetDefinitionRevision,
    serverName: input.serverName,
    serverInfo: { name: input.serverInfo.name, version: input.serverInfo.version },
    protocolVersion: input.protocolVersion,
    toolName: input.toolName,
    toolSchemaDigest: await canonicalDigest(input.inputSchema),
    runtimeIdentity: input.runtimeIdentity,
    launch: { launchCwd: input.launch.launchCwd, launcher: input.launch.launcher },
    implementationIdentity: TOOL_IMPLEMENTATION_IDENTITY_UNAVAILABLE,
  });
}

export async function nativeToolObservationFingerprint(input: NativeToolFingerprintInput): Promise<string> {
  return canonicalDigest({
    v: 1,
    source: 'pi-native',
    toolName: input.toolName,
    toolSchemaDigest: await canonicalDigest(input.parameters),
    runtimeIdentity: input.runtimeIdentity,
    implementationIdentity: TOOL_IMPLEMENTATION_IDENTITY_UNAVAILABLE,
  });
}

export interface ToolExecutorsRequest {
  /** The daemon's frozen observation, keyed by projected server name. Unfiltered: the policy is applied here. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /**
   * The task's permission mode. Required, and applied to the observation
   * before anything is fingerprinted, so a frozen manifest cannot bind an
   * executor for a tool the prepared session would never register. A caller
   * that had to remember to filter first is a caller that eventually forgets,
   * and the failure would be a manifest quietly wider than the session.
   */
  readonly permissionMode: PermissionMode;
  /** `toolsetId` -> the registry's definition revision for it. Every observed toolset must appear. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /**
   * The launch boundary this task's MCP servers were observed under and will
   * run under — `daemon/trusted-launch-cwd.ts`'s
   * {@link McpLaunchAttestation}. Required, not optional: a manifest frozen
   * without it would validate a launch in any directory, which is the exact
   * fact it exists to pin.
   */
  readonly launch: McpLaunchAttestation;
  /** Pi's own tools, already filtered by policy, in the order they are registered. */
  readonly nativeTools: readonly { readonly name: string; readonly parameters: unknown }[];
  readonly runtimeIdentity: string;
}

export interface ToolExecutorsResult {
  /** Keyed by the model-visible tool name, exactly as the native manifest expects. */
  readonly toolExecutors: Readonly<Record<string, string>>;
  /**
   * Always contains `executor_identity_unproven`. Surfaced rather than
   * asserted, so the caller carries the limitation into the receipt instead of
   * a reader having to know it.
   */
  readonly readinessReasons: readonly InputPreparationReadinessReasonV1[];
}

/**
 * Build the `toolExecutors` map a prepared input is compiled with, from one
 * observation.
 *
 * Pure: it reads no server, spawns nothing, and touches no filesystem beyond
 * the memoized native module the digest function needs. Native tools come
 * first, in the order the caller registers them, then the MCP tools in the
 * core's canonical `(toolsetId, serverName, toolName)` order — the same
 * sequence the ordinary extension registers and the model is shown.
 */
export async function buildToolExecutorsFromObservation(
  request: ToolExecutorsRequest,
): Promise<ToolExecutorsResult> {
  const toolExecutors: Record<string, string> = {};
  for (const tool of request.nativeTools) {
    toolExecutors[tool.name] = await nativeToolObservationFingerprint({
      toolName: tool.name,
      parameters: tool.parameters,
      runtimeIdentity: request.runtimeIdentity,
    });
  }
  // Same filter, same core, same answer as the ordinary extension's
  // registration and as every adapter's grant: the manifest is frozen over
  // exactly the tools a prepared session will register.
  const allowed = filterMcpObservationForPolicy(request.observation, request.permissionMode);
  if (!allowed.ok) throw new InputPreparationCompileError(allowed.reason);
  for (const tool of projectMcpTools(allowed.observation)) {
    const server = allowed.observation[tool.serverName]!;
    const toolsetDefinitionRevision = request.toolsetDefinitionRevisions[tool.toolsetId];
    if (toolsetDefinitionRevision === undefined) {
      throw new InputPreparationCompileError(
        `toolset ${JSON.stringify(tool.toolsetId)} has no definition revision; its tools cannot be fingerprinted`,
      );
    }
    toolExecutors[qualifiedMcpToolName(tool.serverName, tool.toolName)] = await mcpToolObservationFingerprint({
      toolsetId: tool.toolsetId,
      toolsetDefinitionRevision,
      serverName: tool.serverName,
      serverInfo: server.serverInfo,
      protocolVersion: server.protocolVersion,
      toolName: tool.toolName,
      inputSchema: tool.inputSchema,
      runtimeIdentity: request.runtimeIdentity,
      launch: request.launch,
    });
  }
  return Object.freeze({
    toolExecutors: Object.freeze(toolExecutors),
    readinessReasons: Object.freeze(['executor_identity_unproven' as const]),
  });
}
