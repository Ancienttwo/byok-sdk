import childProcess from 'node:child_process';
import fsModule, { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPiInputPreparationCompiler,
  resolveInstalledPiRuntimeIdentity,
  InputPreparationCompileError,
  type CompilePreparedInputRequest,
} from '../adapters/pi/input-preparation';
import { PI_PACKAGE_NAME, resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import type { InputPreparationSnapshotV1 } from '../input-preparation';

/**
 * B-P2 §10.5 "Completeness/purity" for the ONE module that composes the native
 * package: `adapters/pi/input-preparation.ts`.
 *
 * Two independent purity proofs, because each one alone has a hole:
 *
 * 1. A STATIC closure assertion over the native dist files the compile path
 *    actually loads. It cannot be defeated by ESM binding semantics — a named
 *    import that a later monkeypatch would miss still shows up as an import
 *    specifier here — and it is the check that keeps holding after a fork
 *    bump.
 * 2. RUNTIME traps on the surfaces reachable without a bound import at all:
 *    the global `fetch`, the live `process` object, `os.homedir`, and the
 *    `node:fs` / `node:child_process` / `node:net` namespace objects. These
 *    prove the compile that just ran touched nothing, for this exact input.
 *
 * Neither performs a live provider or tokenizer call, and nothing in this file
 * creates a task, claim, Execution or nonce.
 */

function snapshot(): InputPreparationSnapshotV1 {
  return {
    prompt: {
      cwd: '/workspace/project',
      selectedTools: ['read', 'bash'],
      toolSnippets: { read: 'read snippet', bash: 'bash snippet' },
      promptGuidelines: ['prefer small diffs'],
      contextFiles: [{ path: 'AGENTS.md', content: '# agents\nbe precise\n' }],
      formattedSkills: '',
      docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
    },
    messages: [{ role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 }],
    tools: [
      {
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'bash',
        description: 'run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ],
  };
}

function compileRequest(overrides: Partial<CompilePreparedInputRequest> = {}): CompilePreparedInputRequest {
  return {
    snapshot: snapshot(),
    model: {
      id: 'glm-4.6',
      name: 'GLM 4.6',
      api: 'openai-completions',
      provider: 'zai',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    options: { cacheRetention: 'none', maxTokens: 4_096, temperature: 0 },
    binding: { inputIdentity: 'rev-1:src-1', runtimeIdentity: 'runtime-1', policyIdentity: 'policy-1', profileRevision: 'profile-1' },
    toolExecutors: { read: 'exec:read@1', bash: 'exec:bash@1' },
    ...overrides,
  };
}

/** Restores every runtime trap this file installs, whether or not its test failed. */
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function trap<T extends object, K extends keyof T>(target: T, key: K, hits: string[], label: string): void {
  const original = target[key];
  restores.push(() => {
    target[key] = original;
  });
  target[key] = ((...args: unknown[]) => {
    hits.push(`${label}(${args.length})`);
    throw new Error(`purity violation: ${label} was called during the pure compile stage`);
  }) as unknown as T[K];
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
    expect(Object.isFrozen(identity)).toBe(true);
  });
});

describe('B-P2 native composition: pure compile', () => {
  it('compiles the authorized full schemas and text into D, P(D) and unknown coverage', async () => {
    const compiler = createPiInputPreparationCompiler();
    const compiled = await compiler.compile(compileRequest());

    const body = JSON.parse(compiled.requestBody) as {
      model: string;
      messages: { role: string; content: string }[];
      tools: { function: { name: string; description: string; parameters: unknown } }[];
    };
    expect(body.model).toBe('glm-4.6');
    // The authorized context file and guideline reached the compiled system
    // prompt: a partial snapshot would be counted as a different request.
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('be precise');
    expect(body.messages[0]?.content).toContain('prefer small diffs');
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'summarise the repository' });
    // Complete model-visible schemas, in order, not names alone.
    expect(body.tools.map((tool) => tool.function.name)).toEqual(['read', 'bash']);
    expect(body.tools[0]?.function.parameters).toMatchObject({ properties: { path: { type: 'string' } } });

    expect(compiled.coverage).toBe('unknown');
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
    const compiler = createPiInputPreparationCompiler();
    const first = await compiler.compile(compileRequest());
    const second = await compiler.compile(compileRequest());
    expect(second.requestBody).toBe(first.requestBody);
    expect(second.counterProjection).toBe(first.counterProjection);
    expect(second.requestDigest).toBe(first.requestDigest);
    expect(second.envelopeDigest).toBe(first.envelopeDigest);
  });

  it('touches no filesystem, process, child-process, socket or network surface while compiling', async () => {
    // Construct FIRST: the compiler reads the installed manifest exactly once,
    // at construction, which is outside the pure stage by design.
    const compiler = createPiInputPreparationCompiler();

    const hits: string[] = [];
    trap(fsModule, 'readFileSync', hits, 'fs.readFileSync');
    trap(fsModule, 'writeFileSync', hits, 'fs.writeFileSync');
    trap(fsModule, 'existsSync', hits, 'fs.existsSync');
    trap(fsModule, 'openSync', hits, 'fs.openSync');
    trap(fsModule.promises, 'readFile', hits, 'fs.promises.readFile');
    trap(fsModule.promises, 'writeFile', hits, 'fs.promises.writeFile');
    trap(fsModule.promises, 'open', hits, 'fs.promises.open');
    trap(childProcess, 'spawn', hits, 'child_process.spawn');
    trap(childProcess, 'spawnSync', hits, 'child_process.spawnSync');
    trap(childProcess, 'execSync', hits, 'child_process.execSync');
    trap(net, 'createConnection', hits, 'net.createConnection');
    trap(net, 'connect', hits, 'net.connect');
    trap(os, 'homedir', hits, 'os.homedir');
    trap(process, 'cwd', hits, 'process.cwd');
    trap(process, 'chdir', hits, 'process.chdir');
    trap(globalThis, 'fetch', hits, 'globalThis.fetch');

    const envBefore = JSON.stringify(process.env);
    const compiled = await compiler.compile(compileRequest());
    const envAfter = JSON.stringify(process.env);

    expect(hits).toEqual([]);
    expect(envAfter).toBe(envBefore);
    expect(compiled.requestBody.length).toBeGreaterThan(0);
  });

  it('the native compile closure imports no I/O builtin and reads no environment', () => {
    // The binding-proof half of the purity claim: a named import a monkeypatch
    // would miss is still visible as an import specifier here.
    const nativeRoot = path.join(path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME))), '..');
    const closure = [
      path.join(nativeRoot, 'dist/core/prepared-session-input.js'),
      path.join(nativeRoot, 'dist/core/input-preparation.js'),
      path.join(nativeRoot, 'dist/core/system-prompt-renderer.js'),
    ];
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
    for (const file of closure) {
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
    const compiler = createPiInputPreparationCompiler();
    await expect(compiler.compile(build())).rejects.toBeInstanceOf(InputPreparationCompileError);
  });
});
