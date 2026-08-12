import { describe, expect, it } from 'vitest';

import {
  DispatchSelectionSchema,
  TaskOfferPayloadSchema,
} from '../index';

describe('DispatchSelectionSchema', () => {
  it('accepts the two lane-owned target shapes', () => {
    expect(
      DispatchSelectionSchema.parse({
        lane: 'subscription',
        runtimeId: 'claude',
        providerId: null,
        modelId: 'opus',
      }),
    ).toEqual({
      lane: 'subscription',
      runtimeId: 'claude',
      providerId: null,
      modelId: 'opus',
    });
    expect(
      DispatchSelectionSchema.parse({
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      }),
    ).toMatchObject({ lane: 'byok', runtimeId: 'pi' });
  });

  it.each([
    {
      lane: 'subscription',
      runtimeId: 'pi',
      providerId: null,
      modelId: 'gpt-5.2',
    },
    {
      lane: 'byok',
      runtimeId: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.2',
    },
    {
      lane: 'subscription',
      runtimeId: 'claude',
      providerId: 'anthropic',
      modelId: 'opus',
    },
  ])('rejects cross-lane target ownership %#', (selection) => {
    expect(DispatchSelectionSchema.safeParse(selection).success).toBe(false);
  });

  it('is carried by task.offer without widening its strict nested shape', () => {
    const result = TaskOfferPayloadSchema.safeParse({
      instruction: 'hello',
      policy: { mode: 'auto' },
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
        unexpected: true,
      },
    });
    expect(result.success).toBe(false);
  });
});
