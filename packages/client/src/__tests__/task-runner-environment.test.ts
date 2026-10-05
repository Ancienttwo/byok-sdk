import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope, type RuntimeId, type TaskOfferPayload } from '@byok-sdk/protocol';
import {
  PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
} from '@byok-sdk/implementation-identity';
import { buildRuntimeEnv } from '../daemon/environment';
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
 * M5 acceptance: `TaskRunner` no longer builds `TaskContext.env` from
 * `process.env` verbatim (see `daemon/environment.ts`'s own doc comment) —
 * it builds a per-runtime allowlist from whichever adapter `pickAdapter`
 * selected. These tests drive the THREE REAL bundled adapters (against
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

async function makeHarness(runtimeEnvironment?: Record<string, { allow?: string[] }>): Promise<Harness> {
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
    runtimeEnvironment,
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
      createEnvelope('task.offer', { instruction: 'say hi', policy: { mode: 'auto' }, runtime, ...(dispatchSelection === undefined ? {} : { dispatchSelection }) }, { taskId, seq: seq++ }),
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

describe('TaskRunner environment allowlist (M5): real pi/claude/codex adapters via a spying spawnFn', () => {
  it.each(['runtime', 'subscription'] as const)('strips explicitly allowed Codex credentials in the real %s child while preserving measured config', async (lane) => {
    const home = await tmpDir('byok-codex-env-home-');
    const receiptPath = path.join(home, 'env-receipt.json');
    // Explicit literals ensure the guard also fails when the shared inventory is incomplete.
    const credentialNames = [...new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', ...PROVIDER_CREDENTIAL_ENV_DENY_NAMES])];
    const refusedNames = [
      ...credentialNames, 'BYOK_UNKNOWN', 'BYOK_SDK_CUSTODY_LAUNCH_RECORD',
      'BYOK_SDK_CUSTODY_PARENT_DEPTH', 'BYOK_SDK_CUSTODY_RUNNER_CONFIG',
      'NODE_OPTIONS', 'BUN_ENV_SENTINEL', 'DYLD_ENV_SENTINEL', 'LD_ENV_SENTINEL',
    ];
    const vars = {
      ...Object.fromEntries(refusedNames.map((name) => [name, 'synthetic-sentinel'])),
      // Detection probes still inherit parent env; this option is inert there.
      NODE_OPTIONS: '--no-warnings',
      // macOS can synthesize this name inside Node after spawn. Supply the
      // platform config explicitly so the child's names remain measurable.
      ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: '0x0:0x0:0x0' } : {}),
      HOME: home, CODEX_HOME: home, USER: 'synthetic-user',
      MY_ALLOWED_CONFIG: 'synthetic-config',
      FAKE_CODEX_ENV_RECEIPT: receiptPath,
      FAKE_CODEX_ENV_NAMES_DIGEST: '', FAKE_CODEX_ENV_LOADER_DIGEST: '',
    };
    try {
      await withEnv(vars, async () => {
        const allow = [...Object.keys(vars), 'PATH'];
        const measured = buildRuntimeEnv({
          ambient: process.env,
          requirements: new CodexAdapter().descriptor.environmentRequirements,
          locallyAllowedNames: allow,
        });
        // These are the same shared projections used by admission measurement.
        // Digest values do not affect the names digest, and are not loader inputs.
        process.env.FAKE_CODEX_ENV_NAMES_DIGEST = toolImplementationLaunchEnvNamesDigest(measured);
        process.env.FAKE_CODEX_ENV_LOADER_DIGEST = toolImplementationLoaderEnvValuesDigest(measured);
        const harness = await makeHarness({ codex: { allow } });
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
            namesDigestMatches: boolean;
            loaderDigestMatches: boolean;
          };
          const spawnEnv = harness.captured.codex.env ?? {};
          expect(toolImplementationLaunchEnvNamesDigest(spawnEnv as Record<string, string>) === process.env.FAKE_CODEX_ENV_NAMES_DIGEST).toBe(true);
          for (const name of refusedNames) {
            expect(receipt.present[name] === true, name).toBe(false);
            expect(Object.hasOwn(harness.captured.codex.env ?? {}, name), name).toBe(false);
          }
          for (const name of ['PATH', 'HOME', 'USER', 'CODEX_HOME', 'MY_ALLOWED_CONFIG']) {
            expect(receipt.present[name], name).toBe(true);
            expect(harness.captured.codex.env?.[name] === process.env[name], name).toBe(true);
          }
          expect(receipt.configMatches).toBe(true);
          expect(receipt.authDiscoveryMatches).toBe(true);
          expect(receipt.namesDigestMatches).toBe(true);
          expect(receipt.loaderDigestMatches).toBe(true);
        } finally {
          await harness.cancelAll();
        }
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('hides unrelated secrets (AWS/DB/GitHub) from all three runtimes, while pi still sees its own known provider credential and claude/codex do not', async () => {
    await withEnv(
      {
        AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret',
        DATABASE_URL: 'postgres://sentinel-leak',
        GITHUB_TOKEN: 'sentinel-gh-token',
        OPENAI_API_KEY: 'sentinel-openai-key', // a real entry in pi's KNOWN_PROVIDER_ENV_VARS
      },
      async () => {
        const harness = await makeHarness();
        try {
          await harness.offer('pi', 'task-pi-secrets');
          await harness.offer('claude', 'task-claude-secrets');
          await harness.offer('codex', 'task-codex-secrets');

          expect(harness.sent.some((e) => e.type === 'task.fail')).toBe(false);

          for (const id of ['pi', 'claude', 'codex'] as const) {
            const env = harness.captured[id].env;
            expect(env, `${id} spawn should have received an env`).toBeDefined();
            expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
            expect(env?.DATABASE_URL).toBeUndefined();
            expect(env?.GITHUB_TOKEN).toBeUndefined();
          }

          // pi authenticates via provider env vars — this one MUST keep flowing.
          expect(harness.captured.pi.env?.OPENAI_API_KEY).toBe('sentinel-openai-key');
          // claude/codex declare no credential env vars (deliberate ToS posture).
          expect(harness.captured.claude.env?.OPENAI_API_KEY).toBeUndefined();
          expect(harness.captured.codex.env?.OPENAI_API_KEY).toBeUndefined();
        } finally {
          await harness.cancelAll();
        }
      },
    );
  });

  it('hard-denies BYOK_* everywhere, even when a runtime explicitly lists it in its own local runtimeEnvironment.<id>.allow', async () => {
    await withEnv({ BYOK_ANYTHING: 'must-never-leak' }, async () => {
      const harness = await makeHarness({
        pi: { allow: ['BYOK_ANYTHING'] },
        claude: { allow: ['BYOK_ANYTHING'] },
        codex: { allow: ['BYOK_ANYTHING'] },
      });
      try {
        await harness.offer('pi', 'task-pi-byok');
        await harness.offer('claude', 'task-claude-byok');
        await harness.offer('codex', 'task-codex-byok');

        expect(harness.sent.some((e) => e.type === 'task.fail')).toBe(false);

        for (const id of ['pi', 'claude', 'codex'] as const) {
          const env = harness.captured[id].env;
          expect(env, `${id} spawn should have received an env`).toBeDefined();
          expect(env?.BYOK_ANYTHING).toBeUndefined();
        }
      } finally {
        await harness.cancelAll();
      }
    });
  });

  it('always includes PATH/HOME for every runtime, and honors a runtimeEnvironment.claude.allow entry for claude only', async () => {
    await withEnv({ MY_CUSTOM_CLAUDE_ONLY_VAR: 'hello-claude' }, async () => {
      const harness = await makeHarness({ claude: { allow: ['MY_CUSTOM_CLAUDE_ONLY_VAR'] } });
      try {
        await harness.offer('pi', 'task-pi-base');
        await harness.offer('claude', 'task-claude-base');
        await harness.offer('codex', 'task-codex-base');

        expect(harness.sent.some((e) => e.type === 'task.fail')).toBe(false);

        for (const id of ['pi', 'claude', 'codex'] as const) {
          const env = harness.captured[id].env;
          expect(env?.PATH).toBe(process.env.PATH);
          expect(env?.HOME).toBe(process.env.HOME);
        }

        expect(harness.captured.claude.env?.MY_CUSTOM_CLAUDE_ONLY_VAR).toBe('hello-claude');
        expect(harness.captured.pi.env?.MY_CUSTOM_CLAUDE_ONLY_VAR).toBeUndefined();
        expect(harness.captured.codex.env?.MY_CUSTOM_CLAUDE_ONLY_VAR).toBeUndefined();
      } finally {
        await harness.cancelAll();
      }
    });
  });
});
