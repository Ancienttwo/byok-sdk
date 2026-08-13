import { describe, expect, it } from 'vitest';
import {
  MESSAGE_PAYLOAD_SCHEMAS,
  TaskOfferPayloadSchema,
  TaskOfferWithToolsetsPayloadSchema,
  ToolsetIdSchema,
  createEnvelope,
} from '../index';

describe('task.offer_with_toolsets additive control message', () => {
  it('carries only logical ids and validates as a distinct server-to-daemon message', () => {
    const envelope = createEnvelope(
      'task.offer_with_toolsets',
      {
        instruction: 'find qualified leads',
        policy: { mode: 'auto' },
        runtime: 'claude',
        requiredToolsets: ['salesko', 'crm.readonly'],
      },
      { taskId: 'task-toolsets-1', seq: 1 },
    );

    expect(envelope.type).toBe('task.offer_with_toolsets');
    expect(envelope.payload.requiredToolsets).toEqual(['salesko', 'crm.readonly']);
    expect(JSON.stringify(envelope)).not.toMatch(/command|args|env|header|secret/i);
  });

  it('rejects duplicate, malformed, empty, and oversized logical id sets', () => {
    const base = { instruction: 'x', policy: { mode: 'auto' as const } };
    expect(TaskOfferWithToolsetsPayloadSchema.safeParse({ ...base, requiredToolsets: [] }).success).toBe(false);
    expect(
      TaskOfferWithToolsetsPayloadSchema.safeParse({ ...base, requiredToolsets: ['salesko', 'salesko'] }).success,
    ).toBe(false);
    expect(TaskOfferWithToolsetsPayloadSchema.safeParse({ ...base, requiredToolsets: ['Salesko'] }).success).toBe(false);
    expect(
      TaskOfferWithToolsetsPayloadSchema.safeParse({
        ...base,
        requiredToolsets: Array.from({ length: 17 }, (_, index) => `toolset-${index}`),
      }).success,
    ).toBe(false);
  });

  it('is strict control data and cannot carry a remote MCP executable definition', () => {
    const result = MESSAGE_PAYLOAD_SCHEMAS['task.offer_with_toolsets'].safeParse({
      instruction: 'x',
      policy: { mode: 'auto' },
      requiredToolsets: ['salesko'],
      mcpServers: { salesko: { command: '/tmp/untrusted' } },
    });
    expect(result.success).toBe(false);
  });

  it('does not widen legacy task.offer with a silently stripped toolset field', () => {
    const parsed = TaskOfferPayloadSchema.parse({
      instruction: 'x',
      policy: { mode: 'auto' },
      requiredToolsets: ['salesko'],
    });
    expect('requiredToolsets' in parsed).toBe(false);
  });

  it('pins the bounded lowercase id vocabulary', () => {
    expect(ToolsetIdSchema.safeParse('salesko.linkedin-read').success).toBe(true);
    expect(ToolsetIdSchema.safeParse('../salesko').success).toBe(false);
    expect(ToolsetIdSchema.safeParse('salesko\nother').success).toBe(false);
  });
});
