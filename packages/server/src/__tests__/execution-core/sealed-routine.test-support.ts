/**
 * The member side of a sealed routine (#654 E3d-4, design §6.3), for tests. A member seals one routine template for one
 * routine version; the Host stores it and puts it, byte for byte, in the `sealed` member of each occurrence's offer,
 * next to the plaintext `routineRef`. The Host never sees the scope key or the instruction. No product code seals a
 * routine template, so this lives with the tests; the binding stays the product's `routineTemplateBinding`.
 */
import { sealContent } from '@byok-sdk/core/sealed-payload';
import { SEALED_INLINE_MAX_PADDED_LENGTH, type AgentRef, type TaskSealing } from '@byok-sdk/protocol';
import { routineTemplateBinding, type RoutineRef, type SealedTaskInput } from '../../execution-core/sealed-routine';

/** The plaintext limit of a sealed task input: 2 MiB of canonical JSON. */
const TASK_INPUT_MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

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
  // K4 runs a sealed execution only with exactly `['task-input']`, and the category list is bound into the template.
  const { categories } = input.sealing;
  if (categories.length !== 1 || categories[0] !== 'task-input') throw new Error('A routine template is sealed task input only');
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
