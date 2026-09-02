import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalTeamWorkspace,
  TEAM_WORKSPACE_DIRECTORY,
  TEAM_WORKSPACE_MAX_BODY_BYTES,
  TeamWorkspaceConflictError,
  TeamWorkspaceLeaseError,
  TeamWorkspaceQuotaError,
  TeamWorkspaceReceiptError,
  TeamWorkspaceValidationError,
} from '../daemon/team-workspace';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-team-workspace-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function limits(overrides: Partial<{ maxMembers: number; maxMessages: number; maxBytes: number }> = {}) {
  return { maxMembers: 4, maxMessages: 10, maxBytes: 1024, ...overrides };
}

describe('LocalTeamWorkspace', () => {
  it('persists ordered broadcast messages and reads them back after a service restart', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    const definition = await service.createWorkspace({ workspaceId: 'room', members: ['alice', 'bob'], limits: limits() });
    const alice = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    const bob = await service.createMemberLease({ workspaceId: 'room', memberId: 'bob' });

    const first = await service.postMessage({ lease: alice, body: 'one' });
    const second = await service.postMessage({ lease: bob, body: 'two', contentType: 'text/markdown' });
    expect(first).toMatchObject({ accepted: true, durable: true, seq: 1, memberId: 'alice' });
    expect(second).toMatchObject({ accepted: true, durable: true, seq: 2, memberId: 'bob' });
    expect(first.message.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const read = await service.readMessages({ lease: alice });
    expect(read.messages.map((message) => [message.seq, message.body, message.senderMemberId])).toEqual([
      [1, 'one', 'alice'],
      [2, 'two', 'bob'],
    ]);
    expect(read.deliveredThroughSeq).toBe(2);
    await service.ackMessages({ lease: alice, throughSeq: 2 });

    const restarted = new LocalTeamWorkspace(dir);
    const afterRestart = await restarted.readMessages({ lease: alice });
    expect(afterRestart.messages).toEqual([]);
    expect(afterRestart.receipt).toMatchObject({ acknowledgedThroughSeq: 2, deliveredThroughSeq: 2 });
    expect(await restarted.getWorkspace('room')).toEqual(definition);

    const statePath = path.join(dir, TEAM_WORKSPACE_DIRECTORY, 'state.json');
    const raw = await fs.readFile(statePath, 'utf8');
    expect(JSON.parse(raw).workspaces.room.messages).toHaveLength(2);
    if (process.platform !== 'win32') expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('requires exact leases, keeps lease material opaque, and revokes old bearers', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    await service.createWorkspace({ workspaceId: 'room', members: ['alice'], limits: limits() });
    const lease = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice', ttlMs: 10_000 });
    expect(lease.opaqueToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    await service.postMessage({ lease, body: 'before revoke' });
    await service.revokeMemberLease({ lease });
    await expect(service.postMessage({ lease, body: 'after revoke' })).rejects.toBeInstanceOf(TeamWorkspaceLeaseError);
    const raw = await fs.readFile(path.join(dir, TEAM_WORKSPACE_DIRECTORY, 'state.json'), 'utf8');
    expect(raw).not.toContain(lease.opaqueToken);

    const replacement = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    await expect(service.postMessage({ lease: { ...replacement, memberId: 'bob' }, body: 'wrong member' })).rejects.toBeInstanceOf(TeamWorkspaceLeaseError);
    expect((await service.validateMemberLease(replacement)).memberId).toBe('alice');
  });

  it('enforces delivery-before-ack and monotonic per-member receipts', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    await service.createWorkspace({ workspaceId: 'room', members: ['alice', 'bob'], limits: limits() });
    const alice = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    await service.postMessage({ lease: alice, body: 'message' });

    await expect(service.ackMessages({ lease: alice, throughSeq: 1 })).rejects.toBeInstanceOf(TeamWorkspaceReceiptError);
    const read = await service.readMessages({ lease: alice });
    expect(read.deliveredThroughSeq).toBe(1);
    await expect(service.ackMessages({ lease: alice, throughSeq: 2 })).rejects.toBeInstanceOf(TeamWorkspaceReceiptError);
    await service.ackMessages({ lease: alice, throughSeq: 1 });
    await expect(service.ackMessages({ lease: alice, throughSeq: 0 })).rejects.toBeInstanceOf(TeamWorkspaceReceiptError);
    expect((await service.readMessages({ lease: alice, afterSeq: 0 })).messages).toEqual([]);
  });

  it('fails closed at member, message, and byte quotas without truncating state', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    await service.createWorkspace({ workspaceId: 'room', members: ['alice'], limits: limits({ maxMembers: 1, maxMessages: 2, maxBytes: 5 }) });
    const alice = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    await expect(service.updateWorkspace({ workspaceId: 'room', expectedRevision: (await service.getWorkspace('room'))!.revision, members: ['alice', 'bob'] })).rejects.toBeInstanceOf(TeamWorkspaceQuotaError);
    await service.postMessage({ lease: alice, body: '12345' });
    await expect(service.postMessage({ lease: alice, body: '6' })).rejects.toBeInstanceOf(TeamWorkspaceQuotaError);
    await expect(service.postMessage({ lease: alice, body: '12345' })).rejects.toBeInstanceOf(TeamWorkspaceQuotaError);
    const restarted = new LocalTeamWorkspace(dir);
    const read = await restarted.readMessages({ lease: alice });
    expect(read.messages.map((message) => message.body)).toEqual(['12345']);
    const state = JSON.parse(await fs.readFile(path.join(dir, TEAM_WORKSPACE_DIRECTORY, 'state.json'), 'utf8'));
    expect(state.workspaces.room.messages.map((message: { body: string }) => message.body)).toEqual(['12345']);
  });

  it('serializes concurrent posts and rejects strict malformed IDs, bodies, and content types', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    await service.createWorkspace({ workspaceId: 'room', members: ['alice'], limits: limits({ maxMessages: 20, maxBytes: 20 * 20 }) });
    const lease = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    const receipts = await Promise.all(Array.from({ length: 10 }, (_, index) => service.postMessage({ lease, body: `m-${index}` })));
    expect(receipts.map((receipt) => receipt.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    const read = await service.readMessages({ lease, afterSeq: 0 });
    expect(read.messages.map((message) => message.seq)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));

    await expect(service.createWorkspace({ workspaceId: '../escape', members: ['alice'], limits: limits() })).rejects.toBeInstanceOf(TeamWorkspaceValidationError);
    await expect(service.postMessage({ lease, body: '' })).rejects.toBeInstanceOf(TeamWorkspaceValidationError);
    await expect(service.postMessage({ lease, body: 'x'.repeat(TEAM_WORKSPACE_MAX_BODY_BYTES + 1) })).rejects.toBeInstanceOf(TeamWorkspaceValidationError);
    await expect(service.postMessage({ lease, body: 'ok', contentType: 'text/plain\nmalicious' })).rejects.toBeInstanceOf(TeamWorkspaceValidationError);
  });

  it('uses an expected revision for member-set changes and invalidates all prior leases', async () => {
    const dir = await tempDir();
    const service = new LocalTeamWorkspace(dir);
    const initial = await service.createWorkspace({ workspaceId: 'room', members: ['alice'], limits: limits() });
    const alice = await service.createMemberLease({ workspaceId: 'room', memberId: 'alice' });
    const next = await service.updateWorkspace({ workspaceId: 'room', expectedRevision: initial.revision, members: ['alice', 'bob'] });
    expect(next.members).toEqual(['alice', 'bob']);
    await expect(service.postMessage({ lease: alice, body: 'stale' })).rejects.toBeInstanceOf(TeamWorkspaceLeaseError);
    await expect(service.updateWorkspace({ workspaceId: 'room', expectedRevision: initial.revision, members: ['alice'] })).rejects.toBeInstanceOf(TeamWorkspaceConflictError);
  });
});
