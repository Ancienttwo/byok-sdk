import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { spawn as realSpawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from '../adapters/pi/events';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from '../adapters/pi/rpc-client';
import { ApprovalRegistry } from '../daemon/approvals';
import type { ExecutionRecord } from '../daemon/execution-record';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const REPLAY = fileURLToPath(new URL('./fixtures/pi-trajectory-replay.mjs', import.meta.url));
const T0_RECORDS = new URL('./fixtures/pi-1.3-trajectory/', import.meta.url);
const TASK_ID = 'pi-execution-record';

const directories: string[] = [];
const clients: PiRpcClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-record-'));
  directories.push(directory);
  return directory;
}

/** Replays a synthetic RPC record through the real client; see `pi-trajectory-replay.mjs`. */
async function replay(record: string, ending: 'exit' | 'killed'): Promise<{ client: PiRpcClient; frames: PiRpcMessage[] }> {
  const client = new PiRpcClient({ command: process.execPath, args: [REPLAY, record, ending], cwd: import.meta.dirname, env: {} });
  clients.push(client);
  expect(await client.send({ type: 'replay_synthetic' })).toMatchObject({ success: true });
  const frames: PiRpcMessage[] = [];
  for await (const frame of client.events) frames.push(frame);
  await client.waitClosed();
  return { client, frames };
}

/** The real PiAdapter and its fake Pi child, driven by a directly built TaskRunner. */
async function runPi(trajectory?: string): Promise<{ sent: Envelope[]; records: ExecutionRecord[] }> {
  const directory = await temporaryDirectory();
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => realSpawn(command, [...args], {
    ...options,
    env: { ...options.env, ...(trajectory === undefined ? {} : { FAKE_PI_TRAJECTORY: trajectory }) },
  })) as unknown as SpawnFn;
  const sent: Envelope[] = [];
  const records: ExecutionRecord[] = [];
  let recorded!: () => void;
  const published = new Promise<void>(resolve => { recorded = resolve; });
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }), spawnFn })],
    ...testAgentHomeDeps(),
    deviceId: 'pi-record-device',
    send: envelope => { sent.push(envelope); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unused'); },
      uploadArtifact: async () => { throw new Error('unused'); },
    },
    approvalRegistry: new ApprovalRegistry(),
    storeDir: directory,
    productId: 'pi-record-product',
    onExecutionRecord: record => { records.push(record); recorded(); },
  });
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'say hi', runtime: 'pi' }, { taskId: TASK_ID, seq: 1 }));
  // The runner publishes the record after Session.close() and lets the task go right after it.
  await published;
  await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  return { sent, records };
}

function terminal(sent: readonly Envelope[]): Envelope | undefined {
  return sent.find(envelope => ['task.complete', 'task.fail', 'task.cancelled'].includes(envelope.type));
}

describe('Pi trajectory evidence: declaration and RPC counting', () => {
  it('declares the event stream for the RPC lanes and not for the durable worker', () => {
    expect(new PiAdapter().descriptor.trajectoryEvidence).toBe('event-stream');
    expect(new PiAdapter({ durablePi: true }).descriptor.trajectoryEvidence).toBeUndefined();
  });

  it('treats every Pi 1.3.0 bookkeeping frame as routine, not as an unmapped gap', () => {
    // Pi streams one message_update per assistant step; only text deltas map.
    for (const step of ['start', 'text_start', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end']) {
      expect(mapPiMessageToAgentEvent({ type: 'message_update', assistantMessageEvent: { type: step, contentIndex: 0 } })).toBeUndefined();
    }
    expect(mapPiMessageToAgentEvent({ type: 'auto_retry_end', success: true, attempt: 1 })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'entry_appended', entry: { id: 'entry-1' } })).toBeUndefined();
    for (const type of ['message_update', 'auto_retry_end', 'entry_appended']) expect(ROUTINE_PI_EVENT_TYPES.has(type)).toBe(true);
  });

  it.each([['normal', 'exit', 0], ['tool-error', 'exit', 0], ['interrupted', 'exit', 0], ['killed', 'killed', 1]] as const)(
    'counts %s: only the unterminated half frame of a killed process is dropped', async (scenario, ending, dropped) => {
      const { client } = await replay(fileURLToPath(new URL(`${scenario}.jsonl`, T0_RECORDS)), ending);
      expect(client.decodeDropped).toBe(dropped);
    });

  it('counts every complete stdout line that is not a JSON object and still delivers the frames around it', async () => {
    const record = path.join(await temporaryDirectory(), 'noise.jsonl');
    await fs.writeFile(record, [
      '{"type":"agent_start"}', 'plain log text', 'null', '[1]', '"text"', '{"type":"tool_execution_start","toolCallId":"call-one","toolName":"observe","args":{}}', '',
    ].join('\n'));
    const { client, frames } = await replay(record, 'exit');
    expect(frames.map(frame => frame.type)).toEqual(['agent_start', 'tool_execution_start']);
    expect(client.decodeDropped).toBe(4);
  });

  it('sums unmapped frames across types', async () => {
    const { client } = await replay(fileURLToPath(new URL('normal.jsonl', T0_RECORDS)), 'exit');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.recordUnmappedFrame('novel_a');
    client.recordUnmappedFrame('novel_a');
    client.recordUnmappedFrame('novel_b');
    expect(client.unmappedFrames).toBe(3);
  });
});

describe('Pi execution record through TaskRunner and a fake Pi process', () => {
  it('records a paired run as complete, with its text stream bookkeeping counted as routine', async () => {
    const { sent, records } = await runPi();
    expect(terminal(sent)?.type).toBe('task.complete');
    expect(records).toEqual([{ taskId: TASK_ID, terminal: 'complete', status: 'complete', source: 'event-stream', gaps: [] }]);
  });

  it('records a missing tool end as partial and leaves the completion unchanged', async () => {
    const { sent, records } = await runPi('missing-tool-end');
    expect(terminal(sent)?.type).toBe('task.complete');
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'complete', status: 'partial', source: 'event-stream', gaps: [{ reason: 'unpaired_tool_call', count: 1 }],
    }]);
  });

  it('counts an undecodable stdout line, so the run is not complete', async () => {
    const { sent, records } = await runPi('stdout-noise');
    expect(terminal(sent)?.type).toBe('task.complete');
    expect(records).toMatchObject([{ status: 'partial', gaps: [{ reason: 'decode_dropped', count: 1 }] }]);
  });

  it('records a process killed mid-frame as partial: unpaired call, dropped half frame, early stream end', async () => {
    const { sent, records } = await runPi('killed');
    expect(terminal(sent)).toMatchObject({ type: 'task.fail', payload: { retryable: true } });
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'failed', status: 'partial', source: 'event-stream',
      gaps: [{ reason: 'unpaired_tool_call', count: 1 }, { reason: 'decode_dropped', count: 1 }, { reason: 'stream_ended_early', count: 1 }],
    }]);
  });

  it('records unknown, not complete, when open calls exceed what the record can track', async () => {
    const { sent, records } = await runPi('open-calls');
    expect(terminal(sent)?.type).toBe('task.complete');
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'complete', status: 'unknown', source: 'event-stream', gaps: [], unknownReason: 'evidence_overflow',
    }]);
  });
});
