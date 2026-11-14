import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta } from '../../types';
import { object, OpenCodeProjection } from '../../adapters/opencode/projection';
import { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import { check, fileEgress, skip, type RuntimeCases } from './contract';
import type { openCodeContract } from './opencode-contract';
import { startLoopbackProvider, type ProviderRequest } from './loopback';

const CHILD_TEXT = 'BYOK_CHILD_TEXT_2182';
const ROOT_TEXT = 'BYOK_ROOT_DONE_2182';
const READ_PROMPT = 'BYOK_CHILD_READ_2182';
const HOLD_PROMPT = 'BYOK_CHILD_HOLD_2182';

type Frame = {
  id?: unknown;
  method?: string;
  params?: {
    childSessionId: string;
    update?: { sessionUpdate?: string; kind?: string; toolCallId?: string; content?: { text?: string } };
  };
  result?: { stopReason?: string };
};
type ProcessRow = { pid: number; ppid: number; command: string };

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Snapshot only descendants proven by the spawn PID / PPID chain; never signal unrelated processes. */
function processTree(roots: ReadonlySet<number>): ProcessRow[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)!;
    return { pid: Number(pid), ppid: Number(ppid), command: command! };
  });
  const owned = new Set(roots);
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  }
  return rows.filter(row => owned.has(row.pid));
}

/** Real 2.3 ACP transport, with deterministic model replies and no provider credentials. */
export function openCodeChildCases(contract: ReturnType<typeof openCodeContract>): RuntimeCases {
  return {
    'opencode.child': ['child_update tools retain session ids; root completion disposes a running background child',
      process.env.BYOK_RUNTIME_CONTRACT === 'qualified' && process.env.BYOK_CONTRACT_OPENCODE2_CHILD === '1' && process.platform === 'darwin'
        ? check(async () => {
          const recorder = await fileEgress();
          const wire: Array<{ direction: 'in' | 'out'; frame: Frame }> = [];
          const spawned = new Set<number>();
          const events: Array<AgentEvent | MessageDraftDelta> = [];
          const turns: Array<{ sessionId: string; agentPath: readonly unknown[] }> = [];
          const consume = OpenCodeProjection.prototype.consume;
          const projection = vi.spyOn(OpenCodeProjection.prototype, 'consume').mockImplementation(function (this: OpenCodeProjection, record, emit, end) {
            const projected = object(record.body)?.events;
            if (Array.isArray(projected) && projected.some(event => object(event)?.kind === 'turn_ended'))
              turns.push({ sessionId: record.sessionId, agentPath: record.agentPath });
            return consume.call(this, record, emit, end);
          });
          const stages: Array<{ role: string; toolResults: number; tools: string[] }> = [];
          let beforeDispose: ProcessRow[] = [];
          let workspace = '';
          let holdPid = 0;
          const childUpdates = () => wire.filter(row => row.direction === 'in' && row.frame.method === 'opencode/session/child_update').map(row => row.frame.params!);
          const provider = await startLoopbackProvider('openai-chat', async (request: ProviderRequest) => {
            const body = JSON.parse(request.text) as { messages: Array<{ role: string; content: unknown }> };
            const user = body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
            const role = user.includes(READ_PROMPT) ? 'read' : user.includes(HOLD_PROMPT) ? 'hold' : 'root';
            if (!request.tools.length) return { kind: 'text', chunks: ['contract title'] };
            stages.push({ role, toolResults: request.toolResults, tools: request.tools.map(tool => tool.name) });
            const tool = (name: string) => {
              const found = request.tools.find(tool => tool.name === name);
              if (!found) throw new Error(`${role}: ${name} absent; offered ${request.tools.map(tool => tool.name).join(',')}`);
              return found;
            };
            if (role === 'read') return request.toolResults === 0
              ? { kind: 'tool', tool: tool('read'), args: { path: path.join(workspace, 'child.txt') } }
              : { kind: 'text', chunks: [CHILD_TEXT] };
            if (role === 'hold') return { kind: 'tool', tool: tool('shell'), args: {
              command: `${process.execPath} hold.mjs`, description: 'Hold background child for disposal evidence',
            } };
            if (request.toolResults === 0) return { kind: 'tool', tool: tool('subagent'), args: {
              agent: 'general', description: 'Read child fixture', prompt: READ_PROMPT,
            } };
            if (request.toolResults === 1) {
              await until(() => childUpdates().find(params => params.update?.content?.text === CHILD_TEXT), 'child text on native wire');
              return { kind: 'tool', tool: tool('subagent'), args: { agent: 'general', description: 'Hold child tool', prompt: HOLD_PROMPT } };
            }
            holdPid = Number(await until(async () => (await fs.readFile(path.join(workspace, 'hold.pid'), 'utf8').catch(() => '')).trim() || undefined, 'background tool pid'));
            beforeDispose = processTree(spawned);
            return { kind: 'text', chunks: [ROOT_TEXT] };
          }, 'fake');
          const warnings: string[] = [];
          const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args.map(String).join(' ')); });
          let session: Awaited<ReturnType<typeof startPreparedOperation>> | undefined;
          try {
            const { box, env } = await contract.openCodeEnv('opencode2-child', provider.baseUrl);
            workspace = box.workspace;
            await fs.writeFile(path.join(workspace, 'child.txt'), 'BYOK_CHILD_READ_RESULT_2182\n');
            await fs.writeFile(path.join(workspace, 'hold.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('hold.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
            const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => {
              const child = spawn(command, [...args], options);
              if (child.pid) spawned.add(child.pid);
              let pending = '';
              child.stdout?.on('data', (chunk: Buffer) => {
                pending += chunk.toString();
                for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                  const line = pending.slice(0, end); pending = pending.slice(end + 1);
                  try { wire.push({ direction: 'in', frame: JSON.parse(line) }); } catch { /* Non-ACP terminal output. */ }
                }
              });
              const write = child.stdin?.write.bind(child.stdin);
              if (child.stdin && write) child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
                try { wire.push({ direction: 'out', frame: JSON.parse(chunk.toString()) }); } catch { /* Non-ACP terminal input. */ }
                return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
              }) as typeof child.stdin.write;
              return child;
            }) as typeof spawn;
            const adapter = new OpenCodeAdapter({ resolveBin: () => ({ command: contract.target.bin, source: 'env' }), models: ['loopback/fake'], spawnFn });
            session = await startPreparedOperation(adapter, { instruction: 'BYOK_ROOT_2182' }, { workspaceDir: workspace, agentHome: workspace, env: { ...env, ...recorder.env } });
            for await (const event of session.events) events.push(event);
            await session.close();
            const owned = new Set([...spawned, ...beforeDispose.map(row => row.pid)]);
            const afterDispose = await until(() => processTree(owned).length === 0 ? [] : undefined, 'owned process tree to exit');
            const updates = childUpdates();
            console.info('OPENCODE_CHILD_EVIDENCE', JSON.stringify({ version: contract.target.expectedVersion, rootSession: session.sessionRef, stages, events, turns, warnings, beforeDispose, afterDispose, wire }));
            const read = updates.find(params => params.update?.sessionUpdate === 'tool_call' && params.update?.kind === 'read')!;
            expect(read, 'actual child read frame').toBeDefined();
            // OpenCode prefixes its native id; the SDK adds the record's session identity.
            const callId = `${read.childSessionId}:${read.update!.toolCallId}`;
            expect(read.update!.toolCallId!.startsWith(`${read.childSessionId}:`)).toBe(true);
            expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', toolCallId: callId }));
            expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolCallId: callId }));
            const result = events.find(event => event.type === 'tool_result' && event.toolCallId === callId);
            expect(result).not.toHaveProperty('isError', true);
            expect(JSON.stringify(result)).toContain('BYOK_CHILD_READ_RESULT_2182');
            expect(updates.some(params => params.update?.content?.text === CHILD_TEXT)).toBe(true);
            expect(events.filter(event => event.type === 'progress').map(event => event.text).join('')).toBe(ROOT_TEXT);
            expect(events.filter(event => event.type === 'turn_end')).toHaveLength(1);
            expect(events.at(-1)?.type).toBe('turn_end');
            expect(turns).toEqual([{ sessionId: session.sessionRef, agentPath: [] }]);
            expect(events.some(event => event.type === 'tool_use' && event.tool === 'shell')).toBe(true);
            expect(events.some(event => event.type === 'tool_result' && event.tool === 'shell')).toBe(false);
            const prompt = wire.find(row => row.direction === 'out' && row.frame.method === 'session/prompt')!.frame;
            expect(wire.some(row => row.direction === 'in' && row.frame.id === prompt.id && row.frame.result?.stopReason === 'end_turn')).toBe(true);
            expect(beforeDispose.some(row => row.pid === holdPid), 'background tool is alive before root answer').toBe(true);
            expect(beforeDispose.some(row => /opencode.*acp/.test(row.command))).toBe(true);
            expect(afterDispose).toEqual([]);
          } finally {
            try { await session?.close(); }
            finally {
              projection.mockRestore();
              warn.mockRestore();
              await provider.close();
            }
          }
        }, 120_000)
        : skip('opt in on macOS with qualified mode and BYOK_CONTRACT_OPENCODE2_CHILD=1; real 2.3 binary, local scripted provider')],
  };
}
