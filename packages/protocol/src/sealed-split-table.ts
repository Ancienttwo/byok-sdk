/**
 * The split table of sealed payload v1 (#654 design §8.1, §9.3): for each
 * sealed message type, its plaintext type, its data category, its identity
 * fields, the fields that move into the ciphertext, the fields it drops, and
 * the rule of each digest field (D16).
 *
 * Plain data with no runtime imports, so `wire-additions.ts` can derive the
 * sealed gates from it and stay free of zod.
 */
import type { MessageType } from './messages';
import type { SealedPayloadV1Category } from './sealed-payload';

/**
 * How a sealed message type treats one digest field of its plaintext type
 * (D16, design §9.3).
 *
 * - `ciphertext-sha256`: the SHA-256 of the sealed bytes, for a Host that
 *   checks the bytes it stores (a ciphertext blob).
 * - `keyed-mac`: a keyed MAC under the scope's MAC key; the Host forwards it.
 * - `sealed`: the field moves into the ciphertext with its parent.
 * - `plain`: a digest that no sealed content derives, kept in plaintext.
 * - `forbidden`: the sealed type does not carry it in v1.
 */
export type SealedDigestRule = 'ciphertext-sha256' | 'keyed-mac' | 'sealed' | 'plain' | 'forbidden';

/** One sealed message type in the split table. */
export interface SealedSplitEntry {
  /**
   * The plaintext message type this type seals. The AAD and the content MAC
   * bind it as the family, not the sealed wire type.
   */
  readonly plainType: MessageType;
  readonly category: SealedPayloadV1Category;
  /**
   * Payload fields that, after the envelope `task_id`, name this write in the
   * AAD and the content MAC (§8.2, §9.1). The sealed type requires them.
   */
  readonly identity: readonly string[];
  /**
   * Top-level fields of the plaintext type that move into the ciphertext.
   * The sealed type does not have them; the receiver merges the opened
   * object back and validates the plaintext type.
   */
  readonly moved: readonly string[];
  /** Top-level fields of the plaintext type that the sealed type drops in v1. */
  readonly forbidden: readonly string[];
  /**
   * Every path of the plaintext type whose name contains `digest`, `hash` or
   * `revision` (case-insensitive), with its rule. A schema test keeps this
   * complete.
   */
  readonly digests: { readonly [path: string]: SealedDigestRule };
  /**
   * UTF-8 byte limits of moved fields that replace the plaintext type's limit
   * of that field after the merge (decision 12b). The category limit still
   * bounds the whole opened content.
   */
  readonly limits?: { readonly [field: string]: number };
  /**
   * The sealed form carries inline ciphertext only, never `ciphertextRef`
   * (decision 12e). The Host keeps it in a tail row that expires, so it holds
   * no blob for it. The schema does not check this; the Host and the device do.
   */
  readonly inlineOnly?: true;
}

const OFFER_DIGESTS = {
  'instruction.blobRef.contentHash': 'sealed',
  'dispatchSelection.providerProfile.profileRevision': 'plain',
  'dispatchSelection.providerProfile.profileHash': 'plain',
} as const satisfies SealedSplitEntry['digests'];
const AGENT_OFFER_DIGESTS = { ...OFFER_DIGESTS, 'agentRef.profileRevision': 'plain' } as const satisfies SealedSplitEntry['digests'];
const EGRESS_OFFER_DIGESTS = { ...AGENT_OFFER_DIGESTS, 'egressPolicy.policyRevision': 'plain' } as const satisfies SealedSplitEntry['digests'];
/** The Host wrote the projection it names, so its hash tells the Host nothing new. */
const TERMINAL_DIGESTS = {
  'agentRef.profileRevision': 'plain',
  'agentHomeProjection.profileRevision': 'plain',
  'agentHomeProjection.projectionHash': 'plain',
} as const satisfies SealedSplitEntry['digests'];

const sealedOffer = (plainType: MessageType, digests: SealedSplitEntry['digests']): SealedSplitEntry =>
  ({ plainType, category: 'task-input', identity: [], moved: ['instruction'], forbidden: [], digests });

/**
 * The split table (design §8.3): each sealed message type, the plaintext type
 * it seals, its category, identity, moved and forbidden fields, and the rule
 * of each digest field. It is the one authority; the schemas, the Host's
 * comparison projection and the receiver's merge read it.
 *
 * A sealed offer also carries the task's `sealing`. When the categories
 * include `task-input`, `instruction` is sealed; otherwise it stays plaintext
 * and only the task output is sealed.
 *
 * Blob bytes have no sealing rule yet, so a sealed type carries no plaintext
 * blob reference: `artifactRefs` and the artifact `blobRef` are dropped until
 * that rule exists. A sealed artifact is inline content, so its `inline`
 * takes up to 2 MiB instead of the plaintext 64 KB (decision 12b).
 */
export const SEALED_SPLIT_TABLE = Object.freeze({
  'task.offer_for_agent_sealed': sealedOffer('task.offer_for_agent', AGENT_OFFER_DIGESTS),
  'task.offer_for_agent_with_egress_sealed': sealedOffer('task.offer_for_agent_with_egress', EGRESS_OFFER_DIGESTS),
  'task.offer_for_agent_with_egress_fresh_sealed': sealedOffer('task.offer_for_agent_with_egress_fresh', EGRESS_OFFER_DIGESTS),
  'task.steer_sealed': { plainType: 'task.steer', category: 'task-input', identity: ['steerId'], moved: ['text'], forbidden: [], digests: {} },
  'task.complete_sealed': {
    plainType: 'task.complete',
    category: 'task-output',
    identity: [],
    moved: ['summary', 'finalMessage', 'document'],
    forbidden: ['artifactRefs', 'preparedObservation'],
    digests: {
      ...TERMINAL_DIGESTS,
      'artifactRefs[].contentHash': 'forbidden',
      'preparedObservation.requestDigest': 'forbidden',
    },
  },
  'task.fail_sealed': {
    plainType: 'task.fail',
    category: 'task-output',
    identity: [],
    moved: ['reason'],
    forbidden: ['preparedObservation'],
    digests: { ...TERMINAL_DIGESTS, 'preparedObservation.requestDigest': 'forbidden' },
  },
  'task.decline_sealed': {
    plainType: 'task.decline', category: 'task-output', identity: [], moved: ['reason'], forbidden: [], digests: { 'agentRef.profileRevision': 'plain' },
  },
  'task.cancelled_sealed': {
    plainType: 'task.cancelled', category: 'task-output', identity: [], moved: ['reason'], forbidden: [], digests: TERMINAL_DIGESTS,
  },
  'task.progress_sealed': {
    plainType: 'task.progress', category: 'task-output', identity: ['seq'], moved: ['events'], forbidden: [], digests: { 'events[].spill.blob.contentHash': 'sealed' },
    inlineOnly: true,
  },
  'task.artifact_sealed': {
    plainType: 'task.artifact', category: 'task-output', identity: ['artifactId'], moved: ['inline'], forbidden: ['blobRef'], digests: { 'blobRef.contentHash': 'forbidden' },
    limits: { inline: 2 * 1024 * 1024 },
  },
  'task.await_approval_sealed': {
    plainType: 'task.await_approval', category: 'task-output', identity: ['approvalId'], moved: ['summary'], forbidden: [], digests: {},
    inlineOnly: true,
  },
} as const satisfies { readonly [type: string]: SealedSplitEntry });

export type SealedMessageType = keyof typeof SEALED_SPLIT_TABLE;

export function isSealedMessageType(type: string): type is SealedMessageType {
  return Object.hasOwn(SEALED_SPLIT_TABLE, type);
}
