import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from '@byok-sdk/protocol';
import type {
  InputPreparationCompiledPromptSnapshotV1,
  InputPreparationCompiledSnapshotV1,
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
import { PI_PACKAGE_NAME, resolvePiRuntimeIdentity, type PiRuntimeIdentity } from './resolve-bin';
import {
  buildPreparedTranscriptMessages,
  canonicalPreparedDigest,
  canonicalPreparedValue,
  compilePreparedProviderRequest,
  derivePreparedProjection,
  loadOfficialCompiler,
  PREPARED_PROVIDER_SESSION_ID,
  PreparedRequestError,
  PreparedSessionError,
  projectPreparedModel,
  sha256Hex,
  type PreparedRequestOptionsV1,
  type PreparedTranscriptV1,
} from './prepared-request';

/**
 * The prepared-input compiler bound to the verified official Pi closure.
 *
 * It does three things:
 *
 * 1. Verifies the INSTALLED runtime closure and derives the runtime / compiler
 *    identity from it — the manifest actually on disk, cross-checked against
 *    the exact version `packages/client/package.json` pins — outside the
 *    compile, once per compiler instance.
 * 2. Compiles D through A1' (`./prepared-request.ts`): the Host transcript T
 *    and the projected model go through the official `streamSimple`, and the
 *    final body string is captured by an injected fetch that never sends.
 * 3. Wraps D, P(D), the residual classification, T and the tool manifest into
 *    one SDK-owned envelope with independent digests, and re-verifies that
 *    envelope on the consume side ({@link verifyPreparedPiInput}).
 *
 * The compile is PURE in the sense that matters: no home discovery, no
 * settings or resource loading, no session, no tool execution, no credential,
 * no network. The official provider module is loaded with a dynamic import on
 * first use, because this module is reachable from the SDK root through the
 * daemon.
 */

/**
 * The ONE prepared-request compiler version this SDK produces and consumes.
 *
 * 4 is the first SDK-owned compiler (A1' on official Pi 0.87.1). Version 3
 * artifacts were compiled by the retired fork and are not read forward.
 */
export const SUPPORTED_PREPARED_COMPILER_VERSION = 4;

/** The SDK-owned envelope and request format tags this module is the authority for. */
export const PREPARED_ENVELOPE_FORMAT = 'byok.pi.prepared-input' as const;
export const PREPARED_REQUEST_FORMAT = 'byok.pi.openai-completions.request' as const;
const PREPARED_ENVELOPE_VERSION = 1 as const;

/** The residual value classes the supported compiler contract defines. */
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

/** The compile binding the record's request was compiled under. */
export interface PreparedPiBindingV1 {
  readonly inputIdentity: string;
  readonly runtimeIdentity: string;
  readonly policyIdentity: string;
  readonly profileRevision: string;
}

/** Model-visible tool order bound to executor identity. */
export interface PreparedPiToolManifestV1 {
  readonly order: readonly string[];
  readonly executors: readonly string[];
  /** SHA-256 over the canonical `{ order, executors }`. */
  readonly digest: string;
}

/** D and everything the compile proved about it. `digest` binds every other field. */
export interface PreparedPiProviderRequestV1 {
  readonly format: typeof PREPARED_REQUEST_FORMAT;
  readonly compilerVersion: number;
  readonly model: InputPreparationModelV1;
  readonly binding: PreparedPiBindingV1;
  readonly options: PreparedRequestOptionsV1;
  /** The URL the official client addressed for D; the live gate compares it. */
  readonly endpoint: string;
  /** Exact JSON request body D. */
  readonly body: string;
  /** P(D): `model`, `messages` and `tools` of D. Not a token count. */
  readonly counterProjection: string;
  readonly projection: InputPreparationProjectionV1;
  readonly residual: readonly InputPreparationResidualKeyV1[];
  readonly digest: string;
}

/**
 * The SDK-owned prepared-input envelope. `digest` binds every other field.
 *
 * `transcript` is the Host-owned content in the SDK's own vocabulary. It never
 * carries the A2' sentinel provenance: that exists only inside
 * `buildPreparedTranscriptMessages`' return value.
 */
export interface PreparedPiInputV1 {
  readonly format: typeof PREPARED_ENVELOPE_FORMAT;
  readonly version: typeof PREPARED_ENVELOPE_VERSION;
  readonly transcript: PreparedTranscriptV1;
  readonly providerRequest: PreparedPiProviderRequestV1;
  readonly toolManifest: PreparedPiToolManifestV1;
  readonly digest: string;
}

/** Independently trusted expectations, from the durable record, never from the envelope. */
export interface PreparedPiExpectedV1 {
  readonly digest: string;
  readonly model: InputPreparationModelV1;
  readonly binding: PreparedPiBindingV1;
  readonly toolManifestDigest: string;
}

/** The immutable compile output, in this package's own vocabulary. */
export interface CompiledPreparedInput {
  /** The exact low-level provider request body D. */
  readonly requestBody: string;
  /** P(D): the counted projection. */
  readonly counterProjection: string;
  readonly requestBytes: number;
  readonly projectionBytes: number;
  /** Digest of the provider request record (D plus what was proved about it). */
  readonly requestDigest: string;
  /** Digest of the whole envelope. */
  readonly envelopeDigest: string;
  readonly toolManifestDigest: string;
  readonly projection: InputPreparationProjectionV1;
  /** Every top-level key of D outside P(D), classified. */
  readonly residual: readonly InputPreparationResidualKeyV1[];
  /** The whole envelope, retained verbatim for the durable artifact. */
  readonly envelope: PreparedPiInputV1;
}

/** Explicit, already-authorized and already-authority-resolved compile input. */
export interface CompilePreparedInputRequest {
  readonly snapshot: InputPreparationCompiledSnapshotV1;
  readonly model: InputPreparationModelV1;
  readonly options: InputPreparationOptionsV1;
  readonly binding: PreparedPiBindingV1;
  readonly toolExecutors: Readonly<Record<string, string>>;
}

/**
 * Raised when the compiler refuses the input. The service maps it to the
 * `unsupported_input` wire code: nothing is filled in, defaulted or downgraded.
 */
export class InputPreparationCompileError extends Error {
  /** A stable code naming the broken contract, so the durable record says WHICH one. */
  readonly detail?: string;

  constructor(message: string, options?: { cause?: unknown; detail?: string }) {
    super(message, options);
    this.name = 'InputPreparationCompileError';
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

/** Raised when the installed runtime closure cannot be verified or loaded. */
export class InputPreparationRuntimeIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InputPreparationRuntimeIdentityError';
  }
}

/**
 * The seam `input-preparation-service.ts` depends on. A test can supply a stub
 * compiler without pulling the official provider graph into its module graph.
 */
export interface InputPreparationCompiler {
  readonly runtime: InputPreparationRuntimeIdentityV1;
  compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput>;
}

// ---------------------------------------------------------------------------
// Runtime identity
// ---------------------------------------------------------------------------

interface InstalledPiManifest {
  name?: unknown;
  version?: unknown;
}

/**
 * The one official runtime tuple this build admits: the coding agent and the
 * two lockstep packages the prepared lane compiles and runs against, each at
 * exactly one version, with the upstream tag and commit that version was
 * published from (npm registry `gitHead`, recorded in the WP0 breakage map).
 * Artifact integrity (`sha512` per `name@version`) is not observable from an
 * installed package directory; the release identity gate
 * (`scripts/release/pi-runtime-identity.mjs`) proves it against `bun.lock`.
 */
const OFFICIAL_PI_RUNTIME = Object.freeze({
  name: '@earendil-works/pi-coding-agent',
  version: '0.87.1',
  lockstep: Object.freeze(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'] as const),
  upstreamBase: 'v0.87.1',
  upstreamCommit: 'f07218c4d4bbc12bef056a7058c3dd49dfe41abe',
});

/** One observed installed manifest, as read off disk or from a measured record. */
export interface InstalledPiPackage {
  readonly name?: unknown;
  readonly version?: unknown;
}

/**
 * The official-runtime identity seam. Every observed package must belong to
 * the official tuple at exactly its version, the coding agent must be observed
 * exactly once, and the client pin must name that same tuple. The caller
 * supplies every manifest it can observe: package resolution observes the
 * coding agent and both lockstep packages; an attested install record observes
 * its digest-verified coding-agent manifest, and the record's own measurement
 * covers the rest. Anything else is `runtime_identity_unavailable`.
 */
export function assertOfficialRuntimeIdentity(
  installed: readonly InstalledPiPackage[],
  pinned: PiRuntimeIdentity,
): { readonly upstreamBase: string; readonly upstreamCommit: string; readonly forkBuild: number } {
  const tuple = `${OFFICIAL_PI_RUNTIME.name}@${OFFICIAL_PI_RUNTIME.version}`;
  if (pinned.name !== OFFICIAL_PI_RUNTIME.name || pinned.version !== OFFICIAL_PI_RUNTIME.version) {
    throw new InputPreparationRuntimeIdentityError(
      `@byok-sdk/client pins ${pinned.name}@${pinned.version}, but this build prepares input only against ${tuple}`,
    );
  }
  const admitted: readonly string[] = [OFFICIAL_PI_RUNTIME.name, ...OFFICIAL_PI_RUNTIME.lockstep];
  for (const manifest of installed) {
    if (typeof manifest.name !== 'string' || !admitted.includes(manifest.name) || manifest.version !== OFFICIAL_PI_RUNTIME.version) {
      throw new InputPreparationRuntimeIdentityError(
        `${PI_PACKAGE_NAME} runtime closure resolved ${String(manifest.name)}@${String(manifest.version)}, but this build admits only ${admitted.map(name => `${name}@${OFFICIAL_PI_RUNTIME.version}`).join(', ')}`,
      );
    }
  }
  const agents = installed.filter(manifest => manifest.name === OFFICIAL_PI_RUNTIME.name).length;
  if (agents !== 1) {
    throw new InputPreparationRuntimeIdentityError(
      `${PI_PACKAGE_NAME} runtime closure must observe exactly one ${tuple}, observed ${agents}`,
    );
  }
  return {
    upstreamBase: OFFICIAL_PI_RUNTIME.upstreamBase,
    upstreamCommit: OFFICIAL_PI_RUNTIME.upstreamCommit,
    // The official artifact is not a fork build.
    forkBuild: 0,
  };
}

/**
 * Resolve one lockstep package the way this module loads it and read its
 * manifest. Fails closed: an unresolvable or manifest-less package is not an
 * observed identity.
 */
function resolveLockstepManifest(name: string): InstalledPiManifest {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(name));
  } catch (cause) {
    throw new InputPreparationRuntimeIdentityError(`${name} could not be resolved; input preparation cannot derive a runtime identity`, { cause });
  }
  const found = findInstalledManifest(path.dirname(entry));
  if (found === undefined) {
    throw new InputPreparationRuntimeIdentityError(`${name} resolved to ${entry}, which has no readable enclosing package manifest`);
  }
  return found.manifest;
}

/**
 * Walk up from the runtime package's resolved main entry to its enclosing
 * package root: the package is pure ESM and does not export `./package.json`.
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
 * Derive the runtime / compiler identity from the VERIFIED installed package.
 * No PATH or version-label fallback: an artifact whose identity is not exactly
 * known cannot be counted against.
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
  const provenance = assertOfficialRuntimeIdentity(
    [installed.manifest, ...OFFICIAL_PI_RUNTIME.lockstep.map(resolveLockstepManifest)],
    pinned,
  );
  return Object.freeze({
    packageName: pinned.name,
    packageVersion: pinned.version,
    ...provenance,
    envelopeFormat: PREPARED_ENVELOPE_FORMAT,
    requestFormat: PREPARED_REQUEST_FORMAT,
    compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
  });
}

/**
 * Derive the runtime / compiler identity from an ATTESTED install record
 * instead of from package resolution. A writable manifest is never an
 * execution-identity authority, so where a host install record exists, the
 * record's own declared provenance is the only source. Fails closed.
 */
export function piRuntimeIdentityFromAttestedRecord(
  identity: Pick<ToolImplementationAttestedV1, 'installPath' | 'nativeProvenance'>,
): InputPreparationRuntimeIdentityV1 {
  const pinned = resolvePiRuntimeIdentity();
  const provenance = identity.nativeProvenance;
  if (provenance === undefined) {
    throw new InputPreparationRuntimeIdentityError(
      `the attested install record at ${identity.installPath} declares no nativeProvenance; the runtime provenance must come from the record, never from a package manifest`,
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
    envelopeFormat: PREPARED_ENVELOPE_FORMAT,
    requestFormat: PREPARED_REQUEST_FORMAT,
    compilerVersion: provenance.compilerVersion,
  });
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * The Host-authored system message, read off the current wire prompt snapshot.
 *
 * The Host owns the WHOLE system message (no Pi prompt builder is called), so
 * the only field that can carry it is `customPrompt`. Every other prompt field
 * is an input to Pi's own renderer; a non-empty one is refused rather than
 * rendered locally. `cwd` and `docsPaths` are renderer inputs too and reach
 * nothing.
 */
export function hostSystemPromptFromSnapshot(prompt: InputPreparationCompiledPromptSnapshotV1): string {
  const refuse = (message: string): never => {
    throw new InputPreparationCompileError(message, { detail: 'prompt_render_input_unsupported' });
  };
  if (typeof prompt.customPrompt !== 'string' || prompt.customPrompt.length === 0) {
    refuse('the Host must author the whole system message as prompt.customPrompt; the official runtime renders no default prompt here');
  }
  if (prompt.appendSystemPrompt !== undefined) refuse('prompt.appendSystemPrompt has no renderer; fold it into prompt.customPrompt');
  if (Object.keys(prompt.toolSnippets).length > 0) refuse('prompt.toolSnippets has no renderer on the prepared lane');
  if (Object.keys(prompt.toolGuidelines).length > 0) refuse('prompt.toolGuidelines has no renderer on the prepared lane');
  if (prompt.promptGuidelines.length > 0) refuse('prompt.promptGuidelines has no renderer on the prepared lane');
  if (prompt.contextFiles.length > 0) refuse('prompt.contextFiles has no renderer on the prepared lane');
  if (prompt.skills.length > 0) refuse('prompt.skills has no renderer on the prepared lane');
  return prompt.customPrompt as string;
}

function validatePreparedModel(model: InputPreparationModelV1): void {
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    throw new InputPreparationCompileError('the model endpoint is not a URL', { detail: 'model_endpoint_invalid' });
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['https:', 'http:'].includes(endpoint.protocol)) {
    throw new InputPreparationCompileError(
      'the model endpoint must be http(s) without credentials, query or fragment',
      { detail: 'model_endpoint_invalid' },
    );
  }
}

function toolManifestFor(
  transcript: PreparedTranscriptV1,
  toolExecutors: Readonly<Record<string, string>>,
): PreparedPiToolManifestV1 {
  const order = transcript.tools.map((tool) => tool.name);
  const declared = Object.keys(toolExecutors);
  if (declared.length !== order.length || declared.some((name) => !order.includes(name))) {
    throw new InputPreparationCompileError('tool executor identities must cover exactly the model-visible tools',
      { detail: 'tool_manifest_mismatch' });
  }
  const executors = order.map((name) => {
    const identity = toolExecutors[name];
    if (typeof identity !== 'string' || identity.trim().length === 0) {
      throw new InputPreparationCompileError(`tool ${JSON.stringify(name)} has no executor identity`,
        { detail: 'tool_manifest_mismatch' });
    }
    return identity;
  });
  return { order, executors, digest: canonicalPreparedDigest({ order, executors }) };
}

function asCompileError(cause: unknown): InputPreparationCompileError {
  if (cause instanceof InputPreparationCompileError) return cause;
  if (cause instanceof PreparedRequestError) {
    return new InputPreparationCompileError(cause.message, { cause, detail: cause.code });
  }
  return new InputPreparationCompileError(
    `the prepared request compiler refused this input: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build the compiler bound to one runtime identity. The identity is fixed on
 * the instance; a compile call performs no filesystem work.
 */
export function createPiInputPreparationCompiler(
  runtime: InputPreparationRuntimeIdentityV1,
): InputPreparationCompiler {
  if (runtime === undefined) throw new InputPreparationRuntimeIdentityError('explicit runtime identity required');
  return {
    runtime,
    async compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      // Outside the refusal path on purpose: an official module that cannot be
      // LOADED is a closure fault, not an input this compiler refused.
      try {
        await loadOfficialCompiler();
      } catch (cause) {
        throw new InputPreparationRuntimeIdentityError(
          '@earendil-works/pi-ai/api/openai-completions could not be loaded; no input can be prepared',
          { cause },
        );
      }
      let envelope: PreparedPiInputV1;
      try {
        envelope = await compilePreparedPiInput(request);
      } catch (cause) {
        throw asCompileError(cause);
      }
      return verifyCompiledPreparedInput(envelope, runtime);
    },
  };
}

/** Compile one request into the SDK-owned envelope. Exported for the purity probe and tests. */
export async function compilePreparedPiInput(request: CompilePreparedInputRequest): Promise<PreparedPiInputV1> {
  const snapshot = jsonClone(request.snapshot);
  const systemPrompt = hostSystemPromptFromSnapshot(snapshot.prompt);
  const selected = snapshot.prompt.selectedTools;
  const names = snapshot.tools.map((tool) => tool.name);
  if (selected.length !== names.length || selected.some((name, index) => names[index] !== name)) {
    throw new InputPreparationCompileError('selected tools and tool schemas must match exactly, in order',
      { detail: 'tool_manifest_mismatch' });
  }
  const model = jsonClone(request.model);
  validatePreparedModel(model);
  const transcript: PreparedTranscriptV1 = { systemPrompt, tools: snapshot.tools, messages: snapshot.messages };
  const options: PreparedRequestOptionsV1 = { ...jsonClone(request.options), sessionId: PREPARED_PROVIDER_SESSION_ID };
  const binding: PreparedPiBindingV1 = { ...request.binding };
  const toolManifest = toolManifestFor(transcript, request.toolExecutors);
  const captured = await compilePreparedProviderRequest({
    model: projectPreparedModel(model),
    messages: buildPreparedTranscriptMessages(transcript),
    options,
  });
  const derived = derivePreparedProjection(captured.body);
  const requestData = {
    format: PREPARED_REQUEST_FORMAT as typeof PREPARED_REQUEST_FORMAT,
    compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
    model,
    binding,
    options,
    endpoint: captured.endpoint,
    body: captured.body,
    counterProjection: derived.counterProjection,
    projection: { version: 3 as const, kind: derived.kind, digest: sha256Hex(derived.counterProjection) },
    residual: derived.residual,
  };
  const providerRequest: PreparedPiProviderRequestV1 = { ...requestData, digest: canonicalPreparedDigest(requestData) };
  const data = {
    format: PREPARED_ENVELOPE_FORMAT,
    version: PREPARED_ENVELOPE_VERSION,
    transcript,
    providerRequest,
    toolManifest,
  } as const;
  return deepFreeze({ ...data, digest: canonicalPreparedDigest(data) });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Turn one envelope into this package's compile output, refusing anything that
 * is not the contract the runtime identity promises. Re-derives nothing about
 * token semantics; recomputes the projection digest over its own bytes.
 */
export function verifyCompiledPreparedInput(
  envelope: PreparedPiInputV1,
  runtime: InputPreparationRuntimeIdentityV1,
): CompiledPreparedInput {
  if (envelope.format !== runtime.envelopeFormat || envelope.providerRequest.format !== runtime.requestFormat) {
    throw new InputPreparationCompileError(
      `the compiler produced ${envelope.format}/${envelope.providerRequest.format}, not ${runtime.envelopeFormat}/${runtime.requestFormat}`,
      { detail: 'unsupported_envelope_format' },
    );
  }
  if (envelope.providerRequest.compilerVersion !== runtime.compilerVersion) {
    throw new InputPreparationCompileError(
      `the compiler produced prepared-request compiler version ${String(envelope.providerRequest.compilerVersion)},`
      + ` but this build consumes version ${String(runtime.compilerVersion)} only`,
      { detail: 'unsupported_compiler_version' },
    );
  }
  const projection = envelope.providerRequest.projection;
  if (
    projection === null ||
    typeof projection !== 'object' ||
    projection.version !== 3 ||
    (projection.kind !== 'content_complete' && projection.kind !== 'unknown') ||
    typeof projection.digest !== 'string'
  ) {
    throw new InputPreparationCompileError(
      'the compiler produced a projection outside the supported structural contract',
      { detail: 'unsupported_projection_shape' },
    );
  }
  if (sha256Hex(envelope.providerRequest.counterProjection) !== projection.digest) {
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
        'the compiler classified a residual key with a value class outside the supported contract',
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
    projection: { version: 3, kind: projection.kind, digest: projection.digest },
    residual,
    envelope,
  };
}

// ---------------------------------------------------------------------------
// Consume-side verification
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = ['format', 'version', 'transcript', 'providerRequest', 'toolManifest', 'digest'];
const REQUEST_KEYS = [
  'format', 'compilerVersion', 'model', 'binding', 'options', 'endpoint', 'body',
  'counterProjection', 'projection', 'residual', 'digest',
];
const EXPECTED_KEYS = ['digest', 'model', 'binding', 'toolManifestDigest'];
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message: string): never {
  throw new PreparedSessionError('prepared_input_invalid', `Invalid prepared input: ${message}`);
}

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid(`${what} has unsupported or missing fields`);
  }
  return record;
}

/**
 * Re-verify an envelope against independently supplied expectations, and
 * re-derive D from its own transcript with the official serializer.
 *
 * Returns a frozen private copy. Every check is a comparison: no replacement
 * D is ever built. The live byte gate remains the final enforcement point.
 */
export async function verifyPreparedPiInput(input: unknown, expectedInput: unknown): Promise<PreparedPiInputV1> {
  const envelope = exactKeys(jsonClone(input), ENVELOPE_KEYS, 'envelope') as unknown as PreparedPiInputV1;
  const expected = exactKeys(jsonClone(expectedInput), EXPECTED_KEYS, 'expectation') as unknown as PreparedPiExpectedV1;
  if (envelope.format !== PREPARED_ENVELOPE_FORMAT || envelope.version !== PREPARED_ENVELOPE_VERSION) {
    invalid('unsupported envelope format or version');
  }
  const request = exactKeys(envelope.providerRequest, REQUEST_KEYS, 'providerRequest') as unknown as PreparedPiProviderRequestV1;
  if (request.format !== PREPARED_REQUEST_FORMAT || request.compilerVersion !== SUPPORTED_PREPARED_COMPILER_VERSION
    || request.projection?.version !== 3) {
    invalid('unsupported provider request format or compiler version');
  }
  for (const digest of [envelope.digest, envelope.toolManifest?.digest, request.digest, expected.digest, expected.toolManifestDigest]) {
    if (typeof digest !== 'string' || !SHA256.test(digest)) invalid('malformed digest');
  }

  const { digest: requestDigest, ...requestData } = request;
  if (canonicalPreparedDigest(requestData) !== requestDigest) {
    throw new PreparedSessionError('prepared_digest_mismatch', 'Prepared provider request digest mismatch');
  }
  const manifest = exactKeys(envelope.toolManifest, ['order', 'executors', 'digest'], 'toolManifest');
  if (canonicalPreparedDigest({ order: manifest.order, executors: manifest.executors }) !== manifest.digest) {
    throw new PreparedSessionError('prepared_digest_mismatch', 'Prepared tool manifest digest mismatch');
  }
  const { digest, ...data } = envelope;
  if (canonicalPreparedDigest(data) !== digest) {
    throw new PreparedSessionError('prepared_digest_mismatch', 'Prepared envelope digest mismatch');
  }
  if (digest !== expected.digest) {
    throw new PreparedSessionError('prepared_expectation_mismatch', 'Prepared envelope digest is not the expected one');
  }
  if (manifest.digest !== expected.toolManifestDigest) {
    throw new PreparedSessionError('prepared_expectation_mismatch', 'Prepared tool manifest digest is not the expected one');
  }
  if (canonicalPreparedValue(request.model) !== canonicalPreparedValue(expected.model)) {
    throw new PreparedSessionError('prepared_expectation_mismatch', 'Prepared model is not the expected model');
  }
  if (canonicalPreparedValue(request.binding) !== canonicalPreparedValue(expected.binding)) {
    throw new PreparedSessionError('prepared_expectation_mismatch', 'Prepared binding is not the expected binding');
  }
  const order = envelope.transcript.tools.map((tool) => tool.name);
  if (canonicalPreparedValue(order) !== canonicalPreparedValue(manifest.order)) {
    throw new PreparedSessionError('prepared_context_drift', 'Prepared tool manifest order is not the transcript tool order');
  }

  // The transcript is the only authoring source: recompiling it with the same
  // model and options must reproduce D and its endpoint exactly.
  let recompiled;
  try {
    recompiled = await compilePreparedProviderRequest({
      model: projectPreparedModel(request.model),
      messages: buildPreparedTranscriptMessages(envelope.transcript),
      options: request.options,
    });
  } catch (cause) {
    throw new PreparedSessionError('prepared_context_drift',
      `Prepared transcript no longer compiles: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (recompiled.body !== request.body || recompiled.endpoint !== request.endpoint) {
    throw new PreparedSessionError('prepared_context_drift', 'Prepared transcript does not compile to the prepared body');
  }
  const derived = derivePreparedProjection(request.body);
  if (derived.counterProjection !== request.counterProjection || derived.kind !== request.projection.kind
    || canonicalPreparedValue(derived.residual) !== canonicalPreparedValue(request.residual)
    || sha256Hex(derived.counterProjection) !== request.projection.digest) {
    throw new PreparedSessionError('prepared_context_drift', 'Prepared projection does not describe the prepared body');
  }
  return deepFreeze(envelope);
}

/**
 * Whether the frozen provider request D carries text content parts only.
 *
 * The first bounded-admission release admits text-only D: its size evidence is
 * `requestBytes`, and a non-text part (an image, an audio clip, a file) is
 * priced by the provider in a way no byte length of D describes. The answer is
 * read off D itself — the exact bytes that will be sent — rather than off the
 * caller's snapshot, so nothing the compiler adds can slip past it.
 *
 * The rule is structural and closed, over the `openai-completions` body this
 * compiler produces: every entry of `messages` whose `content` is an array
 * must hold only parts whose `type` is exactly `"text"`. String or absent
 * content is text. Anything this rule cannot read — a body that is not a JSON
 * object, a `messages` that is absent or not an array, an entry or part that
 * is not an object — answers `false`, so an unreadable D stays unready rather
 * than being assumed text. A chat-completions D always carries `messages`; one
 * without it is not a D this rule can vouch for.
 */
export function preparedRequestContentIsTextOnly(requestBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const messages = (parsed as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
    const content = (message as Record<string, unknown>).content;
    if (content === undefined || content === null || typeof content === 'string') continue;
    if (!Array.isArray(content)) return false;
    for (const part of content) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return false;
      if ((part as Record<string, unknown>).type !== 'text') return false;
    }
  }
  return true;
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

/**
 * Digest one value with the canonical form the envelope digests use
 * (`./prepared-request.ts`), so a fingerprint and a manifest digest can never
 * disagree about what a value's canonical bytes are.
 */
async function canonicalDigest(value: unknown): Promise<string> {
  return canonicalPreparedDigest(value);
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
 * nothing else. Native tools come
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
