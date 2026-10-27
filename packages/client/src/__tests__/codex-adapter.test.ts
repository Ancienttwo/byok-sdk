import type { RuntimeTaskInput } from '../types';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session, MessageDraftDelta } from '../types';
import {
  RuntimeExecutionFailure,
  RuntimeDisposalFailure,
  RuntimeStartupDisposalFailure,
} from '../runtime-failure';
import {
  startPreparedOperation,
  type PreparedOperationResources,
} from './fixtures/prepared-operation';
import * as processTree from '../adapters/process-tree';
import { observationOf } from './fixtures/mcp-observation';
import { CodexProjection } from '../adapters/codex/projection';
import * as vendoredProjection from '../../vendor/oar/c88a514/runtimes/codex/projection';
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex.mjs', import.meta.url),
);
const sessions: Session[] = [];
const dirs: string[] = [];
const task: RuntimeTaskInput = {
  instruction: 'hello',
};
function adapter(options: ConstructorParameters<typeof CodexAdapter>[0] = {}) {
  return new CodexAdapter({
    resolveBin: () => ({ command: fixture, source: 'path' }),
    ...options,
  });
}
async function ctx(
  env: NodeJS.ProcessEnv = {},
): Promise<PreparedOperationResources> {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'byok-codex-app-'),
  );
  dirs.push(workspaceDir);
  return {
    workspaceDir,
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env },
  };
}
async function open(
  a = adapter(),
  offer = task,
  resources?: PreparedOperationResources,
) {
  const session = await startPreparedOperation(
    a,
    offer,
    resources ?? (await ctx()),
  );
  sessions.push(session);
  return session;
}
/** Records the pid of each app-server the adapter spawns. */
function tracked() {
  const pids: number[] = [];
  const spawnFn = ((cmd: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    const child = spawn(cmd, args, options);
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  }) as typeof spawn;
  return { pids, spawnFn };
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
async function turn(s: Session) {
  const out: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const e of s.events) {
    out.push(e);
    if (e.type === 'turn_end') break;
  }
  return out;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('Codex persistent app-server adapter', () => {
  it('detects the pinned version, app-server and native auth', async () => {
    expect(await adapter().detect()).toEqual({
      kind: 'available',
      version: 'codex-cli 0.160.0',
      authPresent: true,
    });
  });
  it('keeps not-logged-in detection honest', async () => {
    vi.stubEnv('FAKE_CODEX_LOGGED_IN', '0');
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      authPresent: false,
    });
  });
  it('declares steer, resume, no interactive approval and YOLO-only auto', () => {
    expect(adapter().descriptor.capabilities).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      messageDraft: true,
    });
    // Codex reads MCP tools itself; the daemon takes no tools/list observation for it.
    expect(adapter().descriptor.requiresMcpToolsetToolObservation).not.toBe(true);
  });
  it.each(['codex-cli 0.161.0', 'codex-cli 1.0.0', 'codex-cli 0.159.1', 'codex-cli 0.160.0-alpha.1', 'codex 0.161.0'])('detect admits unqualified version %j with an advisory, never a refusal', async (output) => {
    vi.stubEnv('FAKE_CODEX_VERSION', output);
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      version: output,
      advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.160.0' },
    });
  });
  it('detect admits the qualified version without an advisory', async () => {
    const detected = await adapter().detect();
    expect(detected).toMatchObject({ kind: 'available', version: 'codex-cli 0.160.0' });
    expect(detected).not.toHaveProperty('advisory');
  });
  it('detect refuses a missing app-server subcommand', async () => {
    vi.stubEnv('FAKE_CODEX_NO_APP_SERVER', '1');
    expect(await adapter().detect()).toEqual({
      kind: 'refused',
      reason: 'app_server_unavailable',
    });
  });
  it('opens a native thread and projects structured command/progress/usage before terminal', async () => {
    const s = await open();
    expect(s.sessionRef).toBe('fake-thread-1');
    const events = await turn(s);
    expect(events).toContainEqual({
      type: 'tool_use',
      tool: 'command_execution',
      toolCallId: 'cmd-1',
      input: { command: 'echo hello' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      tool: 'command_execution',
      toolCallId: 'cmd-1',
      output: {
        command: 'echo hello',
        aggregatedOutput: 'hello\n',
        exitCode: 0,
        status: 'completed',
      },
    });
    expect(events).toContainEqual({
      type: 'progress',
      text: 'hello from fake codex',
    });
    expect(events.slice(-2)).toEqual([
      {
        type: 'usage',
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 2,
        contextTokens: 110, contextWindow: 10000, contextSource: 'provider',
      },
      { type: 'turn_end' },
    ]);
  });
  it('uses thread/resume without migrating thread identity', async () => {
    const s = await open(adapter(), { ...task, sessionRef: 'fake-thread-1' });
    expect(s.sessionRef).toBe('fake-thread-1');
    await turn(s);
  });
  it('refuses an unresolvable resume without hanging or fabricating id', async () => {
    const failure = await open(adapter(), { ...task, sessionRef: 'absent' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      message: expect.stringContaining('no rollout found'),
    });
  });
  it('keeps an unmatched resume failure retryable infrastructure', async () => {
    const failure = await open(
      adapter(),
      { ...task, sessionRef: 'absent' },
      await ctx({ FAKE_CODEX_RESUME_ERROR_CODE: '-32000' }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({
      phase: 'start',
      category: 'infrastructure',
      retry: 'retryable',
      message: expect.stringContaining('no rollout found'),
    });
  });
  it('rejects a resumed reply with a different authoritative thread id', async () => {
    await expect(
      open(
        adapter(),
        { ...task, sessionRef: 'fake-thread-1' },
        await ctx({ FAKE_CODEX_REPORTED_THREAD_ID: 'other' }),
      ),
    ).rejects.toThrow('different thread id');
  });
  it('does not fabricate a missing thread id', async () => {
    await expect(
      open(adapter(), task, await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' })),
    ).rejects.toThrow('no thread id');
  });
  it('startup crash gives typed failure and owned teardown', async () => {
    await expect(
      open(
        adapter(),
        task,
        await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: 'crash' }),
      ),
    ).rejects.toBeInstanceOf(RuntimeExecutionFailure);
  });
  it('marks an app-server exit during the open runtime_exited, and an open it did not end unknown (#869)', async () => {
    await expect(open(adapter(), task, await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: 'crash' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/crash/), failure: { class: 'runtime_exited' },
    });
    // The kernel kills the app-server itself when the open reply has no thread id.
    await expect(open(adapter(), task, await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/no thread id/), failure: { class: 'unknown' },
    });
    await expect(open(adapter({ operationTimeoutMs: 300 }), task, await ctx({ FAKE_CODEX_HANG_BEFORE_THREAD: '1' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/timed out/), failure: { class: 'unknown' },
    });
  });
  it('uses the sealed cwd with no exec skip-git arguments', async () => {
    const captures: string[][] = [];
    const resources = await ctx();
    const s = await open(
      adapter({
        spawnFn: ((
          cmd: string,
          args: string[],
          opts: Parameters<typeof spawn>[2],
        ) => {
          captures.push(args);
          return spawn(cmd, args, opts);
        }) as typeof spawn,
      }),
      task,
      resources,
    );
    await turn(s);
    expect(captures[0]).toContain('app-server');
    expect(captures[0]).not.toContain('exec');
    expect(captures[0]).not.toContain('--skip-git-repo-check');
  });
  it('makes the Agent home the Codex project root for a memory-reader run directory only (#317)', async () => {
    // Codex reads AGENTS.md from its project root down to cwd. Without a
    // marker in an ancestor it reads cwd only, so a reader in
    // `<home>/.byok/runs/<taskId>/` would miss the home's persona.
    const capture = async (reader: boolean): Promise<string[]> => {
      const captures: string[][] = [];
      const resources = await ctx();
      if (reader) {
        const runDir = path.join(resources.workspaceDir, '.byok', 'runs', 'reader-task');
        await fs.mkdir(runDir, { recursive: true });
        resources.reader = { canonicalHome: resources.workspaceDir };
        resources.workspaceDir = runDir;
      }
      const s = await open(
        adapter({
          spawnFn: ((cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => {
            captures.push(args);
            return spawn(cmd, args, opts);
          }) as typeof spawn,
        }),
        task,
        resources,
      );
      await turn(s);
      return captures[0]!;
    };
    const readerArgs = await capture(true);
    const markerIndex = readerArgs.indexOf('project_root_markers=[".byok"]');
    expect(markerIndex).toBeGreaterThan(0);
    expect(readerArgs[markerIndex - 1]).toBe('-c');
    expect(readerArgs.indexOf('--listen')).toBeGreaterThan(markerIndex);
    expect((await capture(false)).join(' ')).not.toContain('project_root_markers');
  });
  it('passes model in the authoritative thread/start payload, not CLI argv', async () => {
    const resources = await ctx();
    const file = path.join(resources.workspaceDir, 'rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(
      adapter(),
      {
        ...task,
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'codex',
          providerId: null,
          modelId: 'wanted',
        },
      },
      resources,
    );
    await turn(s);
    const frames = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.find((f) => f.method === 'thread/start').params.model).toBe(
      'wanted',
    );
  });
  it('followUp uses one persistent process and the same event stream', async () => {
    let starts = 0;
    const s = await open(
      adapter({
        spawnFn: ((...args: Parameters<typeof spawn>) => {
          starts++;
          return spawn(...args);
        }) as typeof spawn,
      }),
    );
    await turn(s);
    await s.followUp({ ...task, instruction: 'next' });
    expect((await turn(s)).at(-1)?.type).toBe('turn_end');
    expect(starts).toBe(1);
  });
  it('followUp rejects blob-ref input without touching the open session', async () => {
    const s = await open();
    await turn(s);
    await expect(
      s.followUp({ ...task, instruction: { blobId: 'b' } as never }),
    ).rejects.toThrow('string');
    await s.followUp({ ...task, instruction: 'valid' });
    await turn(s);
  });
  it('projection failures are typed run authority failures, not swallowed observer exceptions', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_MISSING_TOOL_ID: '1' }),
    );
    await expect(turn(s)).rejects.toMatchObject({
      phase: 'run',
      category: 'authority',
      retry: 'non-retryable',
    });
  });
  it('turn failure exposes error then typed semantic terminal failure', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({
        FAKE_CODEX_TURN_FAILS: '1',
        FAKE_CODEX_FAIL_MESSAGE: 'quota',
      }),
    );
    const out: Array<AgentEvent | MessageDraftDelta> = [];
    await expect(
      (async () => {
        for await (const e of s.events) out.push(e);
      })(),
    ).rejects.toMatchObject({ category: 'semantic', retry: 'non-retryable' });
    expect(out.some((e) => e.type === 'error' && e.message === 'quota')).toBe(
      true,
    );
    expect(out.some((e) => e.type === 'turn_end')).toBe(false);
  });
  it('unexpected process exit closes the stream with typed infrastructure failure', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }),
    );
    await expect(turn(s)).rejects.toMatchObject({ category: 'infrastructure' });
  });
  it.each([
    ['usageLimitExceeded', '"usageLimitExceeded"', { class: 'quota' }],
    ['rateLimitExceeded', '"rateLimitExceeded"', { class: 'rate_limited' }],
    ['unauthorized', '"unauthorized"', { class: 'unknown' }],
    ['a 404 transport failure', '{"responseStreamConnectionFailed":{"httpStatusCode":404}}', { class: 'model_unavailable' }],
    ['no codexErrorInfo', undefined, { class: 'unknown' }],
  ] as const)('classifies a failed turn with %s from codexErrorInfo, reason unchanged (#869)', async (_label, info, failure) => {
    const s = await open(adapter(), task, await ctx({
      FAKE_CODEX_TURN_FAILS: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'provider said no',
      ...(info === undefined ? {} : { FAKE_CODEX_ERROR_INFO: info }),
    }));
    const thrown = await turn(s).then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(RuntimeExecutionFailure);
    expect((thrown as RuntimeExecutionFailure).failure).toEqual(failure);
    expect((thrown as RuntimeExecutionFailure).message).toBe('provider said no');
  });
  it.each([
    ['Anthropic limit wording', { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, { class: 'unknown' }],
    ['an invalid_request_error type', { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }, { class: 'invalid_request' }],
    ['an error code', { error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } }, { class: 'quota' }],
  ] as const)('classifies codexErrorInfo other with %s from the body, sending unknown for a text rule (#869)', async (_label, body, failure) => {
    const message = JSON.stringify(body);
    const s = await open(adapter(), task, await ctx({
      FAKE_CODEX_TURN_FAILS: '1',
      FAKE_CODEX_FAIL_MESSAGE: message,
      FAKE_CODEX_ERROR_INFO: '"other"',
    }));
    const thrown = await turn(s).then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(RuntimeExecutionFailure);
    expect(thrown).toMatchObject({ retry: 'non-retryable', message });
    expect((thrown as RuntimeExecutionFailure).failure).toEqual(failure);
  });
  it('marks an app-server exit before the terminal runtime_exited (#869)', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }));
    await expect(turn(s)).rejects.toMatchObject({ category: 'infrastructure', failure: { class: 'runtime_exited' } });
  });
  it('file changes produce real workspace-relative artifacts', async () => {
    const resources = await ctx({
      FAKE_CODEX_ARTIFACT_NAME: 'result.md',
      FAKE_CODEX_ARTIFACT_CONTENT: 'content',
    });
    const s = await open(adapter(), task, resources);
    expect(await turn(s)).toContainEqual({
      type: 'artifact',
      name: 'result.md',
      contentType: 'text/markdown',
    });
    expect(
      await fs.readFile(path.join(resources.workspaceDir, 'result.md'), 'utf8'),
    ).toBe('content');
  });
  it('steer reaches the runtime with its exact active expectedTurnId', async () => {
    const resources = await ctx({ FAKE_CODEX_HANG: '1' });
    const file = path.join(resources.workspaceDir, 'rpc');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(adapter(), task, resources);
    await s.steer('redirect');
    const frames = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.find((f) => f.method === 'turn/steer')).toMatchObject({
      params: {
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'redirect' }],
      },
    });
  });
  it('interrupt performs turn/interrupt and closes outstanding tools as interrupted', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    await new Promise((r) => setTimeout(r, 30));
    await s.interrupt();
    const events = await turn(s);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        output: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
  });
  it('late interrupt has a deadline and terminates the affected session', async () => {
    const s = await open(
      adapter({ interruptTimeoutMs: 30 }),
      task,
      await ctx({ FAKE_CODEX_HANG: '1', FAKE_CODEX_LATE_INTERRUPT: '1' }),
    );
    await expect(s.interrupt()).rejects.toThrow('late interrupt timed out');
    await expect(turn(s)).rejects.toBeInstanceOf(RuntimeExecutionFailure);
  });
  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'item/tool/call',
    'unrecognized',
  ])('server request %s settles without hanging', async (method) => {
    const resources = await ctx({ FAKE_CODEX_SERVER_REQUEST: method });
    const file = path.join(resources.workspaceDir, 'rpc');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(adapter(), task, resources);
    await turn(s);
    // The fixture finishes the turn without waiting for the reply, and logs
    // the reply only when it reads it from stdin, so poll the receipt.
    await vi.waitFor(async () => {
      const frames = (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        frames.find((f) => f.id === 'server-req' && !f.method),
      ).toBeDefined();
    });
  });
  it('retention overflow is explicit typed failure and termination', async () => {
    const { pids, spawnFn } = tracked();
    const error = await open(adapter({ maxRetainedBytes: 1, spawnFn })).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ category: 'infrastructure', message: 'codex retained record byte budget exceeded' });
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expect(gone(pids[0]!)).toBe(true));
  });
  it('a failing record consumer fails the session although the kernel swallows observer errors', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(() => { throw new Error('projection failed'); });
    // The fixture keeps writing the hanging turn; any later record reaches the failing consumer.
    await s.steer('next').catch(() => {});
    const failure = await turn(s).then(() => undefined, (error) => error);
    expect(failure).toMatchObject({ category: 'infrastructure', message: 'projection failed' });
    await s.close();
    await vi.waitFor(() => expect(gone(pids[0]!)).toBe(true));
  });
  it('a vendored fold failure during a turn kills the app-server and keeps the fold reason, unknown (#869)', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    vi.spyOn(vendoredProjection, 'foldCodexNotification').mockImplementation(() => { throw new Error('projection failed'); });
    await s.steer('next').catch(() => {});
    const failure = await turn(s).then(() => undefined, (error) => error);
    expect(failure).toMatchObject({ category: 'infrastructure', message: 'projection failed', failure: { class: 'unknown' } });
    await s.close();
    await vi.waitFor(() => expect(gone(pids[0]!)).toBe(true));
  });
  it('a record consumer that fails on the record of an exit the app-server made on its own keeps runtime_exited (#869)', async () => {
    const consume = CodexProjection.prototype.consume;
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(function (this: CodexProjection, ...args: Parameters<CodexProjection['consume']>) {
      const record = args[1] as { kind: string; body: { kind?: string } };
      if (record.kind === 'response' && record.body.kind === 'exited') throw new Error('projection failed on the exit record');
      return consume.apply(this, args);
    });
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }));
    await expect(turn(s)).rejects.toMatchObject({
      category: 'infrastructure', message: 'projection failed on the exit record', failure: { class: 'runtime_exited' },
    });
  });
  it('rejects an invalid operation timeout', () => {
    for (const operationTimeoutMs of [0, -1, Infinity, Number.NaN, 2_147_483_648])
      expect(() => adapter({ operationTimeoutMs })).toThrow('invalid Codex operation timeout');
  });
  it.each([
    ['open', { FAKE_CODEX_HANG_BEFORE_THREAD: '1' }, 300],
    ['prompt', { FAKE_CODEX_HANG_TURN_START: '1' }, 3000],
  ] as const)('fails the start and kills the app-server when the %s gets no reply within the deadline', async (operation, env, operationTimeoutMs) => {
    const { pids, spawnFn } = tracked();
    const started = Date.now();
    const error = await open(adapter({ operationTimeoutMs, spawnFn }), task, await ctx(env)).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({
      phase: 'start',
      category: 'infrastructure',
      retry: operation === 'open' ? 'retryable' : 'non-retryable',
      message: `codex ${operation} timed out after ${operationTimeoutMs}ms`,
    });
    expect(Date.now() - started).toBeLessThan(operationTimeoutMs + 10_000);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expect(gone(pids[0]!)).toBe(true));
  });
  it('keeps the class of a failure that halted the record stream during the start (#869)', async () => {
    const consume = CodexProjection.prototype.consume;
    let failedTurnSeen = false;
    // The consumer fails on the first record after the failed turn, which has already classed the session.
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(function (this: CodexProjection, ...args: Parameters<CodexProjection['consume']>) {
      if (failedTurnSeen) throw new Error('projection failed');
      const result = consume.apply(this, args);
      const body = (args[1] as { body?: { origin?: string; type?: string } }).body;
      if (body?.origin === 'byok-native' && body.type === 'turn/completed') failedTurnSeen = true;
      return result;
    });
    const error = await open(adapter({ operationTimeoutMs: 3000 }), task, await ctx({
      FAKE_CODEX_FAIL_IN_START: '1',
      FAKE_CODEX_ERROR_INFO: '"usageLimitExceeded"',
    })).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', category: 'semantic', failure: { class: 'quota' } });
  });
  it('fails the session and kills the app-server when a steer gets no reply within the deadline', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ operationTimeoutMs: 3000, spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1', FAKE_CODEX_HANG_STEER: '1' }));
    await expect(s.steer('redirect')).rejects.toThrow('codex steer timed out after 3000ms');
    await expect(turn(s)).rejects.toMatchObject({ category: 'infrastructure', message: 'codex steer timed out after 3000ms' });
    await s.close();
    await vi.waitFor(() => expect(gone(pids[0]!)).toBe(true));
  });
  it('close joins a pending persistent followUp and rejects its RPC instead of leaving it hanging', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_HANG_FOLLOWUP: '1' }),
    );
    await turn(s);
    const pending = s.followUp(task).catch((error) => error);
    await new Promise((r) => setTimeout(r, 30));
    await s.close();
    expect(await pending).toBeInstanceOf(RuntimeExecutionFailure);
  });
  it('failed startup retains a retryable owner until owned disposal is proven', async () => {
    const disposal = new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: 'fixture disposal failure',
    });
    const spy = vi
      .spyOn(processTree, 'disposeOwnedProcessTree')
      .mockRejectedValueOnce(disposal)
      .mockRejectedValueOnce(disposal);
    const error = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' }),
    ).catch((error) => error);
    try {
      expect(error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    } finally {
      spy.mockRestore();
      if (error instanceof RuntimeStartupDisposalFailure)
        await error.retryDisposal();
    }
  });
  it('close is idempotent and joins the owned process receipt', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    await s.close();
    await s.close();
  });
  it('approval resume rejects rather than pretending an interactive product lane', async () => {
    const s = await open();
    await turn(s);
    await expect(s.resolveApproval(true)).rejects.toThrow(
      'interactive approval',
    );
  });
  it('passes reserved MCP servers in the thread config, never in argv or the process env', async () => {
    const captured: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const receipt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-mcp-')), 'frames.jsonl');
    const resources = await ctx({
      FAKE_CODEX_MCP_TOOL_CALL: 'byokagentmessage/send_agent_message',
      FAKE_CODEX_RPC_RECEIPT: receipt,
    });
    resources.mcpServers = {
      byokagentmessage: {
        command: '/fixture/server',
        env: { SERVER_ONLY: 'secret' },
      },
    };
    const s = await open(
      adapter({
        spawnFn: ((
          cmd: string,
          args: string[],
          options: Parameters<typeof spawn>[2],
        ) => {
          captured.push(args);
          envs.push(options?.env ?? {});
          return spawn(cmd, args, options);
        }) as typeof spawn,
      }),
      task,
      resources,
    );
    await turn(s);
    await s.followUp(task);
    await turn(s);
    expect(captured).toHaveLength(1);
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: { config?: { mcp_servers?: unknown } } });
    expect(frames.find((frame) => frame.method === 'thread/start')?.params?.config?.mcp_servers).toEqual({
      byokagentmessage: { command: '/fixture/server', args: [], env: { SERVER_ONLY: 'secret' }, enabled: true },
    });
    // No per-tool grant or per-tool approval mode is projected.
    expect(captured[0]!.some((arg) => arg.includes('mcp_servers') || arg.includes('enabled_tools') || arg.includes('approval_mode'))).toBe(false);
    expect(Object.values(envs[0]!).some((value) => value?.includes('secret'))).toBe(false);
  });
  it('projected MCP toolsets reach the runtime without a per-tool grant', async () => {
    const resources = await ctx({ FAKE_CODEX_MCP_TOOL_CALL: 'host/echo' });
    resources.mcpServers = { host: { command: '/fixture/server' } };
    resources.mcpToolsetTools = observationOf({ host: ['echo'] });
    const s = await open(adapter(), task, resources);
    await turn(s);
  });
});

describe('CodexAdapter agentUserMcpServers (#935)', () => {
  // The user's effective config: a stdio server, a dotted name, a connector and a plugin.
  const USER_CONFIG = {
    model: 'user-model',
    mcp_servers: { gmail: { command: 'gmail-mcp', enabled: true }, 'notes.v2': { command: 'notes-mcp' } },
    apps: { gmail_connector: { enabled: true } },
    plugins: { 'notion@market': { enabled: true } },
  };
  const HOST = { command: process.execPath, args: ['host-mcp.js'] };
  /** An Agent writer task with one host toolset server; `rpc` lists every request the fake received. */
  async function agentCtx(env: NodeJS.ProcessEnv = {}, agent = true) {
    const resources = await ctx({ FAKE_CODEX_USER_CONFIG: JSON.stringify(USER_CONFIG), ...env });
    const home = await fs.realpath(resources.workspaceDir);
    const file = path.join(home, 'rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const rpc = async () => (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(frame => frame.id !== undefined && typeof frame.method === 'string');
    return {
      resources: { ...resources, workspaceDir: home, ...(agent ? { agentHome: home } : {}), mcpServers: { host: HOST }, mcpToolsetTools: observationOf({ host: ['echo'] }) },
      rpc,
    };
  }

  it('validates the option', () => {
    expect(() => adapter({ agentUserMcpServers: 'strict' as never })).toThrow(new TypeError('CodexAdapterOptions.agentUserMcpServers must be inherit or excluded'));
  });

  it.each([undefined, 'fake-thread-1'])('disables every user server, connectors and plugins and reads the thread back (resume=%s)', async (sessionRef) => {
    const { resources, rpc } = await agentCtx();
    const s = await open(adapter({ agentUserMcpServers: 'excluded' }), { ...task, ...(sessionRef === undefined ? {} : { sessionRef }) }, resources);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    const frames = await rpc();
    const method = sessionRef === undefined ? 'thread/start' : 'thread/resume';
    expect(frames.map(frame => frame.method).slice(0, 4)).toEqual(['initialize', 'config/read', method, 'mcpServerStatus/list']);
    expect(frames[1].params).toEqual({ cwd: resources.workspaceDir, includeLayers: false });
    const open_ = frames[2].params;
    // The user's model and sandbox still apply: the open sets neither.
    expect(open_).not.toHaveProperty('model');
    expect(open_.config).toEqual({
      mcp_servers: { gmail: { enabled: false }, 'notes.v2': { enabled: false }, host: { command: process.execPath, args: ['host-mcp.js'], enabled: true } },
      features: { apps: false, plugins: false },
    });
    expect(frames[3].params).toEqual({ threadId: 'fake-thread-1', detail: 'toolsAndAuthOnly' });
  });

  it('fails the start on a user server named like a task server, before the thread opens', async () => {
    const { resources, rpc } = await agentCtx({ FAKE_CODEX_USER_CONFIG: JSON.stringify({ mcp_servers: { host: { command: 'user-host', env: { NODE_OPTIONS: '--require /x' } } } }) });
    const error = await startPreparedOperation(adapter({ agentUserMcpServers: 'excluded' }), task, resources).catch(e => e);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable', failure: { class: 'unknown' },
      message: 'codex Agent user MCP server exclusion refused: user MCP servers share a name with task servers: host' });
    expect((await rpc()).map(frame => frame.method)).toEqual(['initialize', 'config/read']);
  });

  it('fails the start when the thread still runs a server outside the task', async () => {
    const extra = [{ name: 'codex_apps', runtimeStatus: 'connected', pluginId: null }, { name: 'gdrive', runtimeStatus: 'starting', pluginId: 'drive@market' }];
    const { resources } = await agentCtx({ FAKE_CODEX_STATUS_EXTRA: JSON.stringify(extra) });
    const error = await startPreparedOperation(adapter({ agentUserMcpServers: 'excluded' }), task, resources).catch(e => e);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable', failure: { class: 'unknown' },
      message: 'codex Agent thread still runs MCP servers outside the task: codex_apps, gdrive (plugin drive@market)' });
  });

  it('changes nothing under inherit or for a task that is not an Agent task', async () => {
    for (const [options, agent] of [[{}, true], [{ agentUserMcpServers: 'inherit' as const }, true], [{ agentUserMcpServers: 'excluded' as const }, false]] as const) {
      const { resources, rpc } = await agentCtx({}, agent);
      await turn(await open(adapter(options), task, resources));
      const frames = await rpc();
      expect(frames.map(frame => frame.method).slice(0, 2)).toEqual(['initialize', 'thread/start']);
      expect(frames.map(frame => frame.method)).not.toContain('mcpServerStatus/list');
      expect(frames[1].params.config).toEqual({ mcp_servers: { host: { command: process.execPath, args: ['host-mcp.js'], enabled: true } } });
    }
  });
});
