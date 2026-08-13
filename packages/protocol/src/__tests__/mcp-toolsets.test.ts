import { describe, expect, it } from 'vitest';
import {
  CONFIGURED_TOOLSETS_MAX_ITEMS,
  ConfiguredToolsetsSchema,
  ConnHelloPayloadSchema,
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

  it('bounds and validates the device configured-toolset inventory independently of a task request', () => {
    expect(ConfiguredToolsetsSchema.parse([])).toEqual([]);
    expect(ConfiguredToolsetsSchema.parse(['crm.readonly', 'salesko.connectors'])).toEqual([
      'crm.readonly',
      'salesko.connectors',
    ]);
    expect(ConfiguredToolsetsSchema.safeParse(['salesko', 'salesko']).success).toBe(false);
    expect(ConfiguredToolsetsSchema.safeParse(['Salesko']).success).toBe(false);
    expect(
      ConfiguredToolsetsSchema.safeParse(
        Array.from({ length: CONFIGURED_TOOLSETS_MAX_ITEMS + 1 }, (_, index) => `toolset-${index}`),
      ).success,
    ).toBe(false);
  });

  it('adds an optional logical-only inventory to conn.hello', () => {
    const parsed = ConnHelloPayloadSchema.parse({
      protocolVersions: [1],
      capabilities: ['toolset-selection'],
      deviceId: 'device-1',
      productId: 'salesko',
      configuredToolsets: ['salesko.connectors'],
    });
    expect(parsed.configuredToolsets).toEqual(['salesko.connectors']);
    expect(JSON.stringify(parsed)).not.toMatch(/command|args|env|header|secret/i);
  });
});
