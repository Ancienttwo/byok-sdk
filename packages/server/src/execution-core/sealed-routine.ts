/**
 * The Host side of a sealed routine (#654 E3d-4, design §6.3). A member seals one routine template for one routine
 * version under this binding; the Host stores it and puts it, byte for byte, in the `sealed` member of each occurrence's
 * offer, next to the plaintext `routineRef`. The Host never sees the scope key or the instruction.
 */
import type { SealedBinding, SealedCategory } from '@byok-sdk/core/sealed-payload';
import type { AgentRef } from '@byok-sdk/protocol';
import type { SealedExecutionTemplate } from './model.js';

export type RoutineRef = NonNullable<SealedExecutionTemplate['payload']['routineRef']>;
/** The inline `sealed` member of a sealed offer. */
export type SealedTaskInput = NonNullable<SealedExecutionTemplate['payload']['sealed']>;

/**
 * The binding of a routine template: the routine version in place of a task, no device, and the expiry. The device
 * rebuilds the same binding from the offer's `routineRef`, `agentRef` and `sealing.categories`, so another routine,
 * version, Agent, expiry or category list fails the AEAD. Core exports no binding helper (owner decision 46c); the
 * golden routine lines pin this one.
 */
export function routineTemplateBinding(tenantId: string, routineRef: RoutineRef, agentRef: AgentRef, categories: readonly SealedCategory[]): SealedBinding {
  return {
    tenantId,
    family: 'routine.template',
    direction: 'server-to-daemon',
    identity: { routineId: routineRef.routineId, definitionVersion: routineRef.definitionVersion },
    deviceId: null,
    agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
    categories: [...categories],
    notAfter: routineRef.notAfter,
  };
}
