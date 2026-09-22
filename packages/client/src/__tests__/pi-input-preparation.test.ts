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
import { preparedCompileRequest as compileRequest } from './fixtures/prepared-compile-snapshot';

/**
 * B-P2 §10.5 "Completeness/purity" for the ONE module that composes the native
 * package: `adapters/pi/input-preparation.ts`.
 *
 * This file owns the CONTRACT half: what the compile produces, what the
 * envelope boundary refuses, and the STATIC import closure of the native dist
 * files the compile path loads. The static closure cannot be defeated by ESM
 * binding semantics — a named import that a monkeypatch would miss still shows
 * up as an import specifier — and it is the check that keeps holding after a
 * fork bump.
 *
 * CALL-TIME purity is NOT proven here. It is proven in
 * `pi-compile-purity.test.ts`, which measures a real compile in an isolated
 * child process whose monitors are installed before the fork's module graph
 * exists. An in-process trap cannot do it: the fork's helpers bind NAMED
 * imports (`dist/config.js`, `dist/core/skills.js`, `dist/utils/paths.js`),
 * and a binding taken before the patch resolves through a builtin ESM
 * namespace the patch never reached.
 *
 * Nothing in this file performs a live provider or tokenizer call, and nothing
 * creates a task, claim, Execution or nonce.
 */

/**
 * The static import closure of the native compile path, walked transitively.
 *
 * Only the two fork packages are DESCENDED into; anything else is recorded as
 * an edge and left alone, because what matters about a third-party package here
 * is that the pure path reaches it at all. Resolution mirrors Node's own: the
 * nearest `node_modules/<name>` above the importer, then that package's
 * `exports` map under the `import` condition, patterns included.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\bexport\s*)["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu;

const FORK_PACKAGES = new Set(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']);

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

function walkNativeClosure(entry: string): { files: Set<string>; thirdParty: Set<string>; builtins: Set<string> } {
  const files = new Set<string>();
  const thirdParty = new Set<string>();
  const builtins = new Set<string>();
  const queue = [realpathSync(entry)];
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
      if (!FORK_PACKAGES.has(name)) {
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
      byokFork: { upstreamBase: string; upstreamCommit: string; forkBuild: number };
    };
    expect(identity.packageName).toBe(installed.name);
    expect(identity.packageVersion).toBe(installed.version);
    expect(identity.upstreamBase).toBe(installed.byokFork.upstreamBase);
    expect(identity.upstreamCommit).toBe(installed.byokFork.upstreamCommit);
    expect(identity.forkBuild).toBe(installed.byokFork.forkBuild);
    expect(identity.envelopeFormat).toBe('pi.session.prepared-input');
    expect(identity.requestFormat).toBe('pi.openai-completions.prepared');
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
    // The authorized context file and guideline reached the compiled system
    // prompt: a partial snapshot would be counted as a different request.
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('be precise');
    expect(body.messages[0]?.content).toContain('prefer small diffs');
    // The two prompt inputs the 0.86 rebase moved onto the wire, rendered by
    // upstream's own builder rather than by a caller-supplied block.
    expect(body.messages[0]?.content).toContain('read before you write');
    expect(body.messages[0]?.content).toContain('review a diff before it is proposed');
    expect(body.messages[0]?.content).toContain('/workspace/project/.skills/review/SKILL.md');
    // The host-canonical prefix is carried as an ordinary assistant turn, and
    // the context still ends on the user turn the boundary requires.
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages[2]).toMatchObject({ role: 'assistant', content: 'It is a BYOK SDK.' });
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'summarise the repository' });
    // Complete model-visible schemas, in order, not names alone.
    expect(body.tools.map((tool) => tool.function.name)).toEqual(['read', 'bash']);
    expect(body.tools[0]?.function.parameters).toMatchObject({ properties: { path: { type: 'string' } } });
    // `constrainedSampling` reaches the wire as `strict`. The SDK's projection
    // no longer strips it, so what is counted is what would be sent.
    expect(body.tools.map((tool) => tool.function.strict)).toEqual([true, true]);

    // The native compiler's own structural projection contract, verbatim: a
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

    // The envelope's `providerRequest.model` IS the object handed to the native
    // compile — the fork deep-copies its input and carries that copy through —
    // so this is the pass-through assertion, not a re-derivation of it.
    const declared = await compiler.compile(
      compileRequest({ model: { ...compileRequest().model, reasoning: true, thinkingLevelMap, compat } }),
    );
    const carried = declared.envelope.providerRequest.model as unknown as Record<string, unknown>;
    expect(carried['thinkingLevelMap']).toEqual(thinkingLevelMap);
    expect(carried['compat']).toEqual(compat);

    // Undeclared means the keys are ABSENT, not present-and-undefined: the
    // native validator's own key gate reads a present key as a declaration.
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

  it('the native compile closure is transitive, and reaches exactly the declared third-party packages', () => {
    // Derived, not listed. The hazard a hardcoded file list misses is an EDGE:
    // `prepared-session-input.js` reaches the fork's provider layer, which
    // reaches `openai`, and a fork bump can add another such edge without
    // touching any file this test used to name. So the closure is walked from
    // the one entry the compiler actually imports, through the two fork
    // packages, and what it reaches outside them is pinned.
    const nativeRoot = path.join(path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME))), '..');
    const walked = walkNativeClosure(path.join(nativeRoot, 'dist/core/prepared-session-input.js'));

    // The third-party edges of the pure compile path, exactly. A fork bump that
    // adds one fails HERE, where the addition is still a reviewable fact,
    // rather than at some later runtime.
    //
    // The 0.86 rebase WIDENED this set, and it is stated rather than hidden:
    // the compile now renders the system prompt with upstream's own builder
    // instead of a fork-local renderer, and that builder value-imports the
    // pi-ai barrel and the coding-agent skill/config modules. That is the whole
    // point of the rebase — one renderer, not two — so the closure it drags in
    // is the honest cost of it. `fs`, `os`, `path` and `url` appear here rather
    // than under `builtins` because the walker classifies by specifier and
    // these are imported bare.
    expect([...walked.thirdParty].sort()).toEqual([
      'cross-spawn', 'fs', 'ignore', 'openai', 'os', 'partial-json', 'path', 'typebox', 'url', 'yaml',
    ]);
    expect([...walked.builtins].sort()).toEqual([
      'node:child_process', 'node:fs', 'node:os', 'node:path', 'node:url',
    ]);

    // What this test proves and what it does NOT.
    //
    // It proves the REACHABLE set, exactly: a fork bump that adds an edge fails
    // here. It no longer proves that the coding-agent half of the closure names
    // no I/O builtin at all — on 0.86 the prompt builder reaches `config.js`
    // (which reads `process.env`), `paths.js` (`node:fs`/`node:os`) and
    // `child-process.js` (`node:child_process`), so the old blanket rule would
    // now be a false statement rather than a check.
    //
    // CALL-TIME purity is proven by `pi-compile-purity.test.ts`, not here and
    // not by an in-process trap: that gate measures a real compile of this
    // same fixture in a child process whose monitors are installed before the
    // fork's graph loads, so a read through one of those named bindings is
    // visible. IMPORT-TIME effects are guarded by the fork's own entry-graph
    // forbid list, and at this SDK by the sealed-host resolution tripwire
    // (`pi-s2-bundle-resolution.test.ts`). The files below are the exact set the
    // entry reaches, so a new one is a reviewable fact here too.
    const codingAgentFiles = [...walked.files].filter((file) => file.startsWith(path.join(nativeRoot, 'dist')));
    expect(codingAgentFiles.map((file) => path.basename(file)).sort()).toEqual([
      'child-process.js',
      'config.js',
      'frontmatter.js',
      'input-preparation.js',
      'paths.js',
      'prepared-session-input.js',
      'skills.js',
      'source-info.js',
      'system-prompt.js',
      'text.js',
    ]);
    // The two files that OWN the compile still carry the stricter rule: the
    // admission boundary and the envelope builder name no I/O builtin and read
    // no environment of their own.
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
    const compileOwners = codingAgentFiles.filter((file) =>
      ['input-preparation.js', 'prepared-session-input.js'].includes(path.basename(file)));
    expect(compileOwners).toHaveLength(2);
    for (const file of compileOwners) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of forbidden) {
        expect({ file: path.basename(file), specifier, present: source.includes(specifier) }).toEqual({
          file: path.basename(file),
          specifier,
          present: false,
        });
      }
    }
  });
});

describe('B-P2 native composition: unsupported input rejects rather than filling gaps', () => {
  it.each([
    [
      'a tool schema that is not a full object schema',
      (): CompilePreparedInputRequest => {
        const base = compileRequest();
        return {
          ...base,
          snapshot: {
            ...base.snapshot,
            tools: base.snapshot.tools.map((tool) =>
              tool.name === 'read' ? { ...tool, parameters: { type: 'object' } } : tool,
            ),
          },
        };
      },
    ],
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
            prompt: { ...base.snapshot.prompt, selectedTools: ['read'], toolSnippets: { read: 'read snippet' } },
          },
        };
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
 * fork produces, so the envelope is stated literally and the identity is the
 * one this build supports. A boundary that could only be reached by compiling
 * against a particular installed fork would be a boundary whose refusals are
 * untestable on the day they matter most — when the installed fork is the
 * wrong one.
 */
describe('B-P2 native composition: the envelope contract is verified, not assumed', () => {
  const COUNTER_PROJECTION = '{"model":"glm-4.6","messages":[],"tools":[]}';

  const SUPPORTED_IDENTITY = {
    packageName: '@byok-sdk/pi-coding-agent',
    packageVersion: '0.85.1005',
    upstreamBase: '0.85.1',
    upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
    forkBuild: 5,
    envelopeFormat: 'pi.session.prepared-input',
    requestFormat: 'pi.openai-completions.prepared',
    compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
  } as const;

  function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'pi.session.prepared-input',
      version: 3,
      snapshot: {},
      context: {},
      providerRequest: {
        format: 'pi.openai-completions.prepared',
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
    expect(refusalOf({ ...envelope(), format: 'pi.session.other-input' }).detail).toBe('unsupported_envelope_format');
    expect(refusalOf(envelope({ format: 'pi.anthropic-messages.prepared' })).detail).toBe(
      'unsupported_envelope_format',
    );
  });

  it('refuses an envelope compiled to a prepared-request version this build does not consume', () => {
    expect(refusalOf(envelope({ compilerVersion: 1 })).detail).toBe('unsupported_compiler_version');
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
