import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import { SteerUnsupportedError, type Session } from '../types';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { observationOf } from './fixtures/mcp-observation';
import { launchArgvPrefix, trustedLaunchBinding } from './fixtures/launch-cwd';

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

async function takeTurn(session: Session): Promise<AgentEvent[]> {
  const events: AgentEvent[]=[];
  for await (const event of session.events) { events.push(event); if(event.type==='turn_end')break; }
  return events;
}

async function makeCtx(env: NodeJS.ProcessEnv = process.env): Promise<PreparedOperationResources> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-adapter-test-'));
  return { workspaceDir, policy: { mode: 'auto' }, env };
}

async function startAdapter(adapter: ClaudeAdapter, task: TaskOfferPayload, resources: PreparedOperationResources): Promise<Session> {
  return startPreparedOperation(adapter, task, resources);
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
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') throw new Error('expected available runtime');
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
      expect(result.kind).toBe('available');
      if (result.kind !== 'available') throw new Error('expected available runtime');
      expect(result.authPresent).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL;
      else process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL = original;
    }
  });

  it('cross-model review (Fix 4): detect() reports timeout within the deadline when the fake `--version` hangs', async () => {
    const adapter = fakeClaudeAdapter();
    const original = process.env.FAKE_CLAUDE_VERSION_HANG;
    process.env.FAKE_CLAUDE_VERSION_HANG = '1';
    try {
      const result = await adapter.detect();
      expect(result.kind).toBe('timeout');
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
      expect(result.kind).toBe('available');
      if (result.kind !== 'available') throw new Error('expected available runtime');
      expect(result.authPresent).toBe(false);
    } finally {
      if (original === undefined) delete process.env.FAKE_CLAUDE_AUTH_HANG;
      else process.env.FAKE_CLAUDE_AUTH_HANG = original;
    }
  }, 8000);

  it('descriptor advertises exactly what was empirically confirmed (no mid-turn steer, resume yes, confirm rejected)', () => {
    const adapter = fakeClaudeAdapter();
    expect(adapter.descriptor.capabilities).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      permissionModes: ['auto', 'readonly', 'plan'],
    });
  });

  it('rejects confirm in prepare before bin resolution, spawn or helper side effects', async () => {
    const resolveBin = vi.fn(() => ({ command: FIXTURE_PATH, source: 'path' as const }));
    const adapter = new ClaudeAdapter({ resolveBin });
    const ctx = await makeCtx();
    ctx.policy = { mode: 'confirm' };
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/confirm/i);
    expect(resolveBin).not.toHaveBeenCalled();
  });

  it('descriptor declares no credential env vars (M5 — deliberate ToS posture: env-based API key passthrough for claude is a separate, pending product decision)', () => {
    const adapter = fakeClaudeAdapter();
    expect(adapter.descriptor.environmentRequirements).toEqual({ credentialNames: [] });
  });

  it('start() drives the canned prompt sequence into normalized AgentEvents (Bash tool_use/tool_result, progress, turn_end)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    expect(typeof session.sessionRef).toBe('string');
    expect(session.sessionRef).toBe('fake-claude-session-1');

    const events = await takeEvents(session, 5);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' }, toolCallId: 'toolu_fake_1' },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n' }, toolCallId: 'toolu_fake_1', isError: false },
      { type: 'progress', text: 'reply-1:say hi' },
      // Pre-freeze protocol addition: the result frame's usage now maps to
      // a usage AgentEvent (emitted before turn_end — see events.ts's
      // mapResult doc comment on why the ordering matters).
      { type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 },
      { type: 'turn_end' },
    ]);
  });

  it('passes the subscription selection model to Claude without provider credentials', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
      spawnFn: ((command: string, args: string[], options: object) => {
        calls.push({ args: [...args], env: (options as { env?: NodeJS.ProcessEnv }).env ?? {} });
        return realSpawn(command, args, options);
      }) as never,
    });
    const session = await startAdapter(adapter,
      {
        ...baseTask,
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'claude',
          providerId: null,
          modelId: 'opus',
        },
      },
      await makeCtx({ ...process.env, OPENAI_API_KEY: 'sk-sentinel' }),
    );
    openSessions.push(session);
    expect(calls[0]?.args).toContain('--model');
    expect(calls[0]?.args[calls[0].args.indexOf('--model') + 1]).toBe('opus');
    expect(calls[0]?.env.OPENAI_API_KEY).toBeUndefined();
    await expect(session.followUp({
      instruction: 'switch model',
      policy: { mode: 'auto' },
      dispatchSelection: {
        lane: 'subscription',
        runtimeId: 'claude',
        providerId: null,
        modelId: 'sonnet',
      },
    })).rejects.toThrow(/persistent session cannot change model/);
  });

  it('a task.offer carrying a known sessionRef resumes via the real --resume flag, matching session_id', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_SESSION_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await startAdapter(adapter, task, ctx);
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
    let failure: unknown;
    try {
      await startAdapter(adapter, task, ctx);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
    expect(failure).toHaveProperty('message', expect.stringMatching(/echoed a different session id than requested/));
  });

  it('an unresolvable sessionRef surfaces claude\'s real resume rejection as a clean start() failure, not a hang (empirically confirmed against real claude: "No conversation found with session ID: ...", exit 1)', async () => {
    const adapter = fakeClaudeAdapter();
    // FAKE_CLAUDE_SESSION_ID defaults to 'fake-claude-session-1' — this ref never matches it.
    const ctx = await makeCtx();
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(startAdapter(adapter, task, ctx)).rejects.toThrow(/No conversation found with session ID/);
  });

  it('surfaces a bad-flag-class crash\'s stderr in the start() failure (finding #1-class failure, mirroring the pi adapter\'s own stderr-ring-buffer finding)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_CRASH_WITH_STDERR: 'error: simulated crash for stderr-capture test' });
    let failure: unknown;
    try {
      await startAdapter(adapter, baseTask, ctx);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'infrastructure', retry: 'retryable' });
    expect(failure).toHaveProperty('message', expect.stringMatching(/simulated crash for stderr-capture test/));
  });

  it('surfaces task-scoped MCP cleanup failure as typed disposal evidence and permits a clean retry', async () => {
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
    });
    const ctx = await makeCtx();
    ctx.mcpServers = { byokagentmessage: { command: '/bin/true' } };
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('fixture cleanup denial'));

    const failure = await session.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeDisposalFailure);
    expect(failure).toMatchObject({ stage: 'cleanup' });
    rm.mockRestore();
    await expect(session.close()).resolves.toBeUndefined();
    openSessions.pop();
  });

  it('projects task-scoped local MCP servers through one strict config without enabling the approval tool', async () => {
    const spawnCalls: { args: string[] }[] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
      spawnFn: ((command: string, args: readonly string[] = [], options: object = {}) => {
        const argsArray = [...args];
        spawnCalls.push({ args: argsArray });
        return realSpawn(command, argsArray, options);
      }) as unknown as SpawnFn,
    });
    const ctx = await makeCtx();
    ctx.mcpServers = {
      salesko: { command: process.execPath, args: ['/opt/salesko/fake-mcp.mjs'], env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' } },
    };
    ctx.mcpToolsetTools = observationOf({ salesko: ['find_leads'] });

    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--permission-prompt-tool');
    // The projected server's observed tool is pre-granted (real claude
    // auto-denies an ungranted MCP tool), and nothing else is. The
    // observation itself never enters the generated config file, which stays
    // exactly the MCP authority claude understands.
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__salesko__find_leads');
    const configPath = args[args.indexOf('--mcp-config') + 1];
    if (typeof configPath !== 'string') throw new Error('missing mcp config path');
    // claude spawns this server itself and `mcpServers` has no cwd field, so
    // the operator's command/args are reached through the SDK's launcher,
    // which chdirs into the daemon's proven-non-writable directory first. The
    // operator's own argv is preserved position-for-position after it, and the
    // task-scoped env is untouched.
    const launch = await trustedLaunchBinding();
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        salesko: {
          command: launch.launcher!.interpreter,
          args: [...launchArgvPrefix(launch), process.execPath, '/opt/salesko/fake-mcp.mjs'],
          env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' },
        },
      },
    });

    await session.close();
    openSessions.pop();
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('refuses a toolset server whose command is a bare name with the launcher rule that rejected it, before any spawn', async () => {
    const spawnFn = vi.fn();
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
      spawnFn: spawnFn as unknown as SpawnFn,
    });
    const ctx = await makeCtx();
    // A PATH lookup performed after the chdir is not the identity the binding
    // attested, so the launcher wrapper refuses it. The refusal must reach
    // TaskRunner as this adapter's own typed start failure: an untyped throw
    // is projected as a generic adapter contract violation, which hides the
    // rule that refused and leaves the operator with nothing to fix.
    ctx.mcpServers = { salesko: { command: 'npx', args: ['@salesko/mcp'] } };
    ctx.mcpToolsetTools = observationOf({ salesko: ['find_leads'] });

    const failure = await startAdapter(adapter, baseTask, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    expect((failure as RuntimeExecutionFailure).message).toMatch(/launch_cwd_target_command_not_absolute/u);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('prepares a valid blob-ref without fetching it; TaskRunner resolves its string after claim', async () => {
    const adapter = fakeClaudeAdapter();
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

  it('FAKE_CLAUDE_HANG_AFTER_TOOL keeps the session running past the tool call; interrupt ACK + close tear it down cleanly', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_HANG_AFTER_TOOL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 2);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' }, toolCallId: 'toolu_fake_1' },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n' }, toolCallId: 'toolu_fake_1', isError: false },
    ]);

    // No turn_end ever arrives on its own — mirrors the daemon's real cancel
    // path (task-runner.ts's handleCancel), which never waits on drained
    // events: bounded native interrupt ACK + close must still resolve cleanly.
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('native interrupt sends a correlated control request and keeps the process alive until close', async () => {
    let pid=0;
    const adapter=new ClaudeAdapter({resolveBin:()=>({command:FIXTURE_PATH,source:'path'}),spawnFn:((...args:Parameters<typeof realSpawn>)=>{const child=realSpawn(...args);pid=child.pid??0;return child;}) as typeof realSpawn});
    const ctx=await makeCtx();ctx.env={...ctx.env,FAKE_CLAUDE_HANG_AFTER_TOOL:'1'};
    const receipt=path.join(ctx.workspaceDir,'interrupt.json');ctx.env.FAKE_CLAUDE_CONTROL_RECEIPT=receipt;
    const session=await startAdapter(adapter,baseTask,ctx);openSessions.push(session);
    await session.interrupt();
    const frame=JSON.parse(await fs.readFile(receipt,'utf8'));
    expect(frame).toMatchObject({type:'control_request',request:{subtype:'interrupt'}});expect(typeof frame.request_id).toBe('string');
    expect(()=>process.kill(pid,0)).not.toThrow();
    const events=await takeTurn(session);expect(events.some(e=>e.type==='error')).toBe(false);expect(events.at(-1)?.type).toBe('turn_end');
  });
  it('missing interrupt ACK reaches owned termination fallback within the configured deadline', async () => {
    let pid=0;const adapter=new ClaudeAdapter({resolveBin:()=>({command:FIXTURE_PATH,source:'path'}),interruptTimeoutMs:40,spawnFn:((...args:Parameters<typeof realSpawn>)=>{const child=realSpawn(...args);pid=child.pid??0;return child;}) as typeof realSpawn});
    const ctx=await makeCtx();ctx.env={...ctx.env,FAKE_CLAUDE_HANG_AFTER_TOOL:'1',FAKE_CLAUDE_INTERRUPT_NO_ACK:'1'};
    const session=await startAdapter(adapter,baseTask,ctx);openSessions.push(session);
    await session.interrupt();expect(()=>process.kill(pid,0)).toThrow();await session.close();
  });
  it('ACK does not synthesize terminal completion; a late real result remains a runtime fact', async () => {
    const ctx=await makeCtx();ctx.env={...ctx.env,FAKE_CLAUDE_HANG_AFTER_TOOL:'1',FAKE_CLAUDE_INTERRUPT_LATE_SUCCESS:'1',FAKE_CLAUDE_INTERRUPT_RESULT_DELAY_MS:'40'};
    const session=await startAdapter(fakeClaudeAdapter(),baseTask,ctx);openSessions.push(session);
    await session.interrupt();const events=await takeTurn(session);expect(events.at(-1)?.type).toBe('turn_end');expect(events.some(e=>e.type==='error')).toBe(false);
  });

  it('interrupt during the tool phase (terminal_reason aborted_tools) ends the turn at turn_end with no error', async () => {
    const ctx=await makeCtx();ctx.env={...ctx.env,FAKE_CLAUDE_HANG_AFTER_TOOL:'1',FAKE_CLAUDE_INTERRUPT_TERMINAL_REASON:'aborted_tools'};
    const session=await startAdapter(fakeClaudeAdapter(),baseTask,ctx);openSessions.push(session);
    await session.interrupt();const events=await takeTurn(session);expect(events.at(-1)?.type).toBe('turn_end');expect(events.some(e=>e.type==='error')).toBe(false);
  });

  it('a denied (headless auto-deny) tool call surfaces tool_result with isError:true, and the run still completes to turn_end — never a hang, never a paused needs_approval-style event', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_DENY: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events[0]).toEqual({ type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' }, toolCallId: 'toolu_fake_1' });
    expect(events[1]).toMatchObject({ type: 'tool_result', tool: 'Bash', toolCallId: 'toolu_fake_1', isError: true });
    expect(events[2]).toEqual({ type: 'progress', text: 'reply-1:say hi' });
    expect(events[3]).toEqual({ type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 });
    expect(events[4]).toEqual({ type: 'turn_end' });
  });

  it('cross-model re-review (P1 regression): a malformed claude `result` (missing is_error) ends THIS TURN\'s event stream as a failure — never a hang, even though the persistent claude process itself stays alive awaiting a possible followUp', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_RESULT_MALFORMED: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
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
    let failure: unknown;
    try {
      for await (const event of session.events) events.push(event);
    } catch (error) {
      failure = error;
    }

    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    const lastEvent = events[events.length - 1] as { type: string; message?: string };
    expect(lastEvent.type).toBe('error');
    expect(lastEvent.message).toMatch(/missing\/invalid is_error flag/);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'run', category: 'authority', retry: 'non-retryable' });
  }, 5000);

  it('followUp() sends a new turn on the SAME persistent process/session, confirmed by an unchanged sessionRef and a second full event cycle', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const firstTurn = await takeEvents(session, 5);
    expect(firstTurn[2]).toEqual({ type: 'progress', text: 'reply-1:say hi' });
    expect(firstTurn[3]).toEqual({ type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 });
    expect(firstTurn[4]).toEqual({ type: 'turn_end' });

    await session.followUp({ instruction: 'say bye', policy: { mode: 'auto' } });

    const secondTurn = await takeEvents(session, 5);
    expect(secondTurn).toEqual([
      { type: 'tool_use', tool: 'Bash', input: { command: 'echo hi' }, toolCallId: 'toolu_fake_2' },
      { type: 'tool_result', tool: 'Bash', output: { content: 'hi\n' }, toolCallId: 'toolu_fake_2', isError: false },
      { type: 'progress', text: 'reply-2:say bye' },
      { type: 'usage', inputTokens: 15, cachedInputTokens: 0, outputTokens: 20 },
      { type: 'turn_end' },
    ]);

    expect(session.sessionRef).toBe('fake-claude-session-1');
  });

  it('followUp() fails closed on a blob-ref instruction, same as start()', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 5); // drain the full turn, including the trailing usage + turn_end

    await expect(
      session.followUp({ instruction: { blobRef: { blobId: 'b', contentHash: 'sha256:x', size: 1, contentType: 'text/plain' } }, policy: { mode: 'auto' } }),
    ).rejects.toThrow(/only supports string instructions/);
  });

  it('emits an artifact AgentEvent for a Write inside the workspace, with a workspace-relative name, and the file genuinely exists on disk', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_ARTIFACT_PATH: 'out.txt', FAKE_CLAUDE_ARTIFACT_CONTENT: 'artifact-body' });
    const session = await startAdapter(adapter, baseTask, ctx);
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
      { type: 'tool_use', tool: 'Write', input: { file_path: path.join(realWorkspaceDir, 'out.txt'), content: 'artifact-body' }, toolCallId: 'toolu_fake_1' },
      {
        type: 'tool_result',
        tool: 'Write',
        output: { content: `File created successfully at: ${path.join(realWorkspaceDir, 'out.txt')}` },
        toolCallId: 'toolu_fake_1',
        isError: false,
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
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 5);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'progress', 'usage', 'turn_end']);
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
  });

  it('resolveApproval() throws a descriptive not-supported error rather than silently no-op\'ing for every Claude session', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    await expect(session.resolveApproval(true)).rejects.toThrow(/does not support interactive approval/);
  });

  it('steer() throws a typed SteerUnsupportedError (mid-turn stdin writes were empirically found to queue, not redirect)', async () => {
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    // Typed, not string-matched: the daemon classifies this as permanently
    // unsupported (non-retryable) rather than a transient handler failure.
    await expect(session.steer('change course')).rejects.toBeInstanceOf(SteerUnsupportedError);
    await expect(session.steer('change course')).rejects.toThrow(/does not support mid-turn steering/);
    await expect(session.steer('change course')).rejects.toMatchObject({ runtimeId: 'claude' });
  });

  it('records an unmapped top-level frame type once, and still processes the rest of the turn normally', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_UNKNOWN_TOP_LEVEL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
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
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    await takeEvents(session, 5);

    const matching = warnSpy.mock.calls.filter((call) => String(call[0]).includes('system:totally_novel_subtype'));
    expect(matching).toHaveLength(1);
  });

  it('records an unmapped assistant content-block type once, without dropping the real text block in the same frame', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = fakeClaudeAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
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
    expect(typeof result.kind).toBe('string');
    if (result.kind === 'available') {
      expect(typeof result.version).toBe('string');
      expect(result.version?.length).toBeGreaterThan(0);
      expect(typeof result.authPresent).toBe('boolean');
    }
  });
});
