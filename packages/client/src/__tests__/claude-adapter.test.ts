import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { Session, TaskContext } from '../types';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function fakeClaudeAdapter(): ClaudeAdapter {
  return new ClaudeAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }) });
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
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-adapter-test-'));
  return { workspaceDir, policy: { mode: 'auto' }, env };
}

const baseTask: TaskOfferPayload = {
  instruction: 'say hi',
  policy: { mode: 'auto' },
};

describe('ClaudeAdapter against the fake-claude fixture', () => {
  const openSessions: Session[] = [];

  afterEach(async () => {
    await Promise.all(openSessions.splice(0).map((s) => s.close()));
    vi.restoreAllMocks();
  });

  it('detect() reports present + version + authPresent from the fake binary', async () => {
    const adapter = fakeClaudeAdapter();
    const result = await adapter.detect();
    expect(result.present).toBe(true);
    expect(result.version).toBe('2.0.0-fake');
    expect(result.authPresent).toBe(true);
  });

  it('detect() reports authPresent:false when the fake `auth status --json` fails, without affecting present', async () => {
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
    });
    const original = process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL;
    process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL = '1';
    try {
      const result = await adapter.detect();
      expect(result.present).toBe(true);
      expect(result.authPresent).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL;
      else process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL = original;
    }
  });

  it('cross-model review (Fix 4): detect() fails closed (present:false) within the timeout when the fake `--version` hangs', async () => {
    const adapter = fakeClaudeAdapter();
    const original = process.env.FAKE_CLAUDE_VERSION_HANG;
    process.env.FAKE_CLAUDE_VERSION_HANG = '1';
    try {
      const result = await adapter.detect();
      expect(result.present).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CLAUDE_VERSION_HANG;
      else process.env.FAKE_CLAUDE_VERSION_HANG = original;
    }
  }, 8000);

  it('cross-model review (Fix 4): detect() fails closed (authPresent:false, present still true) within the timeout when the fake `auth status` hangs', async () => {
    const adapter = fakeClaudeAdapter();
    const original = process.env.FAKE_CLAUDE_AUTH_HANG;
    process.env.FAKE_CLAUDE_AUTH_HANG = '1';
    try {
      const result = await adapter.detect();
      expect(result.present).toBe(true);
      expect(result.authPresent).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CLAUDE_AUTH_HANG;
      else process.env.FAKE_CLAUDE_AUTH_HANG = original;
    }
  }, 8000);

  it('capabilities() advertises exactly what was empirically confirmed (no mid-turn steer, resume yes, confirm mode excluded)', () => {
    const adapter = fakeClaudeAdapter();
    expect(adapter.capabilities()).toEqual({ steer: false, resume: true, permissionModes: ['auto', 'readonly', 'plan'] });
  });

  it('start() drives the canned prompt sequence into normalized AgentEvents (Bash tool_use/tool_result, progress, turn_end)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    expect(typeof session.sessionRef).toBe('string');
    expect(session.sessionRef).toBe('fake-claude-session-1');

    const events = await takeEvents(session, 5);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n', isError: false } },
      { type: 'progress', text: 'reply-1:say hi' },
      // Pre-freeze protocol addition: the result frame's usage now maps to
      // a usage AgentEvent (emitted before turn_end — see events.ts's
      // mapResult doc comment on why the ordering matters).
      { type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 },
      { type: 'turn_end' },
    ]);
  });

  it('a task.offer carrying a known sessionRef resumes via the real --resume flag, matching session_id', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_SESSION_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await adapter.start(task, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('resume-me-123');
  });

  it('cross-model review (Fix 2): fails closed when claude --resume echoes a session id different from the one requested (never silently continues in a possibly-wrong session)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({
      ...process.env,
      FAKE_CLAUDE_SESSION_ID: 'resume-me-123', // what the --resume-target validation checks against (so the resume itself "succeeds")
      FAKE_CLAUDE_REPORTED_SESSION_ID: 'some-other-session', // but system/init reports a DIFFERENT id
    });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/echoed a different session id than requested/);
  });

  it('an unresolvable sessionRef surfaces claude\'s real resume rejection as a clean start() failure, not a hang (empirically confirmed against real claude: "No conversation found with session ID: ...", exit 1)', async () => {
    const adapter = fakeClaudeAdapter();
    // FAKE_CLAUDE_SESSION_ID defaults to 'fake-claude-session-1' — this ref never matches it.
    const ctx = await makeCtx();
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/No conversation found with session ID/);
  });

  it('surfaces a bad-flag-class crash\'s stderr in the start() failure (finding #1-class failure, mirroring the pi adapter\'s own stderr-ring-buffer finding)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_CRASH_WITH_STDERR: 'error: simulated crash for stderr-capture test' });
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/simulated crash for stderr-capture test/);
  });

  it('fails closed on a policy claude cannot express ("confirm"), without ever spawning a process', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    ctx.policy = { mode: 'confirm' };
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/cannot express permission mode "confirm"/);
  });

  it('fails closed on a blob-ref instruction (no blob fetch in M2)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const task: TaskOfferPayload = {
      ...baseTask,
      instruction: { blobRef: { blobId: 'b1', contentHash: 'sha256:x', size: 10, contentType: 'text/plain' } },
    };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/only supports string instructions/);
  });

  it('FAKE_CLAUDE_HANG_AFTER_TOOL keeps the session running past the tool call; interrupt()+close() still tear it down cleanly via SIGTERM', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_HANG_AFTER_TOOL: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 2);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n', isError: false } },
    ]);

    // No turn_end ever arrives on its own — mirrors the daemon's real cancel
    // path (task-runner.ts's handleCancel), which never waits on drained
    // events: interrupt() (SIGTERM) + close() must still resolve cleanly.
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('a denied (headless auto-deny) tool call surfaces tool_result with isError:true, and the run still completes to turn_end — never a hang, never a paused needs_approval-style event', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_DENY: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events[0]).toEqual({ type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' } });
    expect(events[1]).toMatchObject({ type: 'tool_result', tool: 'Bash', output: { isError: true } });
    expect(events[2]).toEqual({ type: 'progress', text: 'reply-1:say hi' });
    expect(events[3]).toEqual({ type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 });
    expect(events[4]).toEqual({ type: 'turn_end' });
  });

  it('cross-model re-review (P1 regression): a malformed claude `result` (missing is_error) ends THIS TURN\'s event stream as a failure — never a hang, even though the persistent claude process itself stays alive awaiting a possible followUp', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_RESULT_MALFORMED: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    // A bare, UNBOUNDED for-await here is the whole point: pre-fix, claude's
    // own process never exits after `result` (it waits on stdin for a
    // possible followUp — see process-client.ts), `mapResult` maps a
    // malformed result to a plain `error` AgentEvent with no `turn_end`, and
    // nothing else ever ended `ClaudeSession.events`'s iterator — so this
    // loop hung forever (confirmed: reverting the claude-adapter.ts fix
    // reproduces this test timing out at the bound below instead of
    // resolving). Post-fix, the iterator itself ends once this turn's own
    // `result` frame has been fully drained, so this loop terminates well
    // under the timeout without the process ever being killed here.
    const events: AgentEvent[] = [];
    for await (const event of session.events) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    const lastEvent = events[events.length - 1] as { type: string; message?: string };
    expect(lastEvent.type).toBe('error');
    expect(lastEvent.message).toMatch(/missing\/invalid is_error flag/);
  }, 5000);

  it('followUp() sends a new turn on the SAME persistent process/session, confirmed by an unchanged sessionRef and a second full event cycle', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const firstTurn = await takeEvents(session, 5);
    expect(firstTurn[2]).toEqual({ type: 'progress', text: 'reply-1:say hi' });
    expect(firstTurn[3]).toEqual({ type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 });
    expect(firstTurn[4]).toEqual({ type: 'turn_end' });

    await session.followUp({ instruction: 'say bye', policy: { mode: 'auto' } });

    const secondTurn = await takeEvents(session, 5);
    expect(secondTurn).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n', isError: false } },
      { type: 'progress', text: 'reply-2:say bye' },
      { type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 },
      { type: 'turn_end' },
    ]);

    expect(session.sessionRef).toBe('fake-claude-session-1');
  });

  it('followUp() fails closed on a blob-ref instruction, same as start()', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 5); // drain the full turn, including the trailing usage + turn_end

    await expect(
      session.followUp({ instruction: { blobRef: { blobId: 'b', contentHash: 'sha256:x', size: 1, contentType: 'text/plain' } }, policy: { mode: 'auto' } }),
    ).rejects.toThrow(/only supports string instructions/);
  });

  it('emits an artifact AgentEvent for a Write inside the workspace, with a workspace-relative name, and the file genuinely exists on disk', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_ARTIFACT_PATH: 'out.txt', FAKE_CLAUDE_ARTIFACT_CONTENT: 'artifact-body' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    // The spawned child process's own `process.cwd()` (what the fixture
    // uses to build the absolute `file_path`/`filePath` it reports) is
    // POSIX-realpath-resolved regardless of which symlink alias `cwd` was
    // set to when spawning it — e.g. on macOS, `os.tmpdir()` itself is a
    // symlink (`/var/folders/... -> /private/var/folders/...`), so
    // `mkdtemp`'s own return value and the child's reported cwd can be two
    // different (but equally valid) spellings of the same real directory.
    // This is exactly the aliasing `events.ts`'s `tryBuildArtifactEvent`
    // resolves internally to still produce a correct workspace-relative
    // `artifact.name` (asserted below) — but the RAW `tool_use`/`tool_result`
    // strings this test also asserts must match what the child process
    // itself actually reported, hence resolving `ctx.workspaceDir` the
    // same way here for the expected values.
    const realWorkspaceDir = await fs.realpath(ctx.workspaceDir);

    const events = await takeEvents(session, 6);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'Write', input: { file_path: path.join(realWorkspaceDir, 'out.txt'), content: 'artifact-body' } },
      {
        type: 'tool_result',
        tool: 'Write',
        output: { content: `File created successfully at: ${path.join(realWorkspaceDir, 'out.txt')}`, isError: false },
      },
      { type: 'artifact', name: 'out.txt', contentType: 'text/plain' },
      { type: 'progress', text: 'reply-1:say hi' },
      { type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 },
      { type: 'turn_end' },
    ]);

    // Real, on-disk side effect (mirrors the actual daemon's own
    // sendArtifact() path, which reads the file back off disk by this same
    // workspace-relative name — see task-runner.ts's openArtifact()).
    const written = await fs.readFile(path.join(ctx.workspaceDir, 'out.txt'), 'utf8');
    expect(written).toBe('artifact-body');
  });

  it('never emits an artifact AgentEvent for a Write outside the workspace (plan-mode-style side effect), even though the tool_result itself still surfaces', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-adapter-outside-'));
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({
      ...process.env,
      FAKE_CLAUDE_ARTIFACT_PATH: path.join(outsideDir, 'plan.md'),
      FAKE_CLAUDE_ARTIFACT_CONTENT: 'plan-body',
    });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'progress', 'usage', 'turn_end']);
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
  });

  it('resolveApproval() throws a descriptive not-supported error rather than silently no-op\'ing (claude never emits needs_approval — see the adapter\'s own doc comment)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await expect(session.resolveApproval(true)).rejects.toThrow(/does not support approval resume/);
  });

  it('steer() throws a descriptive not-supported error (mid-turn stdin writes were empirically found to queue, not redirect)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await expect(session.steer('change course')).rejects.toThrow(/does not support mid-turn steering/);
  });

  it('records an unmapped top-level frame type once, and still processes the rest of the turn normally', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_UNKNOWN_TOP_LEVEL: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'progress', 'usage', 'turn_end']);

    const matching = warnSpy.mock.calls.filter((call) => String(call[0]).includes('top-level:totally_novel_top_level_frame'));
    expect(matching).toHaveLength(1);
  });

  it('records an unmapped system subtype once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_UNKNOWN_SYSTEM_SUBTYPE: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 5);

    const matching = warnSpy.mock.calls.filter((call) => String(call[0]).includes('system:totally_novel_subtype'));
    expect(matching).toHaveLength(1);
  });

  it('records an unmapped assistant content-block type once, without dropping the real text block in the same frame', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events).toContainEqual({ type: 'progress', text: 'reply-1:say hi' });

    const matching = warnSpy.mock.calls.filter((call) => String(call[0]).includes('assistant-block:totally_novel_block_type'));
    expect(matching).toHaveLength(1);
  });
});

describe('ClaudeAdapter against the real installed claude binary (no network/task dispatch required)', () => {
  it('detect() returns a well-formed result whether or not claude is actually installed on PATH here', async () => {
    const adapter = new ClaudeAdapter();
    const result = await adapter.detect();
    expect(typeof result.present).toBe('boolean');
    if (result.present) {
      expect(typeof result.version).toBe('string');
      expect(result.version?.length).toBeGreaterThan(0);
      expect(typeof result.authPresent).toBe('boolean');
    }
  });
});
