import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PreparedSessionInputV2 } from '@earendil-works/pi-coding-agent/prepared-session-input';
import type {
  CodingAgentInputSnapshot,
  HostCanonicalAssistantMessage,
} from '@earendil-works/pi-coding-agent/input-preparation';
import type { PermissionMode } from '@byok-sdk/protocol';
import type {
  InputPreparationCompiledSnapshotV1,
  InputPreparationMessageV1,
  InputPreparationModelV1,
  InputPreparationOptionsV1,
  InputPreparationProjectionV1,
  InputPreparationResidualKeyV1,
  InputPreparationResidualValueClassV1,
  InputPreparationRuntimeIdentityV1,
} from '../../input-preparation';
import type { McpToolsetServerObservation } from '../../mcp/observation';
import type { McpLaunchAttestation } from '../../daemon/trusted-launch-cwd';
import {
  toolImplementationUnavailable,
  type ToolImplementationAttestedV1,
  type ToolImplementationIdentityV1,
} from '../../daemon/tool-implementation-identity';
import { filterMcpObservationForPolicy, projectMcpTools, qualifiedMcpToolName } from '../../mcp/projection';
import { PI_PACKAGE_NAME, resolvePiRuntimeIdentity } from './resolve-bin';

/**
 * The ONE place in this package that imports the native
 * `@earendil-works/pi-coding-agent/prepared-session-input` subpath
 * (`docs/researches/runtime-input-preparation-contract.md` §10.4).
 *
 * It also names `@earendil-works/pi-coding-agent/input-preparation` TYPE-ONLY,
 * for the native message shapes the compile stage projects onto. That import is
 * erased, reaches no module graph at runtime, and is what keeps the projection
 * bound to the fork's own declarations instead of to a local restatement of
 * them — and it goes through the coding-agent re-export rather than
 * `@earendil-works/pi-ai`, so this package takes on no direct dependency of its
 * own on the provider layer.
 *
 * It does two things and nothing else:
 *
 * 1. Verifies the INSTALLED native artifact closure and derives the runtime /
 *    compiler identity from it — the manifest actually on disk, cross-checked
 *    against the exact alias `packages/client/package.json` pins, plus the
 *    fork provenance that manifest records. §10.3.1 forbids deriving this from
 *    caller text or a version label, so nothing on the wire can influence it.
 * 2. Hands already-resolved immutable data to the native pure compile and
 *    returns the envelope's digests, bytes and its structural projection
 *    contract, copied verbatim.
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

/**
 * The ONE prepared-request compiler version this SDK consumes.
 *
 * It is this package's SUPPORTED constant, never a claim about the native: the
 * identity below states it, and every compile proves the envelope the native
 * actually produced carries the same number
 * (`unsupported_compiler_version`, fail closed). A fork that compiles to a
 * different contract is refused rather than read through this one.
 */
export const SUPPORTED_PREPARED_COMPILER_VERSION = 2;

/** The residual value classes the supported compiler contract defines. Copied, never invented. */
const SUPPORTED_RESIDUAL_VALUE_CLASSES: ReadonlySet<string> = new Set<InputPreparationResidualValueClassV1>([
  'constant',
  'boolean',
  'bounded_integer',
  'bounded_number',
  'finite_number',
  'closed_enum',
  'nonempty_string',
  'object_shape',
]);

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
  /** What the native compiler proved about P(D), copied verbatim. */
  readonly projection: InputPreparationProjectionV1;
  /** Every top-level key of D outside P(D), classified by the native compiler. */
  readonly residual: readonly InputPreparationResidualKeyV1[];
  /** The full native envelope, retained verbatim for the durable artifact. */
  readonly envelope: PreparedSessionInputV2;
}

/** Explicit, already-authorized and already-authority-resolved compile input. */
export interface CompilePreparedInputRequest {
  readonly snapshot: InputPreparationCompiledSnapshotV1;
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
  /**
   * A stable code for the refusals that name a specific broken contract, so the
   * durable record says WHICH one rather than only `compile_rejected`. Absent
   * for a refusal the native compiler itself raised: its message is native
   * text and this package invents no code for it.
   */
  readonly detail?: string;

  constructor(message: string, options?: { cause?: unknown; detail?: string }) {
    super(message, options);
    this.name = 'InputPreparationCompileError';
    if (options?.detail !== undefined) this.detail = options.detail;
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
    envelopeFormat: NATIVE_ENVELOPE_FORMAT,
    requestFormat: NATIVE_REQUEST_FORMAT,
    compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
  });
}

/**
 * The two native format tags this module is the authority for. They describe
 * what THIS code knows how to read out of the native envelope, not a fact about
 * the installed release, so they stay SDK constants: a host that could declare
 * them would be telling this SDK what its own parser accepts.
 */
const NATIVE_ENVELOPE_FORMAT = 'pi.session.prepared-input';
const NATIVE_REQUEST_FORMAT = 'pi.openai-completions.prepared';

/**
 * Derive the runtime / compiler identity from an ATTESTED install record
 * instead of from package resolution.
 *
 * This is the encapsulated form's path, and it exists because the unencapsulated
 * one cannot work there. {@link resolveInstalledPiRuntimeIdentity} finds the
 * installed manifest by resolving the package specifier and walking upward —
 * which under a single-artifact release resolves through Bun's user-writable
 * install cache, and which in any form reads a `package.json` that is not part
 * of what was attested. A writable manifest is never an execution-identity
 * authority (§77 ruling 3), so where a host install record exists, the record's
 * own declared fork provenance is the only source.
 *
 * Fails closed, with no fallback to the resolution path: a record that carries
 * no `nativeProvenance`, or one whose package identity is not exactly the pin
 * this build declares, describes a release whose compiler contract is not
 * known. Input preparation counts tokens against that contract, so there is
 * nothing to degrade to.
 *
 * The unencapsulated dev form keeps {@link resolveInstalledPiRuntimeIdentity}:
 * with no authority wired in there is no record to read, and that path is the
 * `resolver_unconfigured` one this SDK ships by default.
 */
export function piRuntimeIdentityFromAttestedRecord(
  identity: ToolImplementationAttestedV1,
): InputPreparationRuntimeIdentityV1 {
  const pinned = resolvePiRuntimeIdentity();
  const provenance = identity.nativeProvenance;
  if (provenance === undefined) {
    throw new InputPreparationRuntimeIdentityError(
      `the attested install record at ${identity.installPath} declares no nativeProvenance; the prepared-session-input seam is fork-only and its provenance must come from the record, never from a package manifest`,
    );
  }
  if (provenance.packageName !== pinned.name || provenance.packageVersion !== pinned.version) {
    throw new InputPreparationRuntimeIdentityError(
      `the attested install record at ${identity.installPath} declares ${provenance.packageName}@${provenance.packageVersion}, but @byok-sdk/client pins ${pinned.name}@${pinned.version}`,
    );
  }
  if (provenance.compilerVersion !== SUPPORTED_PREPARED_COMPILER_VERSION) {
    throw new InputPreparationRuntimeIdentityError(
      `the attested install record at ${identity.installPath} declares compiler version ${String(provenance.compilerVersion)}, but this build of @byok-sdk/client prepares input against version ${String(SUPPORTED_PREPARED_COMPILER_VERSION)}`,
    );
  }
  return Object.freeze({
    packageName: provenance.packageName,
    packageVersion: provenance.packageVersion,
    upstreamBase: provenance.upstreamBase,
    upstreamCommit: provenance.upstreamCommit,
    forkBuild: provenance.forkBuild,
    envelopeFormat: NATIVE_ENVELOPE_FORMAT,
    requestFormat: NATIVE_REQUEST_FORMAT,
    compilerVersion: provenance.compilerVersion,
  });
}

/**
 * Project one supported caller message onto the native message it IS.
 *
 * Exported for the same reason `verifyCompiledPreparedInput` is: the exact
 * native shape this SDK hands the compiler is a boundary, and a boundary
 * crossable only by compiling against one particular installed fork is a
 * boundary nobody can test on the day it matters.
 *
 * Exhaustive by construction: the `default` branch takes the union's residue,
 * and a `never` there means registering a new message kind in
 * `../../input-preparation` without deciding what it compiles to is a COMPILE
 * error rather than a silently dropped or silently downgraded turn.
 *
 * The assistant shape is the fork's own `HostCanonicalAssistantMessage`, whose
 * content is always a text-block array so it serializes through the ordinary
 * assistant path byte-identically to a provenance-carrying assistant text
 * message. No `api`, `provider`, `model`, `usage` or `stopReason` is written:
 * the host asserts the text was already said, nothing generated it here, and
 * inventing provenance to fill the native `AssistantMessage` shape would be a
 * claim about a turn that never happened.
 */
export function projectPreparedInputMessage(message: InputPreparationMessageV1): CodingAgentInputSnapshot['messages'][number] {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content, timestamp: message.timestamp };
    case 'assistant': {
      // Annotated against the PINNED native type, so a fork that changes the
      // host-canonical shape breaks here rather than at the native validator.
      const hostCanonical: HostCanonicalAssistantMessage = {
        role: 'assistant',
        origin: 'host_canonical',
        content: [{ type: 'text', text: message.content }],
        timestamp: message.timestamp,
      };
      return hostCanonical;
    }
    default: {
      const unsupported: never = message;
      return unsupported;
    }
  }
}

/**
 * Build the compiler bound to the installed native closure.
 *
 * The daemon supplies its once-resolved identity; standalone unconfigured
 * package consumers use installed discovery. The identity is fixed on the
 * instance: a compile
 * call must not re-read the filesystem, both because §10.3.2 forbids I/O in the
 * pure portion and because an identity that can change between two compiles is
 * not an identity.
 */
export function createPiInputPreparationCompiler(
  runtime: InputPreparationRuntimeIdentityV1,
): InputPreparationCompiler {
  if (runtime === undefined) throw new InputPreparationRuntimeIdentityError('explicit runtime identity required');
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
      let envelope: PreparedSessionInputV2;
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
            messages: request.snapshot.messages.map(projectPreparedInputMessage),
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
      return verifyCompiledPreparedInput(envelope, runtime);
    },
  };
}

/**
 * Turn one native envelope into this package's compile output, refusing
 * anything that is not the contract the runtime identity promises.
 *
 * Exported because it is the whole fail-closed boundary between the fork and
 * this SDK, and a boundary that can only be exercised through a live native
 * compile is a boundary whose refusals nobody tests. It re-derives NOTHING
 * about token semantics: the projection kind and the residual classification
 * are the compiler's, carried verbatim. The one value it recomputes is the
 * projection digest, over the envelope's own counted-projection bytes, because
 * a digest that only ever travels beside the bytes it describes is not a check.
 */
export function verifyCompiledPreparedInput(
  envelope: PreparedSessionInputV2,
  runtime: InputPreparationRuntimeIdentityV1,
): CompiledPreparedInput {
  // Belt-and-suspenders on the two format tags the artifact claims. The
  // identity was derived from the installed manifest; this proves the code that
  // actually ran produced the envelope shape that identity promises, rather
  // than trusting the manifest alone.
  if (envelope.format !== runtime.envelopeFormat || envelope.providerRequest.format !== runtime.requestFormat) {
    throw new InputPreparationCompileError(
      `the native compiler produced ${envelope.format}/${envelope.providerRequest.format}, not ${runtime.envelopeFormat}/${runtime.requestFormat}`,
      { detail: 'unsupported_envelope_format' },
    );
  }
  // The OBSERVED compiler version, never a literal claim about the native. The
  // identity states what this SDK supports; this proves the envelope in hand
  // was compiled to exactly that contract.
  if (envelope.providerRequest.compilerVersion !== runtime.compilerVersion) {
    throw new InputPreparationCompileError(
      `the native compiler produced prepared-request compiler version ${String(envelope.providerRequest.compilerVersion)},`
      + ` but this build consumes version ${String(runtime.compilerVersion)} only`,
      { detail: 'unsupported_compiler_version' },
    );
  }
  const projection = envelope.providerRequest.projection;
  if (
    projection === null ||
    typeof projection !== 'object' ||
    projection.version !== 2 ||
    (projection.kind !== 'content_complete' && projection.kind !== 'unknown') ||
    typeof projection.digest !== 'string'
  ) {
    throw new InputPreparationCompileError(
      'the native compiler produced a projection outside the supported structural contract',
      { detail: 'unsupported_projection_shape' },
    );
  }
  const recomputed = createHash('sha256').update(envelope.providerRequest.counterProjection, 'utf8').digest('hex');
  if (recomputed !== projection.digest) {
    throw new InputPreparationCompileError(
      'the prepared projection digest does not describe the counted projection bytes it travels with',
      { detail: 'projection_digest_mismatch' },
    );
  }
  const residual: InputPreparationResidualKeyV1[] = [];
  for (const entry of envelope.providerRequest.residual) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.key !== 'string' ||
      entry.key.length === 0 ||
      !SUPPORTED_RESIDUAL_VALUE_CLASSES.has(entry.valueClass)
    ) {
      throw new InputPreparationCompileError(
        'the native compiler classified a residual key with a value class outside the supported contract',
        { detail: 'unsupported_residual_value_class' },
      );
    }
    residual.push({ key: entry.key, valueClass: entry.valueClass });
  }
  return {
    requestBody: envelope.providerRequest.body,
    counterProjection: envelope.providerRequest.counterProjection,
    requestBytes: Buffer.byteLength(envelope.providerRequest.body, 'utf8'),
    projectionBytes: Buffer.byteLength(envelope.providerRequest.counterProjection, 'utf8'),
    requestDigest: envelope.providerRequest.digest,
    envelopeDigest: envelope.digest,
    toolManifestDigest: envelope.toolManifest.digest,
    projection: { version: 2, kind: projection.kind, digest: projection.digest },
    residual,
    envelope,
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
 * What it binds ABOUT the executable is exactly what a host authority attested
 * and this SDK then measured: the {@link ToolImplementationIdentityV1} the
 * daemon resolved for that server, bound whole. Where no authority attested
 * one — which is every server on a daemon constructed without a resolver — the
 * bound value is the named unavailable reason, not a guess. Folding raw
 * `command`/`args` in and calling the result an identity would be worse than
 * leaving the gap open: it would read as an integrity guarantee that nothing
 * verifies.
 *
 * So the gap is carried explicitly rather than papered over, and it travels
 * into the receipt: a preparation whose every tool is `attested` clears
 * `executor_identity_unproven`, and one with any `unavailable` tool does not.
 */

/**
 * The identity a NATIVE tool's fingerprint binds.
 *
 * The TYPE and every rule about it live in
 * `daemon/tool-implementation-identity.ts`, which is the single authority for
 * what an implementation identity is and the only file that can produce an
 * attested one. This file only names the value it hashes.
 *
 * MCP tools no longer use it: the daemon now resolves one real identity per
 * projected server (`daemon/prepared-tool-surface.ts`) and passes it in, so an
 * MCP fingerprint commits to whatever was actually established — attested, or
 * a named unavailable reason. Pi's own native tools have no install record to
 * resolve against and no separate executable to measure: they are code inside
 * the verified runtime closure the `runtimeIdentity` already binds, so the
 * honest value for them is "nobody attested this separately".
 *
 * Both halves changed the day a real proof reached the MCP call site, which is
 * correct: a tool whose implementation is proven is not the same tool as one
 * whose implementation was merely assumed, and nothing frozen under the weaker
 * claim should silently validate under the stronger one.
 */
const NATIVE_TOOL_IMPLEMENTATION_IDENTITY: ToolImplementationIdentityV1 =
  toolImplementationUnavailable('implementation_identity_unattested');

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
  /**
   * What the daemon established about the implementation behind this server
   * (`daemon/tool-implementation-identity.ts`), bound WHOLE rather than as a
   * label: an attested identity carries the install path, the closure digest
   * and the stat tuple that was measured, and a fingerprint that bound only
   * the word "attested" would validate a different install under the same
   * claim. Required, not optional — a caller that could omit it would freeze a
   * manifest whose implementation claim is silently absent.
   */
  readonly implementation: ToolImplementationIdentityV1;
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
    implementationIdentity: input.implementation,
  });
}

export async function nativeToolObservationFingerprint(input: NativeToolFingerprintInput): Promise<string> {
  return canonicalDigest({
    v: 1,
    source: 'pi-native',
    toolName: input.toolName,
    toolSchemaDigest: await canonicalDigest(input.parameters),
    runtimeIdentity: input.runtimeIdentity,
    implementationIdentity: NATIVE_TOOL_IMPLEMENTATION_IDENTITY,
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
  /**
   * `serverName` -> the implementation identity this daemon resolved for it,
   * once, before anything was spawned. Every observed server must appear;
   * a missing one is a compile refusal rather than an assumed absence,
   * because "nobody resolved this" and "the resolver said unavailable" are
   * different facts and only the second one is a fingerprint input.
   */
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
  /** Pi's own tools, already filtered by policy, in the order they are registered. */
  readonly nativeTools: readonly { readonly name: string; readonly parameters: unknown }[];
  readonly runtimeIdentity: string;
}

export interface ToolExecutorsResult {
  /** Keyed by the model-visible tool name, exactly as the native manifest expects. */
  readonly toolExecutors: Readonly<Record<string, string>>;
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
    const implementation = request.implementations[tool.serverName];
    if (implementation === undefined) {
      throw new InputPreparationCompileError(
        `MCP server ${JSON.stringify(tool.serverName)} has no resolved implementation identity;`
        + ' its tools cannot be fingerprinted',
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
      implementation,
    });
  }
  return Object.freeze({ toolExecutors: Object.freeze(toolExecutors) });
}
