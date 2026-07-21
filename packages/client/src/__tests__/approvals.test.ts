import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNotFoundError, ApprovalRegistry, MAX_PENDING_APPROVALS, type PendingApproval } from '../daemon/approvals';

function approval(approvalId: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return { approvalId, taskId: `task-for-${approvalId}`, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
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

  it('resolve() invokes the onResolve callback with the decision and reason, and removes the entry', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    registry.resolve('a1', 'approve');
    expect(onResolve).toHaveBeenCalledWith('approve', undefined);
    expect(registry.list()).toEqual([]);
  });

  it('resolve() passes a reject reason through to the callback', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    registry.resolve('a1', 'reject', 'not allowed');
    expect(onResolve).toHaveBeenCalledWith('reject', 'not allowed');
  });

  it('resolve() of an unknown id throws ApprovalNotFoundError and does not call anything', () => {
    const registry = new ApprovalRegistry();
    const onResolve = vi.fn();
    registry.register(approval('a1'), onResolve);

    expect(() => registry.resolve('does-not-exist', 'approve')).toThrow(ApprovalNotFoundError);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('resolve() of an already-resolved id throws ApprovalNotFoundError (not a double-resolve)', () => {
    const registry = new ApprovalRegistry();
    registry.register(approval('a1'), () => {});
    registry.resolve('a1', 'approve');

    expect(() => registry.resolve('a1', 'approve')).toThrow(ApprovalNotFoundError);
  });

  it('ApprovalNotFoundError carries the id in its message', () => {
    const registry = new ApprovalRegistry();
    try {
      registry.resolve('mystery-id', 'approve');
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
    const [decision, reason] = evictedOnResolve.mock.calls[0] as [string, string | undefined];
    expect(decision).toBe('reject');
    expect(reason).toMatch(/evicted/i);
    // Resolved, not just notified — a future resolve('a0', ...) call must
    // fail not_found, same as any other already-resolved id.
    expect(() => registry.resolve('a0', 'approve')).toThrow(ApprovalNotFoundError);
  });
});
