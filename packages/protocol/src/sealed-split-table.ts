/**
 * The split table of sealed payload v1 and v2 (#654 design §8.1, §9.3;
 * #1045): for each sealable message type, the field that marks its sealed
 * branch, its data category, its identity fields, the fields that move into
 * the ciphertext, the fields its sealed branch drops, and the rule of each
 * digest field (D16).
 *
 * Plain data with no runtime imports, so `wire-additions.ts` can derive the
 * sealed gates from it and stay free of zod.
 */
import type { MessageType } from './messages';
import type { SealedPayloadCategory } from './sealed-payload';

/**
 * How the sealed branch of a type treats one digest field of its plaintext
 * branch (D16, design §9.3).
 *
 * - `ciphertext-sha256`: the SHA-256 of the sealed bytes, for a Host that
 *   checks the bytes it stores (a ciphertext blob).
 * - `keyed-mac`: a keyed MAC under the scope's MAC key; the Host forwards it.
 * - `sealed`: the field moves into the ciphertext with its parent.
 * - `plain`: a digest that no sealed content derives, kept in plaintext.
 * - `forbidden`: the sealed branch does not carry it in v1.
 */
export type SealedDigestRule = 'ciphertext-sha256' | 'keyed-mac' | 'sealed' | 'plain' | 'forbidden';

/** One sealable message type in the split table. */
export interface SealedSplitEntry {
  /**
   * The payload field whose presence marks the sealed branch: `sealing` (the
   * task's sealing policy) on `task.offer`, whose task may seal only its
   * output and so carry no `sealed` member; `sealed` everywhere else. The AAD
   * and the content MAC bind the wire type as the family.
   */
  readonly marker: 'sealing' | 'sealed';
  readonly category: SealedPayloadCategory;
  /**
   * Payload fields that, after the envelope `task_id`, name this write in the
   * AAD and the content MAC (§8.2, §9.1). The sealed branch requires them.
   */
  readonly identity: readonly string[];
  /**
   * Top-level fields of the plaintext branch that move into the ciphertext.
   * The sealed branch does not have them; the receiver merges the opened
   * object back and validates the plaintext branch.
   */
  readonly moved: readonly string[];
  /**
   * Top-level fields that also move into this ciphertext when the task's
   * frozen `sealing` names the category (#1045): on a task that seals
   * `memory-projection`, a terminal seals its `agentHomeMemoryChange`. The
   * sealed branch schema cannot see the task's sealing, so the Host and the
   * device check these fields; read them with {@link sealedMovedFields}.
   */
  readonly movedWith?: { readonly [category in SealedPayloadCategory]?: readonly string[] };
  /** Top-level fields of the plaintext branch that the sealed branch drops. */
  readonly forbidden: readonly string[];
  /**
   * Every path of the plaintext branch whose name contains `digest`, `hash` or
   * `revision` (case-insensitive), with its rule. A schema test keeps this
   * complete.
   */
  readonly digests: { readonly [path: string]: SealedDigestRule };
  /**
   * UTF-8 byte limits of moved fields that replace the plaintext branch's limit
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

/** A terminal of a task that seals `memory-projection` seals its memory-change evidence. */
const MEMORY_EVIDENCE = { 'memory-projection': ['agentHomeMemoryChange'] } as const;

/** The Host wrote the projection it names, so its hash tells the Host nothing new. */
const TERMINAL_DIGESTS = {
  'agentRef.profileRevision': 'plain',
  'agentHomeProjection.profileRevision': 'plain',
  'agentHomeProjection.projectionHash': 'plain',
} as const satisfies SealedSplitEntry['digests'];

/**
 * The split table (design §8.3): each sealable message type, the marker of its
 * sealed branch, its category, identity, moved and forbidden fields, and the
 * rule of each digest field. It is the one authority; the schemas, the gates,
 * the Host's comparison projection and the receiver's merge read it.
 *
 * A sealed offer carries the task's `sealing`. When the categories include
 * `task-input`, `instruction` is sealed; otherwise it stays plaintext and only
 * the task output is sealed. A prepared Execution is never sealed.
 *
 * Blob bytes have no sealing rule yet, so a sealed branch carries no plaintext
 * blob reference: `artifactRefs` and the artifact `blobRef` are dropped until
 * that rule exists. A sealed artifact is inline content, so its `inline`
 * takes up to 2 MiB instead of the plaintext 64 KB (decision 12b).
 */
export const SEALED_SPLIT_TABLE = Object.freeze({
  'task.offer': {
    marker: 'sealing',
    category: 'task-input',
    identity: [],
    moved: ['instruction'],
    forbidden: ['preparation'],
    digests: {
      'instruction.blobRef.contentHash': 'sealed',
      'agentRef.profileRevision': 'plain',
      'dispatchSelection.providerProfile.profileRevision': 'plain',
      'dispatchSelection.providerProfile.profileHash': 'plain',
      'egressPolicy.policyRevision': 'plain',
      'preparation.requestDigest': 'forbidden',
      'preparation.artifactDigest': 'forbidden',
    },
  },
  'task.steer': { marker: 'sealed', category: 'task-input', identity: ['steerId'], moved: ['text'], forbidden: [], digests: {} },
  'task.complete': {
    marker: 'sealed',
    category: 'task-output',
    identity: [],
    moved: ['summary', 'finalMessage', 'document'],
    movedWith: MEMORY_EVIDENCE,
    forbidden: ['artifactRefs', 'preparedObservation'],
    digests: {
      ...TERMINAL_DIGESTS,
      'artifactRefs[].contentHash': 'forbidden',
      'preparedObservation.requestDigest': 'forbidden',
    },
  },
  'task.fail': {
    marker: 'sealed',
    category: 'task-output',
    identity: [],
    moved: ['reason'],
    movedWith: MEMORY_EVIDENCE,
    forbidden: ['preparedObservation'],
    digests: { ...TERMINAL_DIGESTS, 'preparedObservation.requestDigest': 'forbidden' },
  },
  'task.decline': {
    marker: 'sealed', category: 'task-output', identity: [], moved: ['reason'], forbidden: [], digests: { 'agentRef.profileRevision': 'plain' },
  },
  'task.cancelled': {
    marker: 'sealed', category: 'task-output', identity: [], moved: ['reason'], movedWith: MEMORY_EVIDENCE, forbidden: [], digests: TERMINAL_DIGESTS,
  },
  'task.progress': {
    marker: 'sealed', category: 'task-output', identity: ['seq'], moved: ['events'], forbidden: [], digests: { 'events[].spill.blob.contentHash': 'sealed' },
    inlineOnly: true,
  },
  'task.artifact': {
    marker: 'sealed', category: 'task-output', identity: ['artifactId'], moved: ['inline'], forbidden: ['blobRef'], digests: { 'blobRef.contentHash': 'forbidden' },
    limits: { inline: 2 * 1024 * 1024 },
  },
  'task.await_approval': {
    marker: 'sealed', category: 'task-output', identity: ['approvalId'], moved: ['summary'], forbidden: [], digests: {},
    inlineOnly: true,
  },
  // #1045 C2. The plaintext SHA-256 of the body would let the Host confirm a
  // guessed message, and the exact byte count would undo the padding, so the
  // sealed branch drops both; the sealed member's keyed `contentMac` names
  // the content instead. `cursor` is in the identity, so the Host cannot
  // reorder sealed messages of one session.
  'agent.message.publish': {
    marker: 'sealed',
    category: 'agent-message',
    identity: ['messageId', 'cursor'],
    moved: ['body'],
    forbidden: ['contentHash', 'byteCount'],
    digests: { 'agentRef.profileRevision': 'plain', contentHash: 'forbidden' },
  },
} as const satisfies { readonly [type in MessageType]?: SealedSplitEntry });

/**
 * The receiver capability each category's sealed branches need: the v1
 * categories `sealed-payload-v1`, the #1045 categories `sealed-payload-v2`.
 */
export const SEALED_CATEGORY_CAPABILITY = Object.freeze({
  'task-input': 'sealed-payload-v1',
  'agent-message': 'sealed-payload-v2',
  'task-output': 'sealed-payload-v1',
  'memory-projection': 'sealed-payload-v2',
} as const satisfies { readonly [category in SealedPayloadCategory]: string });

/**
 * The top-level fields a `type` message of a task whose frozen `sealing`
 * lists `categories` moves into its ciphertext: the type's `moved` fields and
 * the `movedWith` fields of each listed category.
 */
export function sealedMovedFields(type: SealableMessageType, categories: readonly SealedPayloadCategory[]): readonly string[] {
  const entry: SealedSplitEntry = SEALED_SPLIT_TABLE[type];
  return [...entry.moved, ...categories.flatMap((category) => entry.movedWith?.[category] ?? [])];
}

/** A message type with a sealed branch. */
export type SealableMessageType = keyof typeof SEALED_SPLIT_TABLE;

export function isSealableMessageType(type: string): type is SealableMessageType {
  return Object.hasOwn(SEALED_SPLIT_TABLE, type);
}

/** Whether a `type` payload takes its sealed branch: it carries the type's marker field. */
export function isSealedPayload(type: string, payload: unknown): boolean {
  return isSealableMessageType(type) && payload !== null && typeof payload === 'object'
    && (payload as Readonly<Record<string, unknown>>)[SEALED_SPLIT_TABLE[type].marker] !== undefined;
}
