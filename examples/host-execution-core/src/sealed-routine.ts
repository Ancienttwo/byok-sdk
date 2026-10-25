/**
 * The member side of a sealed routine (#654 E3d-4, design §6.3). A member seals one routine template for one routine
 * version; the Host stores it and puts it, byte for byte, in the `sealed` member of each occurrence's offer, next to the
 * plaintext `routineRef`. The Host never sees the scope key or the instruction.
 *
 * This entry imports `@byok-sdk/core/sealed-payload`, so it is a subpath: a Host that imports the K4 root does not load it.
 */
import { sealContent, type SealedBinding, type SealedCategory } from '@byok-sdk/core/sealed-payload';
import { SEALED_INLINE_MAX_PADDED_LENGTH, type AgentRef, type TaskSealing } from '@byok-sdk/protocol';
import type { SealedExecutionTemplate } from './model';

export type RoutineRef = NonNullable<SealedExecutionTemplate['payload']['routineRef']>;
/** The inline `sealed` member of a sealed offer. */
export type SealedTaskInput = NonNullable<SealedExecutionTemplate['payload']['sealed']>;
/** The plaintext limit of a sealed task input: 2 MiB of canonical JSON. */
const TASK_INPUT_MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

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

export interface SealRoutineTemplateInput {
  /** The Host tenant the device's offer comes from. */
  readonly tenantId: string;
  readonly scopeKey: Uint8Array;
  /** The task sealing the offer will carry. Its epoch is the template's epoch. */
  readonly sealing: TaskSealing;
  /** The member chain head the member verified before sealing, and the member's id. */
  readonly chainHead: { readonly seq: number; readonly hash: string };
  readonly sender: string;
  readonly routineRef: RoutineRef;
  readonly agentRef: AgentRef;
  readonly instruction: string;
}

/**
 * Seals one routine template, inline. A template above the inline limit throws: between occurrences no task holds a
 * ciphertext blob, so orphan GC could delete it. Seal once and keep the result: a retry must resend these bytes.
 */
export async function sealRoutineTemplate(input: SealRoutineTemplateInput): Promise<SealedTaskInput> {
  if (!input.sealing.categories.includes('task-input')) throw new Error('A routine template is sealed task input');
  const { header, ciphertext } = await sealContent({
    scopeKey: input.scopeKey,
    scope: { id: input.sealing.scopeId, epoch: input.sealing.epoch },
    chainHead: input.chainHead,
    sender: input.sender,
    category: 'task-input',
    binding: routineTemplateBinding(input.tenantId, input.routineRef, input.agentRef, input.sealing.categories),
    plaintext: { instruction: input.instruction },
    maxContentLength: TASK_INPUT_MAX_CONTENT_LENGTH,
  });
  if (header.paddedLength > SEALED_INLINE_MAX_PADDED_LENGTH) throw new Error('A routine template must fit inline');
  return { ...header, category: 'task-input', ciphertext: Buffer.from(ciphertext).toString('base64url') } as SealedTaskInput;
}
