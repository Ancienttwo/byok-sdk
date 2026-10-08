import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope, type RuntimeId, type TaskOfferPayload } from '@byok-sdk/protocol';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { SpawnFn as PiSpawnFn } from '../adapters/pi/rpc-client';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn as ClaudeSpawnFn } from '../adapters/claude/process-client';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { spawn as codexNodeSpawn } from 'node:child_process';
type CodexSpawnFn = typeof codexNodeSpawn;
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';

/**
 * `TaskRunner` hands every runtime the daemon's full environment minus the
 * hard deny (`CLAUDECODE`, `BYOK_*` — see
 * `daemon/environment.ts`), as OAR does. These tests drive the THREE REAL bundled adapters (against
 * their existing fake-CLI fixtures — mirrors `pi-adapter.test.ts`/
 * `claude-adapter.test.ts`/`codex-adapter.test.ts`'s own `resolveBin`
 * override) through a directly-constructed `TaskRunner` (mirrors
 * `task-runner-approval.test.ts`'s convention: no full daemon/WS server
 * needed) with a SPYING `spawnFn` (mirrors `claude-adapter.test.ts`'s
 * `spyingSpawnFn`) that captures the actual `env` each fake spawn receives,
 * while still delegating to the real `spawn` so the fixture genuinely runs.
 */

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

/** Captures whatever `env` the wrapped spawn call actually received, then delegates to the real `spawn` so the fake-CLI fixture genuinely runs. */
function makeCapturingSpawn<T>(sink: { env?: NodeJS.ProcessEnv }): T {
  const fn = (
    command: string,
    args: readonly string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown } = {},
  ) => {
    sink.env = options.env;
    return realSpawn(command, [...args], options as Parameters<typeof realSpawn>[2]);
  };
  return fn as unknown as T;
}

interface Harness {
  sent: Envelope[];
  captured: Record<RuntimeId, { env?: NodeJS.ProcessEnv }>;
  offer(runtime: RuntimeId, taskId: string, dispatchSelection?: TaskOfferPayload['dispatchSelection']): Promise<void>;
  /** Best-effort teardown of every task this harness offered — interrupts + closes each real fixture-backed session so no child process is left running past the test. */
  cancelAll(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const captured: Record<RuntimeId, { env?: NodeJS.ProcessEnv }> = { pi: {}, claude: {}, codex: {} };

  const piAdapter = new PiAdapter({
    resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
    spawnFn: makeCapturingSpawn<PiSpawnFn>(captured.pi),
  });
  const claudeAdapter = new ClaudeAdapter({
    resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
    spawnFn: makeCapturingSpawn<ClaudeSpawnFn>(captured.claude),
  });
  const codexAdapter = new CodexAdapter({
    resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
    spawnFn: makeCapturingSpawn<CodexSpawnFn>(captured.codex),
  });

  const sent: Envelope[] = [];
  const deps: TaskRunnerDeps = {
    adapters: [piAdapter, claudeAdapter, codexAdapter],
    workspaceRoot: await tmpDir('byok-taskrunner-env-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-env-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
  };
  const runner = new TaskRunner(deps);

  let seq = 1;
  const taskIds: string[] = [];

  async function offer(runtime: RuntimeId, taskId: string, dispatchSelection?: TaskOfferPayload['dispatchSelection']): Promise<void> {
    taskIds.push(taskId);
    // `adapter.start()` (and therefore the spawn call this test captures)
    // is awaited by `handleOffer` before `handleEnvelope` resolves, so the
    // capture below is always populated by the time this call returns —
    // no polling/`vi.waitFor` needed, unlike the full daemon-level tests.
    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'say hi', runtime, ...(dispatchSelection === undefined ? {} : { dispatchSelection }) }, { taskId, seq: seq++ }),
    );
  }

  async function cancelAll(): Promise<void> {
    await Promise.all(
      taskIds.map((taskId) =>
        runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'test cleanup' }, { taskId, seq: seq++ })),
      ),
    );
  }

  return { sent, captured, offer, cancelAll };
}

/** Sets `vars` on `process.env` for the duration of `fn`, restoring (or deleting, if previously unset) every one of them afterward — mirrors the save/set/restore convention already used throughout this suite (e.g. `claude-resolve-bin.test.ts`). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, original] of saved) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

describe('TaskRunner environment inheritance: real pi/claude/codex adapters via a spying spawnFn', () => {
  it.each(['runtime', 'subscription'] as const)('passes user config, provider keys and loader names to the real Codex %s child and drops CLAUDECODE and BYOK_*', async (lane) => {
    const home = await tmpDir('byok-codex-env-home-');
    const receiptPath = path.join(home, 'env-receipt.json');
    // Explicit literals ensure the check also fails when the shared inventory is incomplete.
    const credentialNames = [...new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', ...PROVIDER_CREDENTIAL_ENV_DENY_NAMES])];
    const refusedNames = ['CLAUDECODE', 'BYOK_UNKNOWN', 'BYOK_SDK_CUSTODY_LAUNCH_RECORD'];
    // The SDK no longer denies loader names: the user's own environment wins, as in OAR.
    const loaderNames = ['NODE_OPTIONS', 'BUN_ENV_SENTINEL', 'DYLD_ENV_SENTINEL', 'LD_ENV_SENTINEL'];
    const vars = {
      ...Object.fromEntries([...credentialNames, ...refusedNames, ...loaderNames].map((name) => [name, 'synthetic-sentinel'])),
      // The fake Codex child is a Node script; this option is inert there.
      NODE_OPTIONS: '--no-warnings',
      // macOS can synthesize this name inside Node after spawn. Supply the
      // platform config explicitly so the child's names remain measurable.
      ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: '0x0:0x0:0x0' } : {}),
      HOME: home, CODEX_HOME: home, USER: 'synthetic-user',
      MY_ALLOWED_CONFIG: 'synthetic-config',
      FAKE_CODEX_ENV_RECEIPT: receiptPath,
    };
    try {
      await withEnv(vars, async () => {
        const harness = await makeHarness();
        try {
          await harness.offer('codex', `task-codex-env-${lane}`, lane === 'subscription'
            ? { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'gpt-5' }
            : undefined);
          expect(harness.sent.some((e) => e.type === 'task.fail' || e.type === 'task.decline')).toBe(false);
          // Written by the fixture from its own process.env before initialize returns.
          const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as {
            present: Record<string, boolean>;
            configMatches: boolean;
            authDiscoveryMatches: boolean;
          };
          const spawnEnv = harness.captured.codex.env ?? {};
          for (const name of refusedNames) {
            expect(receipt.present[name] === true, name).toBe(false);
            expect(Object.hasOwn(spawnEnv, name), name).toBe(false);
          }
          for (const name of ['PATH', 'HOME', 'USER', 'CODEX_HOME', 'MY_ALLOWED_CONFIG', ...credentialNames, ...loaderNames]) {
            expect(spawnEnv[name] === process.env[name], name).toBe(true);
            // macOS dyld removes DYLD_* when the child execs through a
            // protected binary such as /usr/bin/env, so only the spawn
            // environment the SDK handed over can show it there.
            if (process.platform === 'darwin' && name.startsWith('DYLD_')) continue;
            expect(receipt.present[name], name).toBe(true);
          }
          expect(receipt.configMatches).toBe(true);
          expect(receipt.authDiscoveryMatches).toBe(true);
        } finally {
          await harness.cancelAll();
        }
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('passes an arbitrary user variable and provider keys to all three runtimes, and drops CLAUDECODE and BYOK_*', async () => {
    await withEnv(
      {
        MY_TEAM_SETTING: 'from-the-user-shell',
        ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
        OPENAI_API_KEY: 'sentinel-openai-key',
        CLAUDECODE: '1',
        BYOK_ANYTHING: 'must-never-leak',
      },
      async () => {
        const harness = await makeHarness();
        try {
          await harness.offer('pi', 'task-pi-env');
          await harness.offer('claude', 'task-claude-env');
          await harness.offer('codex', 'task-codex-env');

          expect(harness.sent.some((e) => e.type === 'task.fail')).toBe(false);

          for (const id of ['pi', 'claude', 'codex'] as const) {
            const env = harness.captured[id].env;
            expect(env, `${id} spawn should have received an env`).toBeDefined();
            expect(env?.PATH, id).toBe(process.env.PATH);
            expect(env?.HOME, id).toBe(process.env.HOME);
            expect(env?.MY_TEAM_SETTING, id).toBe('from-the-user-shell');
            expect(env?.ANTHROPIC_API_KEY, id).toBe('sentinel-anthropic-key');
            expect(env?.OPENAI_API_KEY, id).toBe('sentinel-openai-key');
            expect(env?.CLAUDECODE, id).toBeUndefined();
            expect(env?.BYOK_ANYTHING, id).toBeUndefined();
          }
        } finally {
          await harness.cancelAll();
        }
      },
    );
  });
});
