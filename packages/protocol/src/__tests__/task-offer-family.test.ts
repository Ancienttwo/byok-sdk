import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, MESSAGE_TYPES, TASK_OFFER_TYPES, isTaskOfferType } from '../index';

describe('protocol task-opening offer family', () => {
  it('classifies every declared offer and no other message, including future registry additions', () => {
    const declared = MESSAGE_TYPES.filter((type) => type === 'task.offer' || type.startsWith('task.offer_'));
    expect(TASK_OFFER_TYPES).toEqual(declared);
    expect(TASK_OFFER_TYPES).toContain('task.offer_for_agent_with_egress');
    expect(TASK_OFFER_TYPES).toContain('task.offer_for_agent_with_egress_fresh');
    for (const type of MESSAGE_TYPES) expect(isTaskOfferType(type)).toBe(declared.includes(type));
    const envelopeTypes = EnvelopeSchema.options.map((schema) => schema.shape.type.value);
    expect(TASK_OFFER_TYPES.every((type) => envelopeTypes.includes(type))).toBe(true);
  });

  it('rejects unknown lookalikes and inherited object keys; the exported list is immutable', () => {
    for (const type of ['task.offer_unknown', 'task.offer_for_agent_with_egress_fresher', 'toString', '__proto__', 'constructor', '']) {
      expect(isTaskOfferType(type)).toBe(false);
    }
    expect(Object.isFrozen(TASK_OFFER_TYPES)).toBe(true);
    expect(isTaskOfferType('task.offer')).toBe(true);
  });
});
