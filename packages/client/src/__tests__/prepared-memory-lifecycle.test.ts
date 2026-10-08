import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../daemon/task-runner';

// Exercise the public IPC handlers and their real active-task identity gate.
// Only the filesystem boundary is replaced: denial must occur before it.
function runner(mode: 'read' | 'read-write') {
  const token = 'sealed-task-token';
  const agentRef = { agentId: 'agent', profileRevision: 'r1' };
  const filesystem = vi.fn(async () => { throw new Error('filesystem boundary reached'); });
  const active = {
    agentRef, agentBinding: {
      resolution: { agentRef, canonicalHome: '/agents/agent' },
      lease: { leaseId: 'lease-1', cwd: '/agents/agent', canonicalHome: '/agents/agent', homeIdentity: {} },
    },
    agentHandoff: { sessionRef: 'session-1', runtimeId: 'pi', cwd: '/agents/agent' },
    session: { sessionRef: 'session-1' }, adapter: { descriptor: { id: 'pi' } },
  };
  const subject = Object.assign(Object.create(TaskRunner.prototype) as object, {
    deps: { tenantId: 'tenant', deviceId: 'device' },
    memoryContextByToken: new Map([[token, { taskId: 'task', agentRef, mode }]]),
    memoryContextByTask: new Map([['task', token]]),
    memoryClosingTasks: new Set(), tasks: new Map([['task', active]]),
    bindAgentMemoryFilesystem: filesystem,
  }) as unknown as TaskRunner;
  return { subject, token, filesystem, active };
}
const write = { op: 'replace' as const, path: 'MEMORY.md', expectedRevision: 'sha256:old', content: 'new' };

describe('prepared memory authority at the daemon IPC boundary', () => {
  it('rejects a direct save with a read token before opening the filesystem', async () => {
    const fixture = runner('read');
    await expect(fixture.subject.saveAgentMemory({ contextToken: fixture.token, ...write })).rejects.toThrow('write denied');
    expect(fixture.filesystem).not.toHaveBeenCalled();
  });

  it('permits the explicit read-write token to reach the secure filesystem boundary', async () => {
    const fixture = runner('read-write');
    await expect(fixture.subject.saveAgentMemory({ contextToken: fixture.token, ...write })).rejects.toThrow('filesystem boundary reached');
    expect(fixture.filesystem).toHaveBeenCalledOnce();
  });

  it('refuses an expired token and a token whose active session identity changed', async () => {
    const fixture = runner('read-write');
    await expect(fixture.subject.saveAgentMemory({ contextToken: 'expired', ...write })).rejects.toThrow('invalid, expired');
    fixture.active.session.sessionRef = 'replacement-session';
    await expect(fixture.subject.saveAgentMemory({ contextToken: fixture.token, ...write })).rejects.toThrow('exact active task identity');
    expect(fixture.filesystem).not.toHaveBeenCalled();
  });
});
