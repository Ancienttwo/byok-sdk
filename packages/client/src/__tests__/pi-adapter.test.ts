import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { RuntimeExecutionFailure } from '../runtime-failure';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

function fakePiAdapter(): PiAdapter {
  return new PiAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }) });
}

async function takeEvents(session: Session, count: number): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  for await (const event of session.events) {
    results.push(event);
    if (results.length >= count) break;
  }
  return results;
}

async function makeCtx(env: NodeJS.ProcessEnv = process.env): Promise<PreparedOperationResources> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-adapter-test-'));
  return { workspaceDir, policy: { mode: 'auto' }, env };
}

async function startAdapter(adapter: PiAdapter, task: TaskOfferPayload, resources: PreparedOperationResources): Promise<Session> {
  return startPreparedOperation(adapter, task, resources);
}

const baseTask: TaskOfferPayload = {
  instruction: 'say hi',
  policy: { mode: 'auto' },
};

describe('PiAdapter against the fake-pi fixture', () => {
  const openSessions: Session[] = [];

  afterEach(async () => {
    await Promise.all(openSessions.splice(0).map((s) => s.close()));
  });

  it('detect() reports present + version from the fake binary', async () => {
    const adapter = fakePiAdapter();
    const result = await adapter.detect();
    expect(result.present).toBe(true);
    expect(result.version).toBe('0.0.0-fake');
  });

  it('detect() reports absent when a bundle cannot resolve its required external pi sidecar', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => {
        throw new Error('required pi sidecar is not embedded');
      },
    });
    await expect(adapter.detect()).resolves.toEqual({ present: false });
  });

  it('start() fails closed when the required package or explicit sidecar cannot resolve', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => {
        throw new Error('required pi runtime is unavailable');
      },
    });
    await expect(startAdapter(adapter, baseTask, await makeCtx())).rejects.toThrow(/required pi runtime is unavailable/);
  });

  it('start() drives the canned prompt sequence into normalized AgentEvents', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    expect(typeof session.sessionRef).toBe('string');
    expect(session.sessionRef.length).toBeGreaterThan(0);

    const events = await takeEvents(session, 5);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
      { type: 'turn_end' },
    ]);
  });

  it('classifies spawn unavailability as typed start infrastructure retryable', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn: (() => {
        throw new Error('spawn ENOENT');
      }) as never,
    });
    let failure: unknown;
    try {
      await startAdapter(adapter, baseTask, await makeCtx());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'infrastructure', retry: 'retryable' });
  });

  it('routes an authoritative BYOK selection through the credential launcher without a key in argv or env', async () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args], env: options?.env ?? {} });
      const separator = args.indexOf('--');
      return realSpawn(FIXTURE_PATH, args.slice(separator + 1), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
      byokLauncher: {
        command: '/opt/byok-pi-provider-launcher',
        profileDbPath: '/private/providers.sqlite',
        sessionDir: '/private/pi-sessions',
      },
    });
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };
    const session = await startAdapter(adapter,
      task,
      await makeCtx({ ...process.env, OPENAI_API_KEY: 'sk-sentinel' }),
    );
    openSessions.push(session);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/opt/byok-pi-provider-launcher');
    expect(calls[0]?.args).toEqual([
      '--pi-bin',
      FIXTURE_PATH,
      '--profile-db',
      '/private/providers.sqlite',
      '--session-dir',
      '/private/pi-sessions',
      '--provider',
      'openai',
      '--model',
      'gpt-5.2',
      '--',
      '--mode',
      'rpc',
    ]);
    expect(JSON.stringify(calls[0])).not.toContain('sk-sentinel');
    expect(calls[0]?.env.OPENAI_API_KEY).toBeUndefined();
    await expect(session.followUp({
      instruction: 'switch provider',
      policy: { mode: 'auto' },
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
      },
    })).rejects.toThrow(/cannot change its authoritative BYOK provider\/model/);
  });

  it('projects an explicit macOS keychain path to the launcher argv unchanged', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args] });
      const separator = args.indexOf('--');
      return realSpawn(FIXTURE_PATH, args.slice(separator + 1), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
      byokLauncher: {
        command: '/opt/byok-pi-provider-launcher',
        profileDbPath: '/private/providers.sqlite',
        sessionDir: '/private/pi-sessions',
        macosKeychainPath: '/Users/test/Library/Keychains/login.keychain-db',
      },
    });
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };

    const session = await startAdapter(adapter, task, await makeCtx());
    openSessions.push(session);

    expect(calls).toEqual([{
      command: '/opt/byok-pi-provider-launcher',
      args: [
        '--pi-bin',
        FIXTURE_PATH,
        '--profile-db',
        '/private/providers.sqlite',
        '--session-dir',
        '/private/pi-sessions',
        '--macos-keychain-path',
        '/Users/test/Library/Keychains/login.keychain-db',
        '--provider',
        'openai',
        '--model',
        'gpt-5.2',
        '--',
        '--mode',
        'rpc',
      ],
    }]);
  });

  it('validates the BYOK launcher at construction before prepare or spawn', () => {
    const spawnFn = (() => {
      throw new Error('spawn must not be reached');
    }) as never;
    const baseLauncher = {
      command: '/opt/byok-pi-provider-launcher',
      profileDbPath: '/private/providers.sqlite',
      sessionDir: '/private/pi-sessions',
    };

    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: 'login.keychain-db' },
    })).toThrow(/macosKeychainPath must be an absolute path/);
    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: '' },
    })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: '/private/login\n.keychain-db' },
    })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: {
        ...baseLauncher,
        args: ['--macos-keychain-path', '/private/other.keychain-db'],
      },
    })).toThrow(/reserved launcher argument --macos-keychain-path/);
  });

  it('fails closed before spawn when a BYOK selection has no credential launcher', async () => {
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };
    await expect(startAdapter(fakePiAdapter(), task, await makeCtx())).rejects.toThrow(
      /requires a configured credential-custody launcher/,
    );
  });

  it('FAKE_PI_ARTIFACT_NAME drives a >64KB file write + an artifact AgentEvent (M1-4 blob-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const artifactName = 'big-artifact.bin';
    const size = 70000; // > the 64KB inline-artifact limit
    const ctx = await makeCtx({
      ...process.env,
      FAKE_PI_ARTIFACT_NAME: artifactName,
      FAKE_PI_ARTIFACT_SIZE: String(size),
    });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 7);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
      { type: 'tool_use', tool: 'write', input: { path: artifactName, content: `<${size} bytes written by fake-pi>` }, toolCallId: 'call_artifact' },
      {
        type: 'tool_result',
        tool: 'write',
        output: { result: { content: [{ type: 'text', text: `Successfully wrote ${size} bytes to ${artifactName}` }] } }, toolCallId: 'call_artifact', isError: false,
      },
      { type: 'artifact', name: artifactName, contentType: 'application/octet-stream' },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
    ]);

    const written = await fs.readFile(path.join(ctx.workspaceDir, artifactName));
    expect(written.length).toBe(size);
  });

  it('FAKE_PI_HANG_AFTER_TOOL keeps the session Running past the tool call; interrupt()+close() still tear it down cleanly (M1-4 cancel-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_HANG_AFTER_TOOL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 2);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
    ]);

    // No turn_end ever arrives on its own — the daemon's cancel path doesn't
    // wait on it; interrupt() (best-effort) + close() (SIGTERM) must still
    // resolve cleanly, exactly as `TaskRunner.handleCancel`/`finish` rely on.
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('start() with no sessionRef resolves pi\'s real minted session id via get_state (not a locally-generated UUID)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'fixture-minted-session-xyz' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('fixture-minted-session-xyz');
  });

  it('fails closed (never a fabricated UUID) when get_state cannot yield an authoritative session id (finding F8)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_GET_STATE_FAIL: '1' });
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/did not yield an authoritative session id/);
  });

  it('emits the native retry diagnostic, then terminates with typed semantic non-retryable failure', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_AUTO_RETRY_FAIL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    const iterator = session.events[Symbol.asyncIterator]();
    const events = [];
    let failure: unknown;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch (error) {
      failure = error;
    }
    expect(events).toContainEqual({ type: 'error', message: 'provider still unavailable' });
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable' });
  });

  it('a task.offer carrying a known sessionRef resumes it via the real `--session <id>` flag', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await startAdapter(adapter, task, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('resume-me-123');
  });

  it('an unresolvable sessionRef surfaces pi\'s real resume rejection as a clean start() failure, not a hang (empirically confirmed against real pi: "No session found matching ...", exit 1)', async () => {
    const adapter = fakePiAdapter();
    // FAKE_PI_SESSION_ID defaults to 'fake-session-1' — this ref never matches it.
    const ctx = await makeCtx();
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(startAdapter(adapter, task, ctx)).rejects.toThrow(/No session found matching/);
  });

  it('interrupt() sends abort and the fake pi settles afterward', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    await takeEvents(session, 5); // drain the initial prompt's events first
    await expect(session.interrupt()).resolves.toBeUndefined();

    const postAbort = await takeEvents(session, 1);
    expect(postAbort).toEqual([{ type: 'turn_end' }]);
  });

  it('surfaces a missing-API-key rejection from the initial prompt as a clean start() failure', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_NO_KEY: '1' });
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/No API key found/);
  });

  it('fails closed on a policy pi cannot express, without ever spawning a process', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    ctx.policy = { mode: 'confirm' };
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/cannot express permission mode "confirm"/);
  });

  it('prepares a valid blob-ref without fetching it; TaskRunner resolves its string after claim', async () => {
    const adapter = fakePiAdapter();
    const task: TaskOfferPayload = {
      ...baseTask,
      instruction: { blobRef: { blobId: 'b1', contentHash: `sha256:${'0'.repeat(64)}`, size: 10, contentType: 'text/plain' } },
    };
    await expect(adapter.prepare({
      offer: task,
      policy: task.policy,
      descriptor: adapter.descriptor,
      requiredToolsetIds: [],
    })).resolves.toMatchObject({ kind: 'prepared' });
  });

  it('descriptor advertises exactly what the adapter can express', () => {
    const adapter = fakePiAdapter();
    expect(adapter.descriptor.capabilities).toEqual({
      steer: true,
      resume: true,
      // S0/H-002: pi has no needs_approval notion at all
      // (`PiSession.resolveApproval` throws unconditionally).
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    });
  });

  it('descriptor declares the known provider credential env vars — the same single source of truth detect() uses', () => {
    const adapter = fakePiAdapter();
    expect(adapter.descriptor.environmentRequirements).toEqual({
      credentialNames: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_OAUTH_TOKEN',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'AZURE_OPENAI_API_KEY',
        'DEEPSEEK_API_KEY',
        'GROQ_API_KEY',
        'MISTRAL_API_KEY',
        'OPENROUTER_API_KEY',
        'XAI_API_KEY',
        'ZAI_API_KEY',
      ],
    });
  });
});

describe('PiAdapter against the user-installed runtime (no network/API key required)', () => {
  it('detect() returns a well-formed result whether or not pi is actually installed here', async () => {
    const adapter = new PiAdapter();
    const result = await adapter.detect();
    expect(result).toMatchObject({ present: true, version: '0.84.1' });
  });
});
