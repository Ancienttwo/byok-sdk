/**
 * The embedded composition, end to end, through the public subpath only.
 *
 * `agent-memory-entry-constraints.test.ts` proves the entry carries no daemon
 * and no transport. That is a negative property, and a negative property alone
 * would be satisfied by an entry that exports nothing usable. This file is the
 * positive half: a host that runs no daemon, holds no control socket, and
 * imports nothing but `../agent-memory/index` can serve `memory_recall` and
 * `memory_save` over stdio against its own Agent home and then snapshot it.
 *
 * The only test-owned piece is the filesystem authority, which is exactly the
 * seam `AgentMemoryFilesystem` exists for: on macOS a host supplies the signed
 * external helper through `openAgentMemoryFilesystemHelper`, on Linux it omits
 * it and the native descriptor backend is used. Neither is available in a
 * portable unit test, so an in-memory implementation of the same interface
 * stands in — the service, the CAS, the audit write and the MCP framing under
 * test are the real ones.
 */
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_RECALL_TOOL_NAME,
  AGENT_MEMORY_SAVE_TOOL_NAME,
  AgentMemoryService,
  captureAgentMemorySnapshot,
  prependAgentMemoryGuidance,
  serveAgentMemoryMcpOverStdio,
  type AgentMemoryFilesystem,
  type AgentMemoryFilesystemFileState,
  type AgentMemoryMcpDeps,
  type AgentMemoryTaskContext,
} from '../agent-memory/index';

function revisionOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fileState(content: string | undefined): AgentMemoryFilesystemFileState {
  const value = content ?? '';
  return Object.freeze({
    exists: content !== undefined,
    content: value,
    revision: revisionOf(value),
    byteCount: Buffer.byteLength(value, 'utf8'),
  });
}

/** Stands in for the host's helper-backed or native root-pinned authority. */
class InMemoryAgentHome implements AgentMemoryFilesystem {
  readonly files = new Map<string, string>();
  closed = false;

  constructor(seed: Readonly<Record<string, string>>) {
    for (const [key, value] of Object.entries(seed)) this.files.set(key, value);
  }

  async read(filePath: string): Promise<AgentMemoryFilesystemFileState> {
    return fileState(this.files.get(filePath));
  }

  async replace(filePath: string, expectedRevision: string, content: string): Promise<AgentMemoryFilesystemFileState> {
    const current = fileState(this.files.get(filePath));
    if (current.revision !== expectedRevision) throw new Error(`revision mismatch for ${filePath}`);
    this.files.set(filePath, content);
    return fileState(content);
  }

  async delete(filePath: string, expectedRevision: string): Promise<void> {
    const current = fileState(this.files.get(filePath));
    if (!current.exists || current.revision !== expectedRevision) throw new Error(`revision mismatch for ${filePath}`);
    this.files.delete(filePath);
  }

  async append(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, `${this.files.get(filePath) ?? ''}${content}`);
  }

  async walk(prefix: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(`${prefix}/`));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function embeddedContext(filesystem: AgentMemoryFilesystem): AgentMemoryTaskContext {
  // Every field here is host-owned in an embedded composition: the product
  // resolved its own `agents/<agentId>` home and holds its own writer lease.
  return {
    taskId: 'task-embedded-1',
    tenantId: 'tenant-embedded',
    deviceId: 'device-embedded',
    agentRef: { agentId: 'analyst', profileRevision: 'sha256:profile-rev-1' },
    sessionRef: 'session-embedded-1',
    runtimeId: 'claude',
    canonicalHome: '/opt/host/state/agents/analyst',
    leaseId: 'lease-embedded-1',
    homeIdentity: { dev: 42n, ino: 4242n },
    filesystem,
  };
}

/** Drives the stdio server the way a runtime's MCP client would. */
async function mcpRoundTrip(
  deps: AgentMemoryMcpDeps,
  requests: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  serveAgentMemoryMcpOverStdio({ deps, stdin, stdout });

  const responses: Record<string, unknown>[] = [];
  const collected = new Promise<void>((resolve) => {
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
        if (responses.length === requests.length) resolve();
        index = buffer.indexOf('\n');
      }
    });
  });

  for (const request of requests) stdin.write(`${JSON.stringify(request)}\n`);
  await collected;
  return responses;
}

function toolResult(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as { content: { text: string }[] } | undefined;
  if (result === undefined) throw new Error(`expected a tool result, got ${JSON.stringify(response)}`);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('an embedded host composing agent memory without a daemon', () => {
  it('serves recall and save over stdio against its own Agent home', async () => {
    const home = new InMemoryAgentHome({ 'MEMORY.md': '# index\n' });
    const service = new AgentMemoryService(embeddedContext(home));

    const [listed, recalled] = await mcpRoundTrip(service, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: AGENT_MEMORY_RECALL_TOOL_NAME, arguments: { path: 'MEMORY.md' } },
      },
    ]);

    const tools = (listed!.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toEqual([AGENT_MEMORY_RECALL_TOOL_NAME, AGENT_MEMORY_SAVE_TOOL_NAME]);
    expect(toolResult(recalled!)).toMatchObject({ path: 'MEMORY.md', content: '# index\n' });

    const saved = await service.save({
      op: 'replace',
      path: 'notes/pricing.md',
      expectedRevision: revisionOf(''),
      content: 'durable note\n',
    });
    expect(saved).toMatchObject({ path: 'notes/pricing.md', deleted: false });
    expect(home.files.get('notes/pricing.md')).toBe('durable note\n');

    // The audit authority is not something the daemon adds on top: it is inside
    // the service, so an embedded host gets it without asking and cannot serve
    // memory without it.
    const audit = (home.files.get('.byok/agent-memory-audit-v1.jsonl') ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((entry) => entry.kind)).toEqual(['recall', 'save']);
    expect(audit.every((entry) => entry.taskId === 'task-embedded-1' && entry.sessionRef === 'session-embedded-1')).toBe(true);
  });

  it('rejects a compare-and-swap the host did not win', async () => {
    const home = new InMemoryAgentHome({ 'MEMORY.md': '# index\n' });
    const service = new AgentMemoryService(embeddedContext(home));

    const [response] = await mcpRoundTrip(service, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: AGENT_MEMORY_SAVE_TOOL_NAME,
          arguments: {
            op: 'replace',
            path: 'MEMORY.md',
            expectedRevision: revisionOf('some other content'),
            content: 'clobbered',
          },
        },
      },
    ]);

    expect(response!.error).toBeDefined();
    expect(home.files.get('MEMORY.md')).toBe('# index\n');
  });

  it('refuses a path outside the memory contract', async () => {
    const home = new InMemoryAgentHome({ 'MEMORY.md': '# index\n' });
    const service = new AgentMemoryService(embeddedContext(home));

    const [escape, secret] = await mcpRoundTrip(service, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: AGENT_MEMORY_RECALL_TOOL_NAME, arguments: { path: 'notes/../../escape.md' } },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: AGENT_MEMORY_RECALL_TOOL_NAME, arguments: { path: 'notes/api-key.md' } },
      },
    ]);

    expect(escape!.error).toBeDefined();
    expect(secret!.error).toBeDefined();
  });

  it('snapshots the home after the session closes', async () => {
    const home = new InMemoryAgentHome({ 'MEMORY.md': '# index\n', 'notes/pricing.md': 'durable note\n' });
    const context = embeddedContext(home);

    const snapshot = await captureAgentMemorySnapshot(context);

    expect(snapshot.files.map((file) => file.path)).toEqual(['MEMORY.md', 'notes/pricing.md']);
    expect(snapshot.totalBytes).toBe(
      Buffer.byteLength('# index\n', 'utf8') + Buffer.byteLength('durable note\n', 'utf8'),
    );
  });

  it('prepends the same memory guidance the daemon task runner uses', () => {
    const instruction = prependAgentMemoryGuidance('summarize the account');
    expect(instruction.endsWith('\n\nsummarize the account')).toBe(true);
    expect(instruction).toContain('MEMORY.md');
    expect(instruction).toContain('notes/');
  });
});
