import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { observePreparedMemory, resolvePreparedMemoryImplementation } from '../daemon/prepared-agent-memory';
import {
  realToolImplementationFsProbe,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
} from '../daemon/tool-implementation-identity';
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
    const fingerprints = preparedAgentMemoryExecutorFingerprints(observation, 'read-write', {
      descriptor: 'descriptor-attested', execution: 'execution-attested',
    }, 'runtime-attested');
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

/** Only uid/mode are overridden: a non-root test cannot create the root-owned install the resolver requires. */
function rootOwnedProbe(): ToolImplementationFsProbe {
  return {
    async lstat(target) {
      const real = await realToolImplementationFsProbe.lstat(target);
      return { ...real, uid: 0, mode: real.mode & ~0o222 };
    },
    realpath: (target) => realToolImplementationFsProbe.realpath(target),
    digest: (target) => realToolImplementationFsProbe.digest(target),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text !== undefined && text.length > 0) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/**
 * A REAL descriptor child, attested through the production resolver and
 * spawned through the production SDK-helper spawn gate. It records its pid,
 * then either never answers `initialize` or answers it and never answers
 * `tools/list`, and it keeps itself alive until it is killed.
 */
async function hangingDescriptor(stage: 'initialize' | 'tools/list') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-memory-descriptor-')));
  dirs.push(dir);
  const pidFile = path.join(dir, 'pid');
  const listedFile = path.join(dir, 'listed');
  const script = path.join(dir, 'descriptor');
  await fs.writeFile(script, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
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
  const closureDigest = await realToolImplementationFsProbe.digest(script);
  const launchCwd = path.dirname(script);
  const authority: ToolImplementationAuthority = {
    resolve: async (locator) => ({
      kind: 'attested',
      authority: 'host-install-record',
      manifestRevision: 'memory-helper@test',
      form: 'compiled-executable',
      installPath: script,
      closureDigest,
      closureKind: 'artifact',
      launchArgv: ['__byok_sdk_helper', (locator as { entry: string }).entry],
      launchCwd,
    } as never),
  };
  const env = Object.freeze({});
  const probe = rootOwnedProbe();
  const implementation = await resolvePreparedMemoryImplementation(
    authority, env, probe,
  );
  return { implementation, env, probe, pidFile, listedFile };
}

describe('a cancelled task-free descriptor probe leaves no child alive', () => {
  it.each([
    ['during initialize', 'initialize'],
    ['during tools/list, after the connection is established', 'tools/list'],
  ] as const)('kills the descriptor child when the probe is cancelled %s', async (_label, stage) => {
    const fixture = await hangingDescriptor(stage);
    const controller = new AbortController();
    const observed = observePreparedMemory(fixture.implementation, fixture.env, controller.signal, fixture.probe);
    const settled = observed.then(() => 'resolved', () => 'rejected');
    const pid = Number(await waitForFile(fixture.pidFile));
    spawned.push(pid);
    expect(alive(pid)).toBe(true);
    if (stage === 'tools/list') await waitForFile(fixture.listedFile);
    controller.abort();

    expect(await settled).toBe('rejected');
    expect(alive(pid)).toBe(false);
  });
});
