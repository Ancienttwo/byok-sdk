import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  prepareCodingAgentSessionInput,
  type PreparedSessionInputV1,
} from '@earendil-works/pi-coding-agent/prepared-session-input';
import type {
  InputPreparationModelV1,
  InputPreparationOptionsV1,
  InputPreparationRuntimeIdentityV1,
  InputPreparationSnapshotV1,
} from '../../input-preparation';
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
 */

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
      let envelope: PreparedSessionInputV1;
      try {
        envelope = await prepareCodingAgentSessionInput({
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
