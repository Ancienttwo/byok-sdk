import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_REQUIRES_HOST, ApprovalNotFoundError, ApprovalRegistry, ApprovalRequiresHostError, MAX_PENDING_APPROVALS, type PendingApproval } from '../daemon/approvals';

function approval(approvalId: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return { approvalId, taskId: `task-for-${approvalId}`, kind: 'task-terminal', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('ApprovalRegistry', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => {
    warnSpy.mockClear();
  });

  it('list() is empty when nothing has been registered', () => {
    const registry = new ApprovalRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('register() then list() returns exactly what was registered', () => {
    const registry = new ApprovalRegistry();
    registry.register(approval('a1'), () => {});
    registry.register(approval('a2', { summary: 'run rm -rf /tmp/x' }), () => {});
    expect(registry.list()).toEqual([approval('a1'), approval('a2', { summary: 'run rm -rf /tmp/x' })]);
  });

  it('resolve() invokes the onResolve callback with the decision, reason, and origin, and removes the entry', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    registry.resolve('a1', 'approve', undefined, 'in-process');
    expect(onResolve).toHaveBeenCalledWith('approve', undefined, 'in-process');
    expect(registry.list()).toEqual([]);
  });

  it('resolve() passes a reject reason through to the callback, with its origin', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    registry.resolve('a1', 'reject', 'not allowed', 'control');
    expect(onResolve).toHaveBeenCalledWith('reject', 'not allowed', 'control');
  });

  it('resolve() forwards an explicit origin (the wire-relay closure in task-runner.ts passes "wire")', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    registry.resolve('a1', 'approve', undefined, 'wire');
    expect(onResolve).toHaveBeenCalledWith('approve', undefined, 'wire');
  });

  it('resolve() of an unknown id throws ApprovalNotFoundError and does not call anything', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    expect(() => registry.resolve('does-not-exist', 'approve', undefined, 'control')).toThrow(ApprovalNotFoundError);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('resolve() of an already-resolved id throws ApprovalNotFoundError (not a double-resolve)', () => {
    const registry = new ApprovalRegistry();
    registry.register(approval('a1'), () => {});
    registry.resolve('a1', 'approve', undefined, 'control');

    expect(() => registry.resolve('a1', 'approve', undefined, 'control')).toThrow(ApprovalNotFoundError);
  });

  it('ApprovalNotFoundError carries the id in its message', () => {
    const registry = new ApprovalRegistry();
    try {
      registry.resolve('mystery-id', 'approve', undefined, 'control');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalNotFoundError);
      expect((err as Error).message).toContain('mystery-id');
    }
  });

  it('is bounded: registering past MAX_PENDING_APPROVALS evicts the oldest entry and logs a warning', () => {
    const registry = new ApprovalRegistry();
    const evictedOnResolve = vi.fn();
    registry.register(approval('a0'), evictedOnResolve);
    for (let i = 1; i < MAX_PENDING_APPROVALS; i++) {
      registry.register(approval(`a${i}`), () => {});
    }
    expect(registry.list()).toHaveLength(MAX_PENDING_APPROVALS);
    expect(registry.list().some((entry) => entry.approvalId === 'a0')).toBe(true);

    registry.register(approval('overflow'), () => {});

    expect(registry.list()).toHaveLength(MAX_PENDING_APPROVALS); // still bounded, not MAX+1
    expect(registry.list().some((entry) => entry.approvalId === 'a0')).toBe(false); // oldest evicted
    expect(registry.list().some((entry) => entry.approvalId === 'overflow')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('eviction does not strand the evicted entry: its onResolve fires as a reject, naming the eviction, instead of being silently dropped', () => {
    const registry = new ApprovalRegistry();
    const evictedOnResolve = vi.fn();
    registry.register(approval('a0'), evictedOnResolve);
    for (let i = 1; i < MAX_PENDING_APPROVALS; i++) {
      registry.register(approval(`a${i}`), () => {});
    }
    expect(evictedOnResolve).not.toHaveBeenCalled();

    registry.register(approval('overflow'), () => {});

    expect(evictedOnResolve).toHaveBeenCalledTimes(1);
    const [decision, reason, origin] = evictedOnResolve.mock.calls[0] as [string, string | undefined, string];
    expect(decision).toBe('reject');
    expect(reason).toMatch(/evicted/i);
    // An eviction is this registry's own fail-closed bookkeeping, never a
    // relayed server decision (see `ApprovalOrigin`).
    expect(origin).toBe('fail-closed');
    // Resolved, not just notified — a future resolve('a0', ...) call must
    // fail not_found, same as any other already-resolved id.
    expect(() => registry.resolve('a0', 'approve', undefined, 'control')).toThrow(ApprovalNotFoundError);
  });

  describe('tool-authorization approvals (#1101)', () => {
    const tool = (id: string) => approval(id, { kind: 'tool-authorization', summary: 'bash: sudo true' });

    it('list() returns each approval with its kind', () => {
      const registry = new ApprovalRegistry();
      registry.register(approval('t1'), () => {});
      registry.register(tool('a1'), () => {});
      expect(registry.list().map(entry => [entry.approvalId, entry.kind])).toEqual([['t1', 'task-terminal'], ['a1', 'tool-authorization']]);
    });

    it('a control approve throws ApprovalRequiresHostError with the stable code and leaves the approval pending', () => {
      const registry = new ApprovalRegistry();
      const onResolve = vi.fn();
      registry.register(tool('a1'), onResolve);
      try {
        registry.resolve('a1', 'approve', undefined, 'control');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApprovalRequiresHostError);
        expect((err as ApprovalRequiresHostError).code).toBe(APPROVAL_REQUIRES_HOST);
        expect(APPROVAL_REQUIRES_HOST).toBe('approval_requires_host');
      }
      expect(onResolve).not.toHaveBeenCalled();
      expect(registry.list()).toEqual([tool('a1')]);
    });

    it('a control reject still resolves it', () => {
      const registry = new ApprovalRegistry();
      const onResolve = vi.fn();
      registry.register(tool('a1'), onResolve);
      registry.resolve('a1', 'reject', 'no', 'control');
      expect(onResolve).toHaveBeenCalledWith('reject', 'no', 'control');
      expect(registry.list()).toEqual([]);
    });

    it.each(['wire', 'in-process'] as const)('a %s approve resolves it', origin => {
      const registry = new ApprovalRegistry();
      const onResolve = vi.fn();
      registry.register(tool('a1'), onResolve);
      registry.resolve('a1', 'approve', undefined, origin);
      expect(onResolve).toHaveBeenCalledWith('approve', undefined, origin);
    });

    it("localToolApproval: 'allow' lets a control approve resolve it", () => {
      const registry = new ApprovalRegistry({ localToolApproval: 'allow' });
      const onResolve = vi.fn();
      registry.register(tool('a1'), onResolve);
      registry.resolve('a1', 'approve', undefined, 'control');
      expect(onResolve).toHaveBeenCalledWith('approve', undefined, 'control');
    });

    it('a control approve of a task-terminal approval is unaffected', () => {
      const registry = new ApprovalRegistry();
      const onResolve = vi.fn();
      registry.register(approval('t1'), onResolve);
      registry.resolve('t1', 'approve', undefined, 'control');
      expect(onResolve).toHaveBeenCalledWith('approve', undefined, 'control');
    });
  });
});
