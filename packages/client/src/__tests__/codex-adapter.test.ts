import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session } from '../types';
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
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex.mjs', import.meta.url),
);
const sessions: Session[] = [];
const dirs: string[] = [];
const task: TaskOfferPayload = {
  instruction: 'hello',
  policy: { mode: 'auto' },
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
    policy: { mode: 'auto' },
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
async function turn(s: Session) {
  const out: AgentEvent[] = [];
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
      version: 'codex-cli 0.159.2',
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
      permissionModes: ['auto'],
    });
    expect(
      adapter().descriptor.environmentRequirements.credentialNames,
    ).toEqual([]);
  });
  it('detect returns typed refusal for unqualified versions', async () => {
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.159.1');
    expect(await adapter().detect()).toEqual({
      kind: 'refused',
      reason: 'runtime_version_unsupported',
    });
  });
  it('detect refuses a missing app-server subcommand', async () => {
    vi.stubEnv('FAKE_CODEX_NO_APP_SERVER', '1');
    expect(await adapter().detect()).toEqual({
      kind: 'refused',
      reason: 'app_server_unavailable',
    });
  });
  it.each([
    { mode: 'readonly' },
    { mode: 'confirm' },
    { mode: 'plan' },
    { mode: 'auto', network: false },
    { mode: 'auto', allowTools: ['Bash'] },
    { mode: 'auto', denyTools: ['Read'] },
  ] satisfies NonNullable<TaskOfferPayload['policy']>[])(
    'rejects effective policy before bin/spawn effects: %j',
    async (policy) => {
      const resolveBin = vi.fn(() => ({
        command: fixture,
        source: 'path' as const,
      }));
      const a = new CodexAdapter({ resolveBin });
      const r = await a.prepare({
        offer: { ...task, policy },
        policy,
        descriptor: a.descriptor,
        requiredToolsetIds: [],
      });
      expect(r.kind).toBe('reject');
      expect(resolveBin).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, true])('allows auto with network=%s', async (network) => {
    const resources = await ctx();
    resources.policy = {
      mode: 'auto',
      ...(network === undefined ? {} : { network }),
    };
    const s = await open(
      adapter(),
      { ...task, policy: resources.policy },
      resources,
    );
    expect((await turn(s)).at(-1)?.type).toBe('turn_end');
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
    await expect(
      open(adapter(), { ...task, sessionRef: 'absent' }),
    ).rejects.toThrow('no rollout found');
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
  it('plain and prepared Git workspaces use the same sealed cwd, with no exec skip-git arguments', async () => {
    for (const git of [false, true]) {
      const captures: string[][] = [];
      const resources = await ctx();
      if (git) resources.gitWorkspace = { workspaceId: 'w' };
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
    }
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
  it('followUp rejects changed policy and blob-ref input without touching the open session', async () => {
    const s = await open();
    await turn(s);
    await expect(
      s.followUp({ ...task, policy: { mode: 'readonly' } }),
    ).rejects.toThrow('policy');
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
    const out: AgentEvent[] = [];
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
    await new Promise((r) => setTimeout(r, 20));
    const frames = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      frames.find((f) => f.id === 'server-req' && !f.method),
    ).toBeDefined();
  });
  it('retention overflow is explicit typed failure and termination', async () => {
    await expect(open(adapter({ maxRetainedBytes: 1 }))).rejects.toThrow(
      'record byte budget',
    );
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
  it('reserved MCP approval args and sealed env remain present across follow-up turns', async () => {
    const captured: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const resources = await ctx({
      FAKE_CODEX_MCP_TOOL_CALL: 'byokagentmessage/send_agent_message',
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
    expect(captured[0]).toContain(
      'mcp_servers.byokagentmessage.enabled_tools=["send_agent_message"]',
    );
    expect(captured[0]).toContain(
      'mcp_servers.byokagentmessage.tools.send_agent_message.approval_mode="approve"',
    );
    expect(
      Object.keys(envs[0]!).some((k) => k.startsWith('BYOK_MCP_PAYLOAD_')),
    ).toBe(true);
    expect(envs[0]).not.toHaveProperty('SERVER_ONLY');
  });
  it('projected MCP toolsets use only the observed per-tool grant', async () => {
    const resources = await ctx({ FAKE_CODEX_MCP_TOOL_CALL: 'host/echo' });
    resources.mcpServers = { host: { command: '/fixture/server' } };
    resources.mcpToolsetTools = observationOf({ host: ['echo'] });
    const s = await open(adapter(), task, resources);
    await turn(s);
  });
});
