import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { observePreparedMemory } from '../agent-memory/prepared-agent-memory';
import {
  AGENT_MEMORY_MCP_SERVER_INFO,
  AGENT_MEMORY_TOOLS,
  serveAgentMemoryDescriptorOverStdio,
} from '../bin/agent-memory-mcp-server';
import {
  preparedAgentMemoryDescriptorDigest,
  preparedAgentMemoryExecutorFingerprints,
  preparedAgentMemoryModeWithinCeiling,
  preparedAgentMemoryTools,
  validatePreparedAgentMemoryObservation,
} from '../agent-memory/prepared-capability';

function descriptor(): unknown {
  return {
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    protocolVersion: '2025-11-25',
    tools: AGENT_MEMORY_TOOLS.map(({ operation: _operation, ...tool }) => tool),
  };
}

async function request(stdin: PassThrough, stdout: PassThrough, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve) => {
    let buffered = '';
    const receive = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      stdout.off('data', receive);
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    };
    stdout.on('data', receive);
  });
  stdin.write(`${JSON.stringify(value)}\n`);
  return response;
}

describe('prepared Agent-memory descriptor', () => {
  it('uses the same complete schemas and operation metadata as execution, then selects deterministically', () => {
    const observation = validatePreparedAgentMemoryObservation(descriptor());
    expect(preparedAgentMemoryTools('none', observation)).toEqual([]);
    expect(preparedAgentMemoryTools('read', observation).map((tool) => tool.name)).toEqual(['memory_recall']);
    expect(preparedAgentMemoryTools('read-write', observation).map((tool) => tool.name)).toEqual(['memory_recall', 'memory_save']);
    expect(preparedAgentMemoryModeWithinCeiling('read', 'read-write')).toBe(true);
    expect(preparedAgentMemoryModeWithinCeiling('read-write', 'read')).toBe(false);

    const first = preparedAgentMemoryDescriptorDigest(observation);
    const fingerprints = preparedAgentMemoryExecutorFingerprints(observation, 'read-write', 'runtime-identity');
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(fingerprints).toHaveLength(2);
    expect(new Set(fingerprints).size).toBe(2);
  });

  it('rejects missing or altered operation metadata rather than inferring from names', () => {
    const missing = descriptor() as { tools: Array<Record<string, unknown>> };
    delete missing.tools[0]!._meta;
    expect(() => validatePreparedAgentMemoryObservation(missing)).toThrow(/_meta/);
    const altered = descriptor() as { tools: Array<Record<string, unknown>> };
    altered.tools[1]!._meta = { 'byok.agent-memory.operation': 'read' };
    expect(() => validatePreparedAgentMemoryObservation(altered)).toThrow(/drift/);
  });

  it('serves the descriptor without execution dependencies and rejects every tools/call', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    serveAgentMemoryDescriptorOverStdio({ stdin, stdout });
    const listed = await request(stdin, stdout, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(2);
    const denied = await request(stdin, stdout, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_recall', arguments: { path: 'MEMORY.md' } },
    });
    expect(denied.error).toMatchObject({ code: -32602, message: 'agent memory descriptor does not accept tools/call' });
    stdin.end();
  });
});

const dirs: string[] = [];
const spawned: number[] = [];
afterEach(async () => {
  // A failing case must not leak its keep-alive child into the next one.
  for (const pid of spawned.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

// Child startup competes with the rest of the client suite, so a fixed
// 400 x 10 ms (4 s) budget is too tight under load. Keep the wait bounded but
// allow a slow spawn, backing off so a stalled child costs little CPU.
const WAIT_FOR_FILE_LIMIT_MS = 15_000;
const WAIT_FOR_FILE_INITIAL_DELAY_MS = 10;
const WAIT_FOR_FILE_MAX_DELAY_MS = 250;

async function waitForFile(file: string): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + WAIT_FOR_FILE_LIMIT_MS;
  let delay = WAIT_FOR_FILE_INITIAL_DELAY_MS;
  for (;;) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text !== undefined && text.length > 0) return text;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const waited = Date.now() - startedAt;
      throw new Error(`timed out after ${waited}ms waiting for ${file} (limit ${WAIT_FOR_FILE_LIMIT_MS}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, WAIT_FOR_FILE_MAX_DELAY_MS);
  }
}

/**
 * A REAL descriptor child. It records its pid, then either never answers
 * `initialize` or answers it and never answers `tools/list`, and it keeps
 * itself alive until it is killed.
 */
async function hangingDescriptor(stage: 'initialize' | 'tools/list') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-memory-descriptor-')));
  dirs.push(dir);
  const pidFile = path.join(dir, 'pid');
  const pidTempFile = `${pidFile}.tmp`;
  const listedFile = path.join(dir, 'listed');
  const script = path.join(dir, 'descriptor');
  await fs.writeFile(script, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    // Publish the pid atomically so a reader can never observe a partial pid.
    `fs.writeFileSync(${JSON.stringify(pidTempFile)}, String(process.pid));`,
    `fs.renameSync(${JSON.stringify(pidTempFile)}, ${JSON.stringify(pidFile)});`,
    `setInterval(() => {}, 1000);`,
    `let buffered = '';`,
    `process.stdin.on('data', (chunk) => {`,
    `  buffered += chunk;`,
    `  for (let newline = buffered.indexOf('\\n'); newline >= 0; newline = buffered.indexOf('\\n')) {`,
    `    const message = JSON.parse(buffered.slice(0, newline));`,
    `    buffered = buffered.slice(newline + 1);`,
    `    if (message.method === 'tools/list') fs.writeFileSync(${JSON.stringify(listedFile)}, 'listed');`,
    `    if (${JSON.stringify(stage)} === 'tools/list' && message.method === 'initialize') {`,
    `      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {`,
    `        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },`,
    `        serverInfo: { name: 'hanging-descriptor', version: '1.0.0' } } }) + '\\n');`,
    `    }`,
    `  }`,
    `});`,
    '',
  ].join('\n'));
  await fs.chmod(script, 0o755);
  const describe = Object.freeze({ command: script, args: Object.freeze(['__byok_sdk_helper', 'agent-memory-describe']) });
  return { describe, env: Object.freeze({}), pidFile, listedFile };
}

describe('a cancelled task-free descriptor probe leaves no child alive', () => {
  it.each([
    ['during initialize', 'initialize'],
    ['during tools/list, after the connection is established', 'tools/list'],
  ] as const)(
    'kills the descriptor child when the probe is cancelled %s',
    // Two bounded waits can run in this case; leave room for the wait to
    // raise its own elapsed-time error instead of racing the suite default.
    { timeout: 35_000 },
    async (_label, stage) => {
      const fixture = await hangingDescriptor(stage);
      const controller = new AbortController();
      const observed = observePreparedMemory(fixture.describe, fixture.env, controller.signal);
      const settled = observed.then(() => 'resolved', () => 'rejected');
      const pid = Number(await waitForFile(fixture.pidFile));
      spawned.push(pid);
      expect(alive(pid)).toBe(true);
      if (stage === 'tools/list') await waitForFile(fixture.listedFile);
      controller.abort();

      expect(await settled).toBe('rejected');
      expect(alive(pid)).toBe(false);
    },
  );
});
