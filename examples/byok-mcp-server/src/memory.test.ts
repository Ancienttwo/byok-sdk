import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { HostLedger, HostMemoryPage, memoryRevision, EMPTY_MEMORY_REVISION, RESIDENT_MEMORY_MAX_BYTES } from '@byok-sdk/server/execution-core';
import type { AgentMemoryProjectionPlainMutation, AgentRef } from '@byok-sdk/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { BetaLedger, createBetaMcpServer, createMemoryTools, type KeySpec } from './index';
import { call, cleanup, connect } from './tools.test-support';

afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
type Client = Awaited<ReturnType<typeof connect>>;
const main: AgentRef = { agentId: 'main', profileRevision: '1' };
const other: AgentRef = { agentId: 'other', profileRevision: '1' };

/**
 * A Host with K4's memory page and the beta MCP endpoint on a loopback origin. The device's side is synthetic:
 * tests publish redacted `agent.memory.projection` mutations through the page's own device port.
 */
async function openMemoryHost() {
  const root = mkdtempSync(join(tmpdir(), 'b5-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const hostLedger = new HostLedger(join(root, 'host.sqlite'), 'product:b5-test'); cleanup.push(() => hostLedger.close());
  const host = { placements: new Map<string, string>([['main', 'device-a'], ['other', 'device-a']]),
    profiles: new Map<string, string>([['main', '1'], ['other', '1']]), grants: new Set(['grant-1']) };
  const page = new HostMemoryPage(hostLedger, {
    isCurrent: binding => host.placements.get(binding.agentRef.agentId) === binding.deviceId
      && host.profiles.get(binding.agentRef.agentId) === binding.agentRef.profileRevision,
    notify: async () => undefined,
    authorizeProjection: (_deviceId, mutation) => host.grants.has(mutation.grantRef),
  });
  const ledger = new BetaLedger(join(root, 'beta.sqlite'), 'tenant-b5'); cleanup.push(() => ledger.close());
  let endpoint: ReturnType<typeof createBetaMcpServer> | undefined;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => endpoint!.fetch(request) });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const placement = vi.fn((agentRef: Readonly<AgentRef>) => host.placements.get(agentRef.agentId));
  endpoint = createBetaMcpServer({ ledger, origin, serverInfo: { name: 'B5 test host', version: '1' },
    tools: createMemoryTools({ ledger, memory: page, placement }) });
  cleanup.push(async () => {
    endpoint!.close(); if ('closeAllConnections' in http) http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const sequence = new Map<string, number>();
  /** One redacted snapshot from the device, in K4's resident-memory profile. */
  const project = async (residentMemory: string | null, rest: Partial<AgentMemoryProjectionPlainMutation> = {}) => {
    const agentRef = rest.agentRef ?? main;
    const sourceSeq = (sequence.get(agentRef.agentId) ?? 0) + 1; sequence.set(agentRef.agentId, sourceSeq);
    const bytes = JSON.stringify({ residentMemory });
    const mutation: AgentMemoryProjectionPlainMutation = { taskId: `task-${sourceSeq}`, agentRef, sessionRef: 'session', runtimeId: 'pi',
      grantRef: 'grant-1', writerEpoch: 1, sourceSeq, mutationId: randomUUID(), policyRevision: 'policy-1',
      snapshot: { redactedHash: memoryRevision(bytes), redactedByteCount: Buffer.byteLength(bytes), redactedBytes: Buffer.from(bytes).toString('base64url') },
      ...rest };
    expect(await page.projectionPort('device-a').publish({ mutation })).toEqual({ accepted: true });
    return mutation;
  };
  const spec = (rest: Partial<KeySpec> = {}): KeySpec => ({ label: 'Bot A', scopes: ['memory.read'], deviceIds: ['device-a'],
    runtimes: ['pi'], agentRef: main, ...rest });
  return { host, page, ledger, placement, project, spec, url: new URL('/mcp', origin) };
}
const read = (client: Client, args: Record<string, unknown> = {}) => call(client, 'byok_memory_read', args);
async function refused(client: Client, args: Record<string, unknown> = {}) {
  const result = await read(client, args); expect(result.isError).toBe(true); return result.value as { code: string; message: string };
}

it('reads the redacted MEMORY.md projection the Host holds, with its revision and time, and follows newer projections', async () => {
  const { ledger, project, spec, url } = await openMemoryHost();
  const client = await connect({ url }, ledger.issueKey(spec()).token);
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toEqual(['byok_memory_read']);
  expect(tools[0]!.description).toMatch(/^Read the byok Agent-home memory \(MEMORY\.md\) of the byok Agent bound to this key\. This is not your own conversation memory\./);

  // Nothing projected yet.
  expect(await read(client)).toEqual({ isError: false, value: { path: 'MEMORY.md', text: null } });

  const first = await project('Prefers short reports. [redacted]');
  const before = Date.now();
  const firstRead = await read(client);
  expect(firstRead).toEqual({ isError: false, value: { path: 'MEMORY.md', text: 'Prefers short reports. [redacted]',
    revision: first.mutationId, projectedAt: expect.any(String) } });
  expect(Date.parse(firstRead.value.projectedAt)).toBeLessThanOrEqual(before);
  expect(await read(client, { path: 'MEMORY.md' })).toEqual(firstRead);

  const second = await project('Prefers bullet lists.');
  expect((await read(client)).value).toMatchObject({ text: 'Prefers bullet lists.', revision: second.mutationId });
  // A projection whose policy shows no resident memory reads as null.
  await project(null);
  expect((await read(client)).value).toEqual({ path: 'MEMORY.md', text: null });
});

it('hides a projection that an applied MEMORY.md write made stale until the refreshed projection arrives', async () => {
  const { page, ledger, project, spec, url } = await openMemoryHost();
  const client = await connect({ url }, ledger.issueKey(spec()).token);
  await project('Old memory.');
  // A Host-approved write applies on the device (K4 intent path); the old projection no longer describes MEMORY.md.
  const { intent } = await page.approve({ deviceId: 'device-a', agentRef: main, approvalRef: randomUUID(), path: 'MEMORY.md',
    operation: 'replace', content: 'New memory.', baseRevision: EMPTY_MEMORY_REVISION, expiresAt: Date.now() + 60_000 });
  const transport = page.transport('device-a');
  await transport.fetch({ intentId: intent.intentId, agentRef: main, reservation: 'held' });
  await transport.complete({ intentId: intent.intentId, agentRef: main, path: 'MEMORY.md', operation: 'replace',
    operationDigest: intent.operationDigest, outcome: 'applied', result: { exists: true, revision: memoryRevision('New memory.') } });
  expect((await read(client)).value).toEqual({ path: 'MEMORY.md', text: null });

  // The refresh execution's projection is current again.
  page.refreshExecution({ deviceId: 'device-a', agentRef: main }, 'refresh-task');
  const refreshed = await project('New memory.', { taskId: 'refresh-task' });
  expect((await read(client)).value).toMatchObject({ text: 'New memory.', revision: refreshed.mutationId });
});

it('reads only the key\'s own Agent and refuses bad input, a missing or ungranted placement and an unreadable projection', async () => {
  const { host, ledger, placement, project, spec, url } = await openMemoryHost();
  const client = await connect({ url }, ledger.issueKey(spec()).token);
  await project('Main memory.');
  await project('Other memory.', { agentRef: other });

  // Each key reads its own AgentRef; arguments never select another Agent.
  const otherClient = await connect({ url }, ledger.issueKey(spec({ label: 'Bot B', agentRef: other })).token);
  expect((await read(otherClient)).value).toMatchObject({ text: 'Other memory.' });
  expect((await read(client)).value).toMatchObject({ text: 'Main memory.' });
  expect(placement.mock.calls.map(([agentRef]) => agentRef)).toEqual([other, main]);

  placement.mockClear();
  for (const args of [{ path: 'notes/plan.md' }, { path: '../MEMORY.md' }, { path: 1 }, { agentRef: other }, { deviceId: 'device-a' }]) {
    expect((await refused(client, args)).code).toBe('invalid_input');
  }
  expect(await refused(client, { path: 'notes/plan.md' })).toEqual({ code: 'invalid_input', message: 'path must be MEMORY.md; the Host projects no notes/ files' });
  expect(placement).not.toHaveBeenCalled();

  host.placements.delete('main');
  expect(await refused(client)).toEqual({ code: 'unavailable', message: 'The byok Agent has no current device', retryAfterSeconds: 60 });
  host.placements.set('main', 'device-b');
  expect(await refused(client)).toEqual({ code: 'forbidden', message: 'Device or runtime not granted' });
  host.placements.set('main', 'device-a');

  const unreadable = { code: 'unavailable', message: 'The byok Agent memory is not readable now. The Host owner must check its placement, projection grant and size.' };
  // The Agent profile moved past the key's AgentRef.
  host.profiles.set('main', '2');
  expect(await refused(client)).toEqual(unreadable);
  host.profiles.set('main', '1');
  // The Host revoked the projection grant.
  host.grants.delete('grant-1');
  expect(await refused(client)).toEqual(unreadable);
  host.grants.add('grant-1');
  expect((await read(client)).value).toMatchObject({ text: 'Main memory.' });
  // MEMORY.md beyond K4's resident limit.
  await project('x'.repeat(RESIDENT_MEMORY_MAX_BYTES + 1));
  expect(await refused(client)).toEqual(unreadable);
});

it('lists the tool only for memory.read keys and stops a revoked key', async () => {
  const { ledger, project, spec, url } = await openMemoryHost();
  await project('Main memory.');
  // A key without memory.read gets no tool from this catalogue.
  const tasksOnly = ledger.issueKey({ label: 'Bot C', scopes: ['tasks.read'], deviceIds: ['device-a'], runtimes: ['pi'] });
  const denied = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${tasksOnly.token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'probe', version: '1' } } }) });
  expect(denied.status).toBe(403);

  const issued = ledger.issueKey(spec());
  const client = await connect({ url }, issued.token);
  expect((await read(client)).value).toMatchObject({ text: 'Main memory.' });
  ledger.revokeKey(issued.key.keyId);
  await expect(read(client)).rejects.toThrow();
});
