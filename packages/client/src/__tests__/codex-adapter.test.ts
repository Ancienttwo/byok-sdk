import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session, TaskContext } from '../types';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function fakeCodexAdapter(): CodexAdapter {
  return new CodexAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }) });
}

async function takeEvents(session: Session, count: number): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  for await (const event of session.events) {
    results.push(event);
    if (results.length >= count) break;
  }
  return results;
}

async function makeCtx(env: NodeJS.ProcessEnv = process.env): Promise<TaskContext> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-adapter-test-'));
  return { workspaceDir, policy: { mode: 'auto' }, env };
}

const baseTask: TaskOfferPayload = {
  instruction: 'say hi',
  policy: { mode: 'auto' },
};

describe('CodexAdapter against the fake-codex fixture', () => {
  const openSessions: Session[] = [];

  afterEach(async () => {
    await Promise.all(openSessions.splice(0).map((s) => s.close()));
    vi.restoreAllMocks();
  });

  it('detect() reports present + version + authPresent from the fake binary', async () => {
    const adapter = fakeCodexAdapter();
    const result = await adapter.detect();
    expect(result.present).toBe(true);
    expect(result.version).toBe('codex-cli 0.0.0-fake');
    expect(result.authPresent).toBe(true);
  });

  it('detect() reports authPresent:false when the fake binary reports not logged in', async () => {
    const adapter = fakeCodexAdapter();
    // detect() spawns the fake binary with `process.env` (via execFile's default), so toggling this
    // process's own env var is how the fixture's FAKE_CODEX_LOGGED_IN branch gets exercised here.
    const original = process.env.FAKE_CODEX_LOGGED_IN;
    process.env.FAKE_CODEX_LOGGED_IN = '0';
    try {
      const result = await adapter.detect();
      expect(result.present).toBe(true);
      expect(result.authPresent).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CODEX_LOGGED_IN;
      else process.env.FAKE_CODEX_LOGGED_IN = original;
    }
  });

  it('capabilities() advertises exactly what the adapter can express (no steer, resume yes, auto+readonly only)', () => {
    const adapter = fakeCodexAdapter();
    expect(adapter.capabilities()).toEqual({ steer: false, resume: true, permissionModes: ['auto', 'readonly'] });
  });

  it('start() resolves sessionRef from thread.started and drives the canned sequence into normalized AgentEvents', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    expect(session.sessionRef).toBe('fake-thread-1');

    const events = await takeEvents(session, 7);
    expect(events).toEqual([
      { type: 'error', message: 'Exceeded skills context budget of 2%. All skill descriptions were removed and 54 additional skills were not included in the model-visible skills list.' },
      { type: 'progress', text: 'Running the command now.' },
      { type: 'tool_use', tool: 'command_execution', input: { command: '/bin/sh -c "echo hi"' } },
      {
        type: 'tool_result',
        tool: 'command_execution',
        output: { command: '/bin/sh -c "echo hi"', aggregatedOutput: 'hi\n', exitCode: 0, status: 'completed' },
      },
      { type: 'progress', text: 'Done.' },
      // Pre-freeze protocol addition: turn.completed.usage now maps to a
      // usage AgentEvent (emitted before turn_end — see events.ts's
      // mapCodexEventToAgentEvents doc comment on why the ordering matters).
      { type: 'usage', inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
      { type: 'turn_end' },
    ]);
  });

  it('a task.offer carrying a known sessionRef resumes via `codex exec resume`, keeping the same sessionRef', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_THREAD_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await adapter.start(task, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('resume-me-123');
    await takeEvents(session, 7); // drain the full turn, including the trailing usage + turn_end
  });

  it('an unresolvable sessionRef surfaces codex\'s real resume rejection as a clean start() failure, not a hang', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx(); // FAKE_CODEX_THREAD_ID defaults to 'fake-thread-1' — this ref never matches it
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/no rollout found/);
  });

  it('fails closed (never a fabricated sessionRef) when codex does not yield thread.started as its first event', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_NO_THREAD_STARTED: '1' });
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/did not yield thread\.started/);
  });

  it('surfaces stderr context in the start() failure when codex exits immediately (bad-flag/crash shape)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_CRASH_WITH_STDERR: 'Error: Unknown option: --bogus' });
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/Unknown option: --bogus/);
  });

  it('maps a turn.failed turn to an error AgentEvent and ends the stream without a turn_end (task-runner.ts then reports task.fail)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_TURN_FAILS: '1', FAKE_CODEX_FAIL_MESSAGE: 'model rejected the request' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    // 4 mapped events total: the always-present skills-budget notice, the
    // "attempting..." progress message, the top-level error, and
    // turn.failed's own error — never a turn_end. `takeEvents` bounds the
    // read so this can never hang even if the count assumption is wrong.
    const events = await takeEvents(session, 4);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(events).toContainEqual({ type: 'progress', text: 'attempting...' });
    expect(events).toContainEqual({ type: 'error', message: 'model rejected the request' });
  });

  it('FAKE_CODEX_ARTIFACT_NAME drives a real file write + an artifact AgentEvent with a workspace-relative name', async () => {
    const adapter = fakeCodexAdapter();
    const artifactName = 'output/result.txt';
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_ARTIFACT_NAME: artifactName, FAKE_CODEX_ARTIFACT_CONTENT: 'artifact body\n' });
    await fs.mkdir(path.join(ctx.workspaceDir, 'output'), { recursive: true });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    // 10 mapped events: skills-budget error, progress, tool_use+tool_result
    // for the shell command, tool_use+(tool_result+artifact) for the file
    // change, a final progress, then usage, then turn_end.
    const events = await takeEvents(session, 10);
    const artifactEvent = events.find((e) => e.type === 'artifact');
    expect(artifactEvent).toEqual({ type: 'artifact', name: artifactName, contentType: 'text/plain' });
    expect(events).toContainEqual({ type: 'turn_end' });

    const written = await fs.readFile(path.join(ctx.workspaceDir, artifactName), 'utf8');
    expect(written).toBe('artifact body\n');
  });

  it('followUp() spawns a new resume turn and pushes more events into the same events stream', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 7); // drain the first turn (including usage + turn_end)

    await session.followUp({ instruction: 'now do more', policy: { mode: 'auto' } });
    const followUpEvents = await takeEvents(session, 7);
    expect(followUpEvents).toContainEqual({ type: 'turn_end' });
    expect(followUpEvents.filter((e) => e.type === 'turn_end')).toHaveLength(1);
    expect(followUpEvents).toContainEqual({ type: 'usage', inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 });
  });

  it('followUp() fails closed on a policy codex cannot express, without disturbing the already-open session', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 7);

    await expect(session.followUp({ instruction: 'x', policy: { mode: 'confirm' } })).rejects.toThrow(/cannot express permission mode "confirm"/);
  });

  it('followUp() fails closed on a blob-ref instruction', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 7);

    await expect(
      session.followUp({
        instruction: { blobRef: { blobId: 'b1', contentHash: 'sha256:x', size: 10, contentType: 'text/plain' } },
        policy: { mode: 'auto' },
      }),
    ).rejects.toThrow(/only supports string instructions/);
  });

  it('fails closed on a policy codex cannot express, without ever spawning a process', async () => {
    const spawnFn = vi.fn();
    const adapter = new CodexAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }), spawnFn: spawnFn as never });
    const ctx = await makeCtx();
    ctx.policy = { mode: 'plan' };
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/cannot express permission mode "plan"/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('fails closed on a blob-ref instruction at start() (no blob fetch in M2)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const task: TaskOfferPayload = {
      ...baseTask,
      instruction: { blobRef: { blobId: 'b1', contentHash: 'sha256:x', size: 10, contentType: 'text/plain' } },
    };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/only supports string instructions/);
  });

  it('interrupt() SIGTERMs a hanging turn and close() tears it down cleanly (no hang, no orphaned process)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_HANG: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    // Only the benign skills-budget notice arrives before the fixture hangs.
    const events = await takeEvents(session, 1);
    expect(events).toEqual([
      { type: 'error', message: 'Exceeded skills context budget of 2%. All skill descriptions were removed and 54 additional skills were not included in the model-visible skills list.' },
    ]);

    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('close() is idempotent', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 7);
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('steer() throws honestly rather than silently no-op-ing (codex exec has no in-band mid-turn channel)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await expect(session.steer('inject this')).rejects.toThrow(/does not support steer/);
  });

  it('resolveApproval() throws honestly rather than silently no-op-ing (codex exec never emits needs_approval)', async () => {
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await expect(session.resolveApproval(true)).rejects.toThrow(/does not support approval resume/);
  });

  it('unmapped-frame accounting: a genuinely unrecognized frame type does not break the stream and is logged once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeCodexAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CODEX_UNMAPPED_TYPE: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 7); // the 2 unmapped frames are silently absorbed, not pushed
    expect(events.every((e) => (e as { type: string }).type !== undefined)).toBe(true);
    expect(events).toContainEqual({ type: 'turn_end' });

    const unmappedWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('no AgentEvent mapping'));
    expect(unmappedWarnings.length).toBeGreaterThanOrEqual(2); // one for the unknown item type, one for the unknown top-level type
  });
});

describe('CodexAdapter against the real installed codex binary (no auth.json read, no network/model call required)', () => {
  it('detect() returns a well-formed result whether or not codex is actually installed here', async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.detect();
    expect(typeof result.present).toBe('boolean');
    if (result.present) {
      expect(typeof result.version).toBe('string');
      expect(result.version?.length).toBeGreaterThan(0);
      expect(typeof result.authPresent).toBe('boolean');
    }
  });
});
