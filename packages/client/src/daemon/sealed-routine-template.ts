/**
 * The routine template of a sealed execution on the device (#654 E3d,
 * design §6.3). The offer's `sealed` member is a template that a member
 * sealed once for every occurrence of one routine, so its binding names the
 * routine instead of a task and no device. The device rebuilds that binding
 * from the offer's plaintext `routineRef`, `agentRef` and `sealing`, so
 * another routine, Agent or category list fails the AEAD.
 *
 * The Host does not check `notAfter`; the device does, against its own clock.
 * The template is valid up to and including `notAfter`.
 */
import type { SealedBinding } from '@byok-sdk/core/sealed-payload';
import type { AgentRef, TaskOfferSealedPayload, TaskSealing } from '@byok-sdk/protocol';

export type RoutineRef = NonNullable<TaskOfferSealedPayload['routineRef']>;

export function routineTemplateExpired(routineRef: RoutineRef, now: number): boolean {
  return now > Date.parse(routineRef.notAfter);
}

export function routineTemplateBinding(tenantId: string, routineRef: RoutineRef, agentRef: AgentRef | null, sealing: TaskSealing): SealedBinding {
  return {
    tenantId,
    family: 'routine.template',
    direction: 'server-to-daemon',
    identity: { routineId: routineRef.routineId, definitionVersion: routineRef.definitionVersion },
    deviceId: null,
    agentRef: agentRef === null ? null : { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
    categories: sealing.categories,
    notAfter: routineRef.notAfter,
  };
}
