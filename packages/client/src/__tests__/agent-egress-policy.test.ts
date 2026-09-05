import { describe, expect, it } from 'vitest';
import { createEnvelope, encodeEnvelope, type AgentEgressPolicy } from '@byok-sdk/protocol';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import {
  DEFAULT_AGENT_EGRESS_POLICY,
  AgentEgressPolicyError,
  resolveAgentEgressPolicy,
} from '../daemon/agent-egress-policy';
import { sanitizeEgressEnvelope } from '../daemon/agent-egress-sanitizer';

const agentRef = { agentId: 'agent-egress-policy', profileRevision: 'r1' };

describe('Agent egress policy and sanitizer', () => {
  it('removes trajectory/tool/prompt/environment/argv/path/credential bytes before either wire encoding', () => {
    const secret = 'trajectory SECRET=do-not-send /private/path --argv dangerous';
    const envelope = createEnvelope('task.progress', {
      seq: 1,
      events: [
        { type: 'progress', text: secret },
        { type: 'tool_use', tool: '/private/path/tool', input: { prompt: secret, env: { SECRET: secret }, argv: [secret] } },
        { type: 'tool_result', tool: '/private/path/tool', output: { credential: secret } },
      ],
    }, { taskId: 'task-egress-policy', seq: 1 });

    const sanitized = sanitizeEgressEnvelope(envelope, DEFAULT_AGENT_EGRESS_POLICY, undefined);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    // WS uses `encodeEnvelope`; long-poll serializes the same frozen envelope
    // inside its JSON request. Both views must contain zero original bytes.
    const wsWire = encodeEnvelope(sanitized.envelope);
    const longPollWire = JSON.stringify({ messages: [sanitized.envelope] });
    for (const wire of [wsWire, longPollWire]) {
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain('/private/path/tool');
      expect(wire).not.toContain('credential');
      expect(wire).toContain('[content omitted]');
    }
  });

  it('fails closed when the configured sanitizer throws and never returns the raw envelope', () => {
    const envelope = createEnvelope('task.progress', {
      seq: 1,
      events: [{ type: 'progress', text: 'raw-only-if-bug' }],
    }, { taskId: 'task-sanitizer-throws', seq: 1 });
    const sanitized = sanitizeEgressEnvelope(envelope, {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      activity: { mode: 'contentful-trajectory', delivery: 'latest-value', maxCoalesceMs: 100, maxEventBytes: 4096 },
    }, () => { throw new Error('refuse'); });
    expect(sanitized).toEqual({ ok: false, reason: 'sanitizer_rejected' });
  });

  it('requires the exact negotiated policy capability before contentful trajectory can leave latest-value state', () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'contentful-r1',
      activity: { mode: 'contentful-trajectory', delivery: 'latest-value', maxCoalesceMs: 100, maxEventBytes: 4096 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-egress' });
    expect(controller.projectLatestValue({
      agentRef,
      taskId: 'task-contentful',
      events: [{ type: 'progress', text: 'not-without-capability' }],
      serverCapabilities: [],
    })).toEqual([]);
    expect(controller.projectLatestValue({
      agentRef,
      taskId: 'task-contentful',
      events: [{ type: 'progress', text: 'explicit-and-capable' }],
      serverCapabilities: ['agent-egress-policy'],
    })).toEqual([{ type: 'progress', text: 'explicit-and-capable' }]);
    expect(controller.status().latestValue.lastDropReason).toBe('capability_missing');
  });

  it('does not reclassify a legacy task that has no AgentRef into the Agent egress lane', () => {
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY });
    const events = [{ type: 'progress', text: 'legacy task reason and progress remain unchanged' }] as const;
    expect(controller.projectLatestValue({
      taskId: 'legacy-task',
      events,
      serverCapabilities: [],
    })).toEqual(events);
  });

  it('never lets a spill descriptor (a readable blob locator) survive metadata-status projection', () => {
    const blobId = 'blob_spilled_tool_output';
    const spill = {
      field: 'output' as const,
      totalBytes: 3_145_728,
      omittedBytes: 3_145_700,
      contentType: 'application/json' as const,
      blob: {
        blobId,
        contentHash: `sha256:${'c'.repeat(64)}`,
        size: 3_145_728,
        contentType: 'application/json',
      },
    };
    const envelope = createEnvelope('task.progress', {
      seq: 1,
      events: [
        { type: 'tool_result', tool: 'bash', isError: false, output: { preview: { head: 'HEAD-BYTES', tail: 'TAIL-BYTES' } }, spill },
        { type: 'tool_use', tool: 'write_file', input: { preview: { head: 'IN-HEAD', tail: 'IN-TAIL' } }, spill: { ...spill, field: 'input' as const } },
      ],
    }, { taskId: 'task-egress-omission', seq: 1 });

    const sanitized = sanitizeEgressEnvelope(envelope, DEFAULT_AGENT_EGRESS_POLICY, undefined);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    const events = (sanitized.envelope.payload as { events: unknown[] }).events;
    expect(events).toEqual([
      { type: 'tool_result', tool: '[tool omitted]', isError: false },
      { type: 'tool_use', tool: '[tool omitted]' },
    ]);
    for (const wire of [encodeEnvelope(sanitized.envelope), JSON.stringify({ messages: [sanitized.envelope] })]) {
      expect(wire).not.toContain(blobId);
      expect(wire).not.toContain('spill');
      expect(wire).not.toContain('HEAD-BYTES');
      expect(wire).not.toContain('3145728');
    }

    // Same guarantee through the controller's own latest-value projection.
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY });
    const projected = controller.projectLatestValue({
      taskId: 'task-egress-omission',
      agentRef,
      events: [{ type: 'tool_result', tool: 'bash', output: { preview: { head: 'x', tail: 'y' } }, spill }],
      serverCapabilities: ['agent-egress'],
    });
    expect(JSON.stringify(projected)).not.toContain('spill');
    expect(JSON.stringify(projected)).not.toContain(blobId);
  });

  it('rejects malformed policy instead of silently selecting contentful semantics', () => {
    expect(() => resolveAgentEgressPolicy({
      ...DEFAULT_AGENT_EGRESS_POLICY,
      activity: { mode: 'contentful-trajectory', delivery: 'latest-value', maxCoalesceMs: 0, maxEventBytes: 1 },
    } as unknown as AgentEgressPolicy)).toThrow(AgentEgressPolicyError);
  });
});
