import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { sealRuntimeOperationManifest } from '../types';
import { projectRuntimeBoundaryFailure } from '../runtime-failure';
import {
  evaluateBeforeToolRequest, formatToolExecutionDenial, normalizeBeforeToolOptions,
  parseToolExecutionGateConfig, requestToolExecutionDecision, startToolExecutionGate,
  ToolExecutionUnsupportedError, type BeforeToolOptions, type BeforeToolRequest, type ToolExecutionCall,
} from '../tool-execution-hook';

const call: ToolExecutionCall = {
  toolCallId: 'write-1', toolName: 'write', input: { path: '/workspace/report.md', content: 'report' },
  cwd: '/workspace', paths: ['/workspace/report.md'],
};
const request: Omit<BeforeToolRequest, 'signal'> = { ...call, taskId: 'parent-task', runtimeId: 'pi' };
const manifest = sealRuntimeOperationManifest({
  taskId: 'parent-task', runtimeId: 'pi', agentRef: { agentId: 'research', profileRevision: 'v1' },
  descriptor: { id: 'pi', supportsDispatchSelection: true, capabilities: { steer: true, resume: true, approvalInteractive: false, beforeTool: true } },
  requiredToolsetIds: [], cwd: '/workspace', workspace: { workspaceDir: '/workspace' }, forwardedEnvironmentNames: [],
});
const gates: Awaited<ReturnType<typeof startToolExecutionGate>>[] = [];
afterEach(async () => { await Promise.all(gates.splice(0).map(gate => gate.close())); });

describe('local pre-tool decisions', () => {
  it('preserves the Host denial reason and distinguishes it from ordinary execution failure', async () => {
    const verdict = await evaluateBeforeToolRequest({ onRequest: () => ({ decision: 'deny', reason: '请主人授权：报告外发' }) }, request);
    expect(verdict).toEqual({ decision: 'deny', code: 'tool_policy_denied', reason: '请主人授权：报告外发' });
    if (verdict.decision !== 'deny') throw new Error('expected denial');
    expect(formatToolExecutionDenial(verdict)).toBe('tool_policy_denied: 请主人授权：报告外发');
  });

  it.each([
    () => { throw new Error('secret callback details'); },
    () => Promise.reject(new Error('secret callback details')),
    () => ({ decision: 'maybe' }),
    () => null,
  ])('fails closed on a throwing or invalid callback without leaking exception text', async onRequest => {
    const verdict = await evaluateBeforeToolRequest({ onRequest } as BeforeToolOptions, request);
    expect(verdict).toEqual({
      decision: 'deny', code: 'tool_policy_error', reason: expect.not.stringContaining('secret'),
    });
  });

  it('settles on timeout and aborts the callback; a late allow cannot replace the denial', async () => {
    let captured: AbortSignal | undefined;
    let allow!: (value: { decision: 'allow' }) => void;
    const pending = evaluateBeforeToolRequest({ timeoutMs: 10, onRequest: input => {
      captured = input.signal;
      return new Promise(resolve => { allow = resolve; });
    } }, request);
    expect(await pending).toMatchObject({ decision: 'deny', code: 'tool_policy_timeout' });
    expect(captured?.aborted).toBe(true);
    allow({ decision: 'allow' });
    expect(await pending).toMatchObject({ decision: 'deny', code: 'tool_policy_timeout' });
  });

  it('does not invoke a callback after session disposal', async () => {
    const controller = new AbortController(); controller.abort();
    const onRequest = vi.fn(() => ({ decision: 'allow' as const }));
    expect(await evaluateBeforeToolRequest({ onRequest }, request, controller.signal)).toMatchObject({ code: 'tool_policy_unavailable' });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid deadlines and preserves capability in a sealed manifest', () => {
    for (const timeoutMs of [0, -1, 1.5, 60_001, Infinity]) {
      expect(() => normalizeBeforeToolOptions({ timeoutMs, onRequest: () => ({ decision: 'allow' }) })).toThrow('timeoutMs');
    }
    expect(manifest.descriptor.capabilities.beforeTool).toBe(true);
  });
});

describe('authenticated loopback IPC', () => {
  it('binds child calls to the parent task and Agent rather than child-supplied identity', async () => {
    const seen: BeforeToolRequest[] = [];
    const gate = await startToolExecutionGate({ manifest, runtimeId: 'pi', options: { onRequest: input => {
      seen.push(input); return { decision: 'allow' };
    } } }); gates.push(gate);
    expect(await requestToolExecutionDecision(gate.config, { ...call, nativeAgentId: 'child', taskId: 'spoofed' } as ToolExecutionCall)).toEqual({ decision: 'allow' });
    expect(seen[0]).toMatchObject({ taskId: 'parent-task', agentRef: manifest.agentRef, nativeAgentId: 'child', cwd: call.cwd, paths: call.paths });
    expect(parseToolExecutionGateConfig(gate.config)).toEqual(gate.config);
    await expect(requestToolExecutionDecision({ ...gate.config, token: 'wrong' }, call)).resolves.toMatchObject({ code: 'tool_policy_unavailable' });
    expect(seen).toHaveLength(1);
    await gate.close();
    expect(await requestToolExecutionDecision(gate.config, call)).toMatchObject({ code: 'tool_policy_unavailable' });
  });

  it('does not call the Host for malformed IPC input', async () => {
    const onRequest = vi.fn(() => ({ decision: 'allow' as const }));
    const gate = await startToolExecutionGate({ manifest, runtimeId: 'pi', options: { onRequest } }); gates.push(gate);
    const response = await fetch(gate.config.url, { method: 'POST', headers: { authorization: `Bearer ${gate.config.token}` }, body: '{}' });
    expect(await response.json()).toMatchObject({ code: 'tool_policy_error' });
    expect(onRequest).not.toHaveBeenCalled();
    expect(() => parseToolExecutionGateConfig({ ...gate.config, url: 'https://example.com/before-tool' })).toThrow('loopback');
  });
});

describe('unsupported adapters', () => {
  it('preserves unsupported classification across the daemon start boundary', () => {
    const error = new ToolExecutionUnsupportedError('claude', 'registration unavailable');
    expect(projectRuntimeBoundaryFailure(error, 'start')).toEqual({
      reason: error.message, retryable: false, failure: { class: 'unknown' }, contractViolation: false,
    });
    expect(projectRuntimeBoundaryFailure(error, 'run').contractViolation).toBe(true);
  });
  it.each([CodexAdapter, GrokAdapter])('rejects opt-in before any runtime launch and leaves default behavior available', Adapter => {
    expect(() => new Adapter()).not.toThrow();
    expect(() => new Adapter({ beforeTool: { onRequest: () => ({ decision: 'allow' }) } })).toThrow(ToolExecutionUnsupportedError);
    try { new Adapter({ beforeTool: { onRequest: () => ({ decision: 'allow' }) } }); }
    catch (error) { expect(error).toMatchObject({ code: 'tool_execution_hook_unsupported' }); }
    expect(new Adapter().descriptor.capabilities.beforeTool).not.toBe(true);
  });
});
