import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { SpawnFn } from '../adapters/pi/rpc-client';
import { createPiInputPreparationCompiler, resolveInstalledPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';
import type { AgentEvent } from '@byok-sdk/protocol';
import { sealRuntimeOperationManifest, type RuntimePreparedLaunchV1 } from '../types';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * The 0.86 response-timing change, at the one seam that has to tolerate it.
 *
 * On the 0.85 line the single `prompt_prepared` response was written at
 * admission, before anything else could reach the transport. On 0.86 it is
 * written at the BYTE-GATE verdict — the point at which the first provider
 * request has been proved equal to D — so by then the run has already emitted
 * the session events for the leading system and user messages. Six frames now
 * arrive before the response the adapter is still awaiting, and `PiSession` is
 * constructed only after that response.
 *
 * Nothing in the adapter had to change for this: `PiRpcClient` correlates the
 * response by id and pushes every other frame into an order-preserving
 * `AsyncQueue` that nobody reads until the session attaches. This file PINS
 * that, because "it happens to work because nobody reads the queue early" is a
 * property, not a coincidence, and the day it stops holding the symptom would
 * be a silently swallowed turn rather than a failure.
 *
 * It also pins the other half of the same change: `prepared_body_drift` is a
 * code this SDK had never seen, and the adapter reports the fork's code
 * VERBATIM rather than through a mapping table. Reaching the fork's real byte
 * gate from here would mean forging an envelope whose digest is valid and whose
 * body is not — i.e. reimplementing the fork's own digest — so the runtime is
 * scripted at the adapter's `spawnFn` seam instead, and what is under test is
 * exactly what this package owns: how a typed refusal on that response surfaces.
 */

const TIMING_HOST = fileURLToPath(new URL('./fixtures/prepared-response-timing-host.mjs', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const MODEL = {
  id: 'glm-4.6',
  name: 'GLM 4.6',
  api: 'openai-completions' as const,
  provider: 'zai',
  baseUrl: 'http://127.0.0.1:1/v1',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const BINDING = {
  inputIdentity: 'timing-input',
  runtimeIdentity: 'timing-runtime',
  policyIdentity: 'timing-policy',
  profileRevision: 'timing-profile',
} as const;

/** A REAL retained envelope from the pinned fork; only its consumer is scripted. */
async function prepareArtifact(cwd: string, artifactPath: string, launchCwd: string): Promise<RuntimePreparedLaunchV1> {
  const compiled = await createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity()).compile({
    snapshot: {
      prompt: {
        cwd,
        selectedTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        contextFiles: [],
        skills: [],
        docsPaths: { readmePath: '/sealed/README.md', docsPath: '/sealed/docs', examplesPath: '/sealed/examples' },
      },
      messages: [{ role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 }],
      tools: [],
    },
    model: MODEL,
    options: { cacheRetention: 'none', maxTokens: 256 },
    binding: { ...BINDING },
    toolExecutors: {},
  });
  const recordId = 'prepared-timing-record';
  await fs.writeFile(
    artifactPath,
    JSON.stringify({ format: INPUT_PREPARATION_ARTIFACT_FORMAT, version: INPUT_PREPARATION_VERSION, recordId, ...compiled }),
    { mode: 0o600 },
  );
  return {
    reference: { scopeId: 'timing-scope', agentRef: 'timing-agent', requestId: 'timing-preparation', recordId },
    artifactPath,
    expected: {
      envelopeDigest: compiled.envelopeDigest,
      toolManifestDigest: compiled.toolManifestDigest,
      model: MODEL,
      binding: { ...BINDING },
    },
    permissionMode: 'auto',
    toolBindingDigest: 'prepared-timing-tool-binding',
    observationDigest: 'prepared-timing-observation',
    launch: { cwd: launchCwd },
    toolImplementations: {},
    toolsetDefinitionRevisions: {},
  };
}

/** The real adapter start path, with only the prepared runtime child substituted. */
async function startPrepared(refuse: boolean): Promise<{ close: () => Promise<void>; events: AsyncIterable<AgentEvent> }> {
  const workspace = await tmpDir('byok-prepared-timing-cwd-');
  const recordDir = await tmpDir('byok-prepared-timing-record-');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  const adapter = new PiAdapter({
    resolveBin: () => ({ command: process.execPath, source: 'env' }),
    spawnFn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      // The adapter picks the SDK's own prepared entry internally; only the
      // script is replaced. Every other argv token, the cwd and the env are
      // the adapter's own and are passed through untouched, so what is
      // exercised is the real launch, not a reconstruction of one.
      if (!args[0]?.endsWith('byok-pi-prepared.js')) {
        throw new Error(`expected the prepared entry, got ${String(args[0])}`);
      }
      return spawn(
        command,
        [TIMING_HOST, ...args.slice(1)],
        { ...options, env: { ...options.env, ...(refuse ? { BYOK_PREPARED_TIMING_REFUSE: '1' } : {}) } },
      );
    }) as unknown as SpawnFn,
  });
  const policy = { mode: 'auto' as const };
  const prepared = await adapter.prepare({
    offer: { instruction: 'summarise the repository', policy },
    policy,
    descriptor: adapter.descriptor,
    requiredToolsetIds: [],
  });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  const manifest = sealRuntimeOperationManifest({
    taskId: 'prepared-timing-task',
    runtimeId: 'pi',
    descriptor: adapter.descriptor,
    policy,
    requiredToolsetIds: [],
    workspace: { workspaceDir: workspace },
    forwardedEnvironmentNames: Object.keys(env).sort(),
  });
  const launchCwd = await trustedCwd();
  const preparation = await prepareArtifact(workspace, path.join(recordDir, 'artifact.json'), launchCwd);
  const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch!({
    kind: 'prepared',
    cwd: workspace,
    env,
    projectionRoot: path.join(recordDir, 'projections'),
  });
  const session = await prepared.operation.start({
    runtimeLaunch,
    kind: 'prepared',
    preparation,
    manifest,
    env,
    mcpEnv: projectPiMcpEnvironment(env),
    mcpLaunch: { cwd: launchCwd },
  });
  return { close: () => session.close(), events: session.events };
}

describe('the prepared response now arrives after the run\'s first session events', () => {
  it('delivers every frame queued before the response to the session, in order and exactly once', async () => {
    const { close, events } = await startPrepared(false);
    try {
      // The six routine frames carry no `AgentEvent` (they are
      // `ROUTINE_PI_EVENT_TYPES` bookkeeping), so what proves DELIVERY rather
      // than mere buffering is the two mapped frames the script writes in the
      // same pre-response burst: both were pushed onto the queue before
      // `PiSession` existed, and both still reach the session's stream. Two is
      // the smallest number that makes ORDER a claim at all — one frame is in
      // order by construction.
      const seen: AgentEvent[] = [];
      const iterator = events[Symbol.asyncIterator]();
      for (let read = 0; read < 2; read += 1) {
        const next = await iterator.next();
        if (next.done !== true) seen.push(next.value);
      }
      expect(seen).toEqual([
        { type: 'progress', text: 'queued first, before the response' },
        { type: 'progress', text: 'queued second, still before the response' },
      ]);
      // Exactly once: a third read must replay neither buffered frame.
      const after = await Promise.race([
        iterator.next().then((result) => (result.done === true ? 'done' : result.value)),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 250)),
      ]);
      expect(seen).not.toContainEqual(after);
    } finally {
      await close();
    }
  }, 60_000);

  it('reports a prepared_body_drift refusal verbatim, as a non-retryable semantic start failure', async () => {
    // New on 0.86 and passed through with no mapping table: the adapter names
    // whatever code the fork reported. A code this SDK translated would be a
    // second vocabulary for the one fact the byte gate established.
    await expect(startPrepared(true)).rejects.toMatchObject({
      phase: 'start',
      category: 'semantic',
      retry: 'non-retryable',
    });
    await expect(startPrepared(true)).rejects.toThrow(/prepared_body_drift/u);
  }, 60_000);
});
