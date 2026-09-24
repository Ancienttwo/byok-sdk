import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createPiInputPreparationCompiler,
  resolveInstalledPiRuntimeIdentity,
  verifyCompiledPreparedInput,
  InputPreparationCompileError,
  SUPPORTED_PREPARED_COMPILER_VERSION,
  type CompilePreparedInputRequest,
} from '../adapters/pi/input-preparation';
import { PI_PACKAGE_NAME, resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import {
  PREPARED_COMPILE_SYSTEM_PROMPT,
  preparedCompileRequest as compileRequest,
} from './fixtures/prepared-compile-snapshot';

/**
 * B-P2 §10.5 "Completeness/purity" for the ONE module that composes the
 * official package: `adapters/pi/input-preparation.ts` (A1' compile via
 * `adapters/pi/prepared-request.ts`).
 *
 * This file owns the CONTRACT half: what the compile produces, what the
 * envelope boundary refuses, and the STATIC import closure of the official
 * dist files the compile path loads. The static closure cannot be defeated by
 * ESM binding semantics — a named import that a monkeypatch would miss still
 * shows up as an import specifier — and it is the check that keeps holding
 * after an official version bump.
 *
 * CALL-TIME purity is NOT proven here. It is proven in
 * `pi-compile-purity.test.ts`, which measures a real compile in an isolated
 * child process whose monitors are installed before the official module graph
 * exists. An in-process trap cannot do it: pi-ai's helpers bind NAMED imports
 * (`dist/utils/provider-env.js`), and a binding taken before the patch
 * resolves through a builtin ESM namespace the patch never reached.
 *
 * Nothing in this file performs a live provider or tokenizer call, and nothing
 * creates a task, claim, Execution or nonce.
 */

/**
 * The static import closure of the official compile path, walked transitively.
 *
 * Only the official package the compile loads (`@earendil-works/pi-ai`) is
 * DESCENDED into; anything else is recorded as an edge and left alone, because what matters about a third-party package here
 * is that the pure path reaches it at all. Resolution mirrors Node's own: the
 * nearest `node_modules/<name>` above the importer, then that package's
 * `exports` map under the `import` condition, patterns included.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\bexport\s*)["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu;

const OFFICIAL_COMPILE_PACKAGES = new Set(['@earendil-works/pi-ai']);

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2]!);
}

function packageRootOf(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function conditionTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null) return undefined;
  for (const condition of ['import', 'module', 'default']) {
    if (condition in target) {
      const resolved = conditionTarget((target as Record<string, unknown>)[condition]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function resolveSubpath(packageRoot: string, subpath: string): string | undefined {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    main?: string;
    exports?: unknown;
  };
  const key = subpath === '' ? '.' : `./${subpath}`;
  const exports = manifest.exports;
  if (exports === undefined) {
    return key === '.' && manifest.main !== undefined ? path.join(packageRoot, manifest.main) : undefined;
  }
  if (typeof exports === 'string') return key === '.' ? path.join(packageRoot, exports) : undefined;
  const map = exports as Record<string, unknown>;
  if (map[key] !== undefined) {
    const target = conditionTarget(map[key]);
    return target === undefined ? undefined : path.join(packageRoot, target);
  }
  for (const [pattern, target] of Object.entries(map)) {
    if (!pattern.includes('*')) continue;
    const [prefix, suffix = ''] = pattern.split('*');
    if (!key.startsWith(prefix!) || !key.endsWith(suffix)) continue;
    const star = key.slice(prefix!.length, key.length - suffix.length);
    const resolved = conditionTarget(target);
    if (resolved !== undefined) return path.join(packageRoot, resolved.replace('*', star));
  }
  return undefined;
}

function walkNativeClosure(entries: readonly string[]): { files: Set<string>; thirdParty: Set<string>; builtins: Set<string> } {
  const files = new Set<string>();
  const thirdParty = new Set<string>();
  const builtins = new Set<string>();
  const queue = entries.map((entry) => realpathSync(entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) {
        builtins.add(specifier);
        continue;
      }
      if (specifier.startsWith('.')) {
        queue.push(realpathSync(path.resolve(path.dirname(file), specifier)));
        continue;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
      if (!OFFICIAL_COMPILE_PACKAGES.has(name)) {
        thirdParty.add(name);
        continue;
      }
      const packageRoot = packageRootOf(name, path.dirname(file));
      expect({ specifier, resolved: packageRoot !== undefined }).toEqual({ specifier, resolved: true });
      const resolved = resolveSubpath(packageRoot!, specifier.slice(name.length).replace(/^\//u, ''));
      expect({ specifier, exported: resolved !== undefined }).toEqual({ specifier, exported: true });
      queue.push(realpathSync(resolved!));
    }
  }
  return { files, thirdParty, builtins };
}

describe('B-P2 native composition: runtime identity', () => {
  it('derives identity from the installed artifact closure, not from a caller label', () => {
    const identity = resolveInstalledPiRuntimeIdentity();
    const pinned = resolvePiRuntimeIdentity();

    // The pin in the client manifest and the manifest actually on disk are two
    // independent facts; the identity is only issued when they agree.
    expect(identity.packageName).toBe(pinned.name);
    expect(identity.packageVersion).toBe(pinned.version);

    const installedManifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME))),
      '..',
      'package.json',
    );
    const installed = JSON.parse(readFileSync(installedManifestPath, 'utf8')) as {
      name: string;
      version: string;
      byokFork?: unknown;
    };
    expect(identity.packageName).toBe(installed.name);
    expect(identity.packageVersion).toBe(installed.version);
    expect(installed.name).toBe('@earendil-works/pi-coding-agent');
    // The official artifact carries no fork stanza; the provenance is the
    // pinned official tuple (upstream tag and registry gitHead), not a
    // manifest-declared claim.
    expect(Object.hasOwn(installed, 'byokFork')).toBe(false);
    expect(identity.upstreamBase).toBe(`v${installed.version}`);
    expect(identity.upstreamCommit).toBe('f07218c4d4bbc12bef056a7058c3dd49dfe41abe');
    expect(identity.forkBuild).toBe(0);
    // The two lockstep packages the compile and the session load are installed
    // at exactly the coding agent's version.
    for (const lockstep of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core']) {
      const manifest = JSON.parse(readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.resolve(lockstep))), '..', 'package.json'),
        'utf8',
      )) as { name: string; version: string };
      expect({ name: manifest.name, version: manifest.version }).toEqual({ name: lockstep, version: installed.version });
    }
    expect(identity.envelopeFormat).toBe('byok.pi.prepared-input');
    expect(identity.requestFormat).toBe('byok.pi.openai-completions.request');
    // The SUPPORTED constant, not a literal claim about the native: every
    // compile proves the envelope actually carries this same number.
    expect(identity.compilerVersion).toBe(SUPPORTED_PREPARED_COMPILER_VERSION);
    expect(Object.isFrozen(identity)).toBe(true);
  });
});

describe('B-P2 native composition: pure compile', () => {
  it('compiles the authorized full schemas and text into D, P(D) and the structural projection contract', async () => {
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    const compiled = await compiler.compile(compileRequest());

    const body = JSON.parse(compiled.requestBody) as {
      model: string;
      messages: { role: string; content: string }[];
      tools: { function: { name: string; description: string; parameters: unknown; strict?: unknown } }[];
    };
    expect(body.model).toBe('glm-4.6');
    // The Host-authored system message reached D verbatim and whole: no Pi
    // prompt builder ran (no `<cwd>` block, no rendered skills), so what the
    // Host counted is exactly what is sent.
    expect(body.messages[0]).toEqual({ role: 'system', content: PREPARED_COMPILE_SYSTEM_PROMPT });
    // The host-canonical prefix is carried as an ordinary assistant text turn
    // (the A2' sentinel provenance never reaches D), and the context still
    // ends on the user turn the boundary requires.
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages[2]).toMatchObject({ role: 'assistant', content: 'It is a BYOK SDK.' });
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'summarise the repository' });
    // Complete model-visible schemas, in order, not names alone.
    expect(body.tools.map((tool) => tool.function.name)).toEqual(['read', 'bash']);
    expect(body.tools[0]?.function.parameters).toMatchObject({ properties: { path: { type: 'string' } } });
    // `constrainedSampling` is admitted (`{ json_schema, prefer }`) but
    // produces no `strict` on a BYOK endpoint: `supportsStrictMode` is not in
    // the wire compat subset and the official serializer defaults it to false.
    // What is counted is what would be sent either way.
    expect(body.tools.map((tool) => Object.hasOwn(tool.function, 'strict'))).toEqual([false, false]);
    expect(compiled.requestBody).not.toContain('byok-host-canonical');

    // The SDK compiler's structural projection contract, verbatim: a
    // content-complete projection whose digest describes the exact counted
    // bytes, plus the classification of every key of D outside P(D).
    expect(compiled.projection.version).toBe(3);
    expect(compiled.projection.kind).toBe('content_complete');
    expect(compiled.projection.digest).toBe(
      createHash('sha256').update(compiled.counterProjection, 'utf8').digest('hex'),
    );
    expect(compiled.residual.length).toBeGreaterThan(0);
    expect(compiled.residual.map((entry) => entry.key)).toContain('max_tokens');
    expect(compiled.envelope.providerRequest.compilerVersion).toBe(SUPPORTED_PREPARED_COMPILER_VERSION);
    expect(compiled.requestBytes).toBe(Buffer.byteLength(compiled.requestBody, 'utf8'));
    expect(compiled.projectionBytes).toBe(Buffer.byteLength(compiled.counterProjection, 'utf8'));
    expect(compiled.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.envelopeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.toolManifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    // Executable identity is digested separately from the body: schema
    // equality alone never proves the same executable closure.
    expect(compiled.envelope.toolManifest.executors).toEqual(['exec:read@1', 'exec:bash@1']);
  });

  it('is deterministic: the same authorized input always yields the same D and digest', async () => {
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    const first = await compiler.compile(compileRequest());
    const second = await compiler.compile(compileRequest());
    expect(second.requestBody).toBe(first.requestBody);
    expect(second.counterProjection).toBe(first.counterProjection);
    expect(second.requestDigest).toBe(first.requestDigest);
    expect(second.envelopeDigest).toBe(first.envelopeDigest);
  });

  it('hands the native compile the declared thinkingLevelMap and compat, verbatim, and only when declared', async () => {
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    const thinkingLevelMap = {
      off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
    } as const;
    const compat = {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'zai',
      zaiToolStream: true,
    } as const;

    // The envelope's `providerRequest.model` IS the object the compile
    // projected for the official serializer — `compilePreparedPiInput`
    // deep-copies its input and carries that copy through — so this is the
    // pass-through assertion, not a re-derivation of it.
    const declared = await compiler.compile(
      compileRequest({ model: { ...compileRequest().model, reasoning: true, thinkingLevelMap, compat } }),
    );
    const carried = declared.envelope.providerRequest.model as unknown as Record<string, unknown>;
    expect(carried['thinkingLevelMap']).toEqual(thinkingLevelMap);
    expect(carried['compat']).toEqual(compat);

    // Undeclared means the keys are ABSENT, not present-and-undefined: the
    // prepared-session drift check (`canonicalPreparedValue`) and the official
    // model object both read a present key as a declaration.
    const undeclared = await compiler.compile(compileRequest());
    const plain = undeclared.envelope.providerRequest.model as unknown as Record<string, unknown>;
    expect(Object.hasOwn(plain, 'thinkingLevelMap')).toBe(false);
    expect(Object.hasOwn(plain, 'compat')).toBe(false);

    // And the declarations reach D itself: carrying them would be pointless if
    // the compiled body were identical either way.
    expect(declared.requestBody).not.toBe(undeclared.requestBody);
  });

  it('writes no environment variable while compiling', async () => {
    // The one assertion the old in-process trap test could actually make.
    // Comparing `process.env` before and after detects a WRITE and nothing
    // else — a READ leaves it byte-identical — so the read side, and every
    // other call-time surface, moved to the isolated gate in
    // `pi-compile-purity.test.ts`. This stays because a compile that mutated
    // the ambient environment would be a defect this cheap check still catches
    // on the SDK's own call path.
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());

    const envBefore = JSON.stringify(process.env);
    const compiled = await compiler.compile(compileRequest());
    const envAfter = JSON.stringify(process.env);

    expect(envAfter).toBe(envBefore);
    expect(compiled.requestBody.length).toBeGreaterThan(0);
  });

  it('the official compile closure is transitive, and reaches exactly the declared third-party packages', () => {
    // Derived, not listed. The hazard a hardcoded file list misses is an EDGE:
    // the A1' compile entry reaches pi-ai's provider layer, which reaches
    // `openai`, and an official version bump can add another such edge without
    // touching any file this test used to name. So the closure is walked from
    // the two entries the compiler actually imports
    // (`prepared-request.ts` `loadOfficialCompiler`: the pi-ai root and
    // `@earendil-works/pi-ai/api/openai-completions`), through pi-ai, and what
    // it reaches outside pi-ai is pinned.
    const piAiRoot = path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))), '..');
    const walked = walkNativeClosure([
      fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions')),
      fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')),
    ]);

    // The third-party edges of the pure compile path, exactly. An official
    // bump that adds one fails HERE, where the addition is still a reviewable
    // fact, rather than at some later runtime.
    //
    // The official A1' path is NARROWER than the 0.86 fork's: no Pi prompt
    // builder is loaded (the Host owns the whole system message), so the
    // coding-agent package, its skill/config modules, `yaml`, `ignore` and
    // `cross-spawn` are gone. The one builtin is `node:fs`, reached through a
    // `require("node:fs")` in `utils/provider-env.js` that runs only under a
    // Bun compiled binary with an empty `process.env`.
    expect([...walked.thirdParty].sort()).toEqual(['openai', 'partial-json', 'typebox']);
    expect([...walked.builtins].sort()).toEqual(['node:fs']);

    // The exact file set the two entries reach, so a new one is a reviewable
    // fact. CALL-TIME purity is proven by `pi-compile-purity.test.ts`: that
    // gate measures a real compile of this same fixture in a child process
    // whose monitors are installed before the official graph loads.
    const piAiFiles = [...walked.files].map((file) => path.relative(realpathSync(piAiRoot), file)).sort();
    expect(piAiFiles).toEqual([
      'dist/api/constrained-sampling.js',
      'dist/api/github-copilot-headers.js',
      'dist/api/lazy.js',
      'dist/api/openai-completions.js',
      'dist/api/openai-prompt-cache.js',
      'dist/api/simple-options.js',
      'dist/api/transform-messages.js',
      'dist/auth/context.js',
      'dist/auth/credential-store.js',
      'dist/auth/helpers.js',
      'dist/auth/resolve.js',
      'dist/auth/types.js',
      'dist/images-models.js',
      'dist/index.js',
      'dist/models-store.js',
      'dist/models.js',
      'dist/providers/faux.js',
      'dist/session-resources.js',
      'dist/types.js',
      'dist/utils/abort.js',
      'dist/utils/assistant-message-frame.js',
      'dist/utils/diagnostics.js',
      'dist/utils/error-body.js',
      'dist/utils/estimate.js',
      'dist/utils/event-stream.js',
      'dist/utils/hash.js',
      'dist/utils/headers.js',
      'dist/utils/json-parse.js',
      'dist/utils/overflow.js',
      'dist/utils/pi-user-agent.js',
      'dist/utils/provider-env.js',
      'dist/utils/provider-retry.js',
      'dist/utils/retry.js',
      'dist/utils/sanitize-unicode.js',
      'dist/utils/text.js',
      'dist/utils/transcript.js',
      'dist/utils/typebox-helpers.js',
      'dist/utils/uuid.js',
      'dist/utils/validation.js',
    ]);
    // The file that OWNS the serialization still carries the stricter rule:
    // the official `openai-completions.js` names no I/O builtin and reads no
    // environment of its own (it reaches `process.env` only through
    // `getProviderEnvValue`, which the compile never needs: it passes an
    // explicit placeholder key).
    const forbidden = [
      'node:fs',
      'node:net',
      'node:http',
      'node:https',
      'node:child_process',
      'node:os',
      'node:dns',
      'node:tls',
      'process.env',
    ];
    const compileOwner = [...walked.files].find((file) => file.endsWith(path.join('dist', 'api', 'openai-completions.js')));
    expect(compileOwner).toBeDefined();
    const source = readFileSync(compileOwner!, 'utf8');
    for (const specifier of forbidden) {
      expect({ file: 'openai-completions.js', specifier, present: source.includes(specifier) }).toEqual({
        file: 'openai-completions.js',
        specifier,
        present: false,
      });
    }
  });
});

describe('B-P2 native composition: unsupported input rejects rather than filling gaps', () => {
  // PRODUCTION GAP (WP2b): the retired fork refused a tool schema without an
  // object `properties` member ("expected full object tool schema",
  // pi-wt-086 `core/input-preparation.ts:280-287`). The SDK-owned projection
  // `adapters/pi/prepared-request.ts:220-221` (`projectTool`) checks only
  // `type === "object"`, so `{ type: "object" }` now compiles. Restore this
  // case once `projectTool` also refuses a missing/non-object `properties`:
  //   tools: base.snapshot.tools.map((tool) =>
  //     tool.name === 'read' ? { ...tool, parameters: { type: 'object' } } : tool)
  it.todo('rejects a tool schema that is not a full object schema (needs projectTool properties check)');

  it.each([
    [
      'executor identities that do not cover exactly the model-visible tools',
      (): CompilePreparedInputRequest => ({ ...compileRequest(), toolExecutors: { read: 'exec:read@1' } }),
    ],
    [
      'a selected-tool list that does not match the supplied schemas',
      (): CompilePreparedInputRequest => {
        const base = compileRequest();
        return {
          ...base,
          snapshot: {
            ...base.snapshot,
            prompt: { ...base.snapshot.prompt, selectedTools: ['read'] },
          },
        };
      },
    ],
    [
      'a Pi renderer input the official lane has no renderer for',
      (): CompilePreparedInputRequest => {
        const base = compileRequest();
        return {
          ...base,
          snapshot: { ...base.snapshot, prompt: { ...base.snapshot.prompt, promptGuidelines: ['prefer small diffs'] } },
        };
      },
    ],
    [
      'a Host system message that is not stated as customPrompt',
      (): CompilePreparedInputRequest => {
        const base = compileRequest();
        const { customPrompt: _dropped, ...prompt } = base.snapshot.prompt;
        return { ...base, snapshot: { ...base.snapshot, prompt: { ...prompt, appendSystemPrompt: 'appended' } } };
      },
    ],
    [
      'an empty message history',
      (): CompilePreparedInputRequest => {
        const base = compileRequest();
        return { ...base, snapshot: { ...base.snapshot, messages: [] } };
      },
    ],
  ])('rejects %s', async (_label, build) => {
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    await expect(compiler.compile(build())).rejects.toBeInstanceOf(InputPreparationCompileError);
  });
});

/**
 * The envelope-contract boundary, exercised WITHOUT the installed package.
 *
 * Every case here is about what this SDK refuses to read, not about what the
 * official serializer produces, so the envelope is stated literally and the
 * identity is the one this build supports. A boundary that could only be
 * reached by compiling against a particular installed runtime would be a
 * boundary whose refusals are untestable on the day they matter most — when
 * the installed runtime is the wrong one.
 */
describe('B-P2 native composition: the envelope contract is verified, not assumed', () => {
  const COUNTER_PROJECTION = '{"model":"glm-4.6","messages":[],"tools":[]}';

  const SUPPORTED_IDENTITY = {
    packageName: '@earendil-works/pi-coding-agent',
    packageVersion: '0.87.1',
    upstreamBase: 'v0.87.1',
    upstreamCommit: 'f07218c4d4bbc12bef056a7058c3dd49dfe41abe',
    forkBuild: 0,
    envelopeFormat: 'byok.pi.prepared-input',
    requestFormat: 'byok.pi.openai-completions.request',
    compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
  } as const;

  function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'byok.pi.prepared-input',
      version: 1,
      transcript: { systemPrompt: 'Host system message', tools: [], messages: [] },
      providerRequest: {
        format: 'byok.pi.openai-completions.request',
        compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
        body: '{"model":"glm-4.6","messages":[],"max_tokens":4096}',
        counterProjection: COUNTER_PROJECTION,
        projection: {
          version: 3,
          kind: 'content_complete',
          digest: createHash('sha256').update(COUNTER_PROJECTION, 'utf8').digest('hex'),
        },
        residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
        digest: 'a'.repeat(64),
        ...overrides,
      },
      toolManifest: { order: [], executors: [], digest: 'c'.repeat(64) },
      digest: 'b'.repeat(64),
    };
  }

  function refusalOf(value: Record<string, unknown>): InputPreparationCompileError {
    try {
      verifyCompiledPreparedInput(value as never, SUPPORTED_IDENTITY);
    } catch (error) {
      if (error instanceof InputPreparationCompileError) return error;
      throw error;
    }
    throw new Error('expected the envelope to be refused');
  }

  it('accepts an envelope that carries exactly the supported contract', () => {
    const verified = verifyCompiledPreparedInput(envelope() as never, SUPPORTED_IDENTITY);

    expect(verified.projection).toEqual({
      version: 3,
      kind: 'content_complete',
      digest: createHash('sha256').update(COUNTER_PROJECTION, 'utf8').digest('hex'),
    });
    expect(verified.residual).toEqual([{ key: 'max_tokens', valueClass: 'bounded_integer' }]);
    expect(verified.projectionBytes).toBe(Buffer.byteLength(COUNTER_PROJECTION, 'utf8'));
  });

  it('refuses an envelope whose format tags are not the ones the runtime identity promises', () => {
    // Both tags, because the identity was derived from the installed manifest
    // and only the envelope in hand proves what the code that actually ran
    // produced.
    expect(refusalOf({ ...envelope(), format: 'byok.pi.other-input' }).detail).toBe('unsupported_envelope_format');
    expect(refusalOf(envelope({ format: 'byok.pi.anthropic-messages.request' })).detail).toBe(
      'unsupported_envelope_format',
    );
  });

  it('refuses an envelope compiled to a prepared-request version this build does not consume', () => {
    // 3 is the retired fork compiler: its artifacts are not read forward.
    expect(refusalOf(envelope({ compilerVersion: 3 })).detail).toBe('unsupported_compiler_version');
  });

  it('refuses a projection digest that does not describe the counted bytes it travels with', () => {
    // The bytes move, the declared digest does not: exactly the drift a digest
    // that only ever travels beside its own bytes would never catch.
    expect(refusalOf(envelope({ counterProjection: `${COUNTER_PROJECTION} ` })).detail).toBe(
      'projection_digest_mismatch',
    );
  });

  it('refuses a residual value class outside the supported classification contract', () => {
    expect(refusalOf(envelope({ residual: [{ key: 'max_tokens', valueClass: 'probably_free' }] })).detail).toBe(
      'unsupported_residual_value_class',
    );
  });

  it('refuses a projection version this build does not consume', () => {
    expect(
      refusalOf(envelope({ projection: { version: 1, kind: 'content_complete', digest: 'd'.repeat(64) } })).detail,
    ).toBe('unsupported_projection_shape');
  });
});

it('requires explicit compiler identity instead of performing default discovery', () => {
  expect(() => createPiInputPreparationCompiler(undefined as never)).toThrow('explicit runtime identity required');
});
