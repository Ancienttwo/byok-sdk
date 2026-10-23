/**
 * Sealed payload v1 on the hosted wire (#654 design §8.1, §8.3, §8.6).
 *
 * A sealed member replaces the fields that one data category moves out of a
 * payload. The Host reads only its outer fields. It checks the shape here:
 * version, suite, encodings, a legal padded length, and exactly one of inline
 * `ciphertext` and `ciphertextRef`. Inline is the only legal form up to
 * {@link SEALED_INLINE_MAX_PADDED_LENGTH}; above it, the ciphertext is a blob.
 * So one content has one legal wire form, and two submissions compare by
 * their outer fields only.
 *
 * `@byok-sdk/core/sealed-payload` seals and opens the bytes. Protocol does
 * not depend on core, so this module repeats the header rules and the padded
 * length function; a cross-package test keeps the two equal.
 */
import { z } from 'zod';

import { BlobRefSchema, CONTENT_HASH_RE } from './blob';
import type { MessageType } from './messages';

export const SEALED_PAYLOAD_VERSION = 1;
/** The only suite v1 admits. A new suite is a new constant and a new capability, never a parser branch. */
export const SEALED_PAYLOAD_SUITE = 'byok-sealed-v1.hkdf-sha256.aes-256-gcm';

/** C1–C4 in canonical order. A task lists its sealing categories in this order. */
export const SEALED_PAYLOAD_CATEGORIES = ['task-input', 'agent-message', 'task-output', 'memory-projection'] as const;
export type SealedPayloadCategory = (typeof SEALED_PAYLOAD_CATEGORIES)[number];

/**
 * The categories a v1 task may seal (D17): task input and task output. Agent
 * messages, memory projections, input preparation and drafts come later.
 */
export const SEALED_PAYLOAD_V1_CATEGORIES = ['task-input', 'task-output'] as const;
export type SealedPayloadV1Category = (typeof SEALED_PAYLOAD_V1_CATEGORIES)[number];

/**
 * Closed `task.decline` codes of a receiver that refuses sealed task input
 * (§8.3). They are plaintext: a device without the scope key cannot seal a
 * reason. A device sends them only to a server that advertised
 * `sealed-payload-v1`.
 */
export const SEALED_DECLINE_CODES = [
  'sealed_key_unavailable',
  'sealed_open_failed',
  'sealed_content_mac_mismatch',
  'sealing_policy_mismatch',
] as const;
export type SealedDeclineCode = (typeof SEALED_DECLINE_CODES)[number];

/** Padded frames above this length travel as a ciphertext blob (§8.6). */
export const SEALED_INLINE_MAX_PADDED_LENGTH = 256 * 1024;

/** Plaintext limit of every v1 category, in UTF-8 bytes of canonical JSON (D8). */
export const SEALED_PAYLOAD_MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

const AEAD_TAG_BYTES = 16;
const FRAME_HEADER_BYTES = 4;
const ALIGNED_FRAME_LIMIT = 16 * 1024;
const FRAME_ALIGNMENT = 256;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;

function floorLog2(value: number): number {
  let exponent = 0;
  for (let remaining = value; remaining >= 2; remaining = Math.floor(remaining / 2)) exponent += 1;
  return exponent;
}

/**
 * The one legal padded length of a frame of `frameLength` bytes
 * (`4 + contentLength`): the next multiple of 256 up to 16 KiB, Padmé above.
 */
export function sealedPayloadPaddedLength(frameLength: number): number {
  if (!Number.isSafeInteger(frameLength) || frameLength < FRAME_HEADER_BYTES) {
    throw new RangeError('Sealed frame length must be a safe integer of at least 4');
  }
  if (frameLength <= ALIGNED_FRAME_LIMIT) return Math.ceil(frameLength / FRAME_ALIGNMENT) * FRAME_ALIGNMENT;
  const exponent = floorLog2(frameLength);
  const step = 2 ** (exponent - (floorLog2(exponent) + 1));
  return Math.ceil(frameLength / step) * step;
}

/** The largest padded length a v1 content may have. */
export const SEALED_PAYLOAD_MAX_PADDED_LENGTH = sealedPayloadPaddedLength(
  FRAME_HEADER_BYTES + SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
);

function isLegalPaddedLength(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= FRAME_ALIGNMENT
    && value <= SEALED_PAYLOAD_MAX_PADDED_LENGTH
    && sealedPayloadPaddedLength(value) === value;
}

const BASE64URL_VALUE = /^[A-Za-z0-9_-]*$/u;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The byte length of canonical unpadded base64url, or `undefined`. Canonical
 * means no padding, no impossible length, and zero unused bits in the last
 * character, so one byte string has exactly one encoding.
 */
export function sealedBase64UrlByteLength(value: string): number | undefined {
  if (!BASE64URL_VALUE.test(value)) return undefined;
  const tail = value.length % 4;
  if (tail === 1) return undefined;
  if (tail !== 0) {
    const last = BASE64URL_ALPHABET.indexOf(value[value.length - 1]!);
    const unusedBits = tail === 2 ? 0b1111 : 0b11;
    if ((last & unusedBits) !== 0) return undefined;
  }
  return Math.floor(value.length / 4) * 3 + (tail === 0 ? 0 : tail - 1);
}

function base64UrlOf(bytes: number) {
  return z.string().refine((value) => sealedBase64UrlByteLength(value) === bytes, `must be canonical unpadded base64url of ${bytes} bytes`);
}

const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * One sealed content (§8.1) of one category. The outer fields are what the
 * Host reads; the ciphertext is the padded frame plus the 16-byte AES-GCM tag.
 * A message type fixes its category, so its schema names it as a literal.
 */
function sealedPayloadSchema<Category extends z.ZodType<SealedPayloadV1Category>>(category: Category) {
  return z
    .object({
      v: z.literal(SEALED_PAYLOAD_VERSION),
      suite: z.literal(SEALED_PAYLOAD_SUITE),
      category,
      scope: z
        .object({
          id: z.string().min(1).max(256),
          epoch: PositiveIntegerSchema,
          keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
        })
        .strict(),
      chainHead: z
        .object({
          seq: PositiveIntegerSchema,
          hash: z.string().regex(CONTENT_HASH_RE),
        })
        .strict(),
      sender: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      salt: base64UrlOf(SALT_BYTES),
      nonce: base64UrlOf(NONCE_BYTES),
      paddedLength: PositiveIntegerSchema.refine(isLegalPaddedLength, 'must be a legal padded frame length within the v1 limit'),
      contentMac: z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/u),
      ciphertext: z.string().optional(),
      /** The ciphertext blob. A presigned `url` is transport detail and never part of a sealed member. */
      ciphertextRef: BlobRefSchema.omit({ url: true }).strict().optional(),
    })
    .strict()
    .superRefine((sealed, ctx) => {
      const ciphertextLength = sealed.paddedLength + AEAD_TAG_BYTES;
      const inline = sealed.paddedLength <= SEALED_INLINE_MAX_PADDED_LENGTH;
      if (inline) {
        if (sealed.ciphertextRef !== undefined || sealed.ciphertext === undefined) {
          ctx.addIssue({ code: 'custom', path: ['ciphertext'], message: `a padded length up to ${SEALED_INLINE_MAX_PADDED_LENGTH} carries inline ciphertext only` });
        } else if (sealedBase64UrlByteLength(sealed.ciphertext) !== ciphertextLength) {
          ctx.addIssue({ code: 'custom', path: ['ciphertext'], message: 'ciphertext must be canonical base64url of paddedLength + 16 bytes' });
        }
        return;
      }
      if (sealed.ciphertext !== undefined || sealed.ciphertextRef === undefined) {
        ctx.addIssue({ code: 'custom', path: ['ciphertextRef'], message: `a padded length above ${SEALED_INLINE_MAX_PADDED_LENGTH} carries ciphertextRef only` });
      } else if (sealed.ciphertextRef.size !== ciphertextLength) {
        ctx.addIssue({ code: 'custom', path: ['ciphertextRef', 'size'], message: 'ciphertextRef size must equal paddedLength + 16' });
      }
    });
}

/** A sealed member of any v1 category. */
export const SealedPayloadSchema = sealedPayloadSchema(z.enum(SEALED_PAYLOAD_V1_CATEGORIES));
export type SealedPayload = z.infer<typeof SealedPayloadSchema>;
/** The sealed member of a task-input message (offers, steer). */
export const SealedTaskInputSchema = sealedPayloadSchema(z.literal('task-input'));
/** The sealed member of a task-output message. */
export const SealedTaskOutputSchema = sealedPayloadSchema(z.literal('task-output'));

function isCanonicalCategoryList(categories: readonly string[]): boolean {
  return categories.every((category, index) => index === 0
    || SEALED_PAYLOAD_CATEGORIES.indexOf(categories[index - 1] as SealedPayloadCategory)
      < SEALED_PAYLOAD_CATEGORIES.indexOf(category as SealedPayloadCategory));
}

/**
 * A task's frozen sealing policy (§6.2). The offer carries it in plaintext.
 * `epoch` is the epoch of the offer's task-input content, and the lowest epoch
 * the task accepts.
 */
export const TaskSealingSchema = z
  .object({
    scopeId: z.string().min(1).max(256),
    epoch: PositiveIntegerSchema,
    categories: z
      .array(z.enum(SEALED_PAYLOAD_V1_CATEGORIES))
      .min(1)
      .refine(isCanonicalCategoryList, 'categories must be unique and in canonical order'),
  })
  .strict();
export type TaskSealing = z.infer<typeof TaskSealingSchema>;

/** What a moved field holds on the wire: its placeholder, or `absent` for an optional field. */
export type SealedPlaceholder = '' | 'empty-array' | 'absent';

/**
 * How a sealed message type treats one digest field (D16, design §9.3).
 *
 * - `ciphertext-sha256`: the SHA-256 of the sealed bytes, for a Host that
 *   checks the bytes it stores (a ciphertext blob).
 * - `keyed-mac`: a keyed MAC under the scope's MAC key; the Host forwards it.
 * - `sealed`: the field moves into the ciphertext with its parent.
 * - `plain`: a digest that no sealed content derives, kept in plaintext.
 * - `forbidden`: a sealed message must not carry it in v1.
 */
export type SealedDigestRule = 'ciphertext-sha256' | 'keyed-mac' | 'sealed' | 'plain' | 'forbidden';

/** One message type in the split table. */
export interface SealedSplitEntry {
  readonly category: SealedPayloadV1Category;
  /**
   * Payload fields that, after the envelope `task_id`, name this write in the
   * AAD and the content MAC (§8.2, §9.1). A sealed message must carry them.
   */
  readonly identity: readonly string[];
  /**
   * Top-level payload fields the category moves into the ciphertext. A
   * required field stays on the wire with its placeholder (`''` or `[]`), so
   * a payload that drops `sealed` still has the released shape; an optional
   * field is absent. The receiver replaces each with its opened value.
   */
  readonly moved: { readonly [field: string]: SealedPlaceholder };
  /**
   * Every payload path whose name contains `digest`, `hash` or `revision`
   * (case-insensitive), with its rule. A schema test keeps this complete.
   */
  readonly digests: { readonly [path: string]: SealedDigestRule };
  /** Top-level fields a sealed message must not carry (the `forbidden` digests' parents). */
  readonly forbidden: readonly string[];
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

const taskInput = (digests: SealedSplitEntry['digests']): SealedSplitEntry =>
  ({ category: 'task-input', identity: [], moved: { instruction: '' }, digests, forbidden: [] });

/**
 * The split table (design §8.3): for each message type that v1 may seal, the
 * category, the moved fields, and the rule of each digest field. It is the
 * one authority; the schemas, the Host's comparison projection and the
 * receiver's merge read it. A type that is not here is never sealed.
 *
 * Blob bytes have no sealing rule yet, so a sealed message carries no
 * plaintext blob reference: `artifactRefs` and the artifact `blobRef` are
 * forbidden until that rule exists. A sealed artifact is inline content.
 */
export const SEALED_SPLIT_TABLE = Object.freeze({
  'task.offer': taskInput(OFFER_DIGESTS),
  'task.offer_with_toolsets': taskInput(OFFER_DIGESTS),
  'task.offer_for_agent': taskInput(AGENT_OFFER_DIGESTS),
  'task.offer_for_agent_with_egress': taskInput(EGRESS_OFFER_DIGESTS),
  'task.offer_for_agent_with_egress_fresh': taskInput(EGRESS_OFFER_DIGESTS),
  'task.steer': { category: 'task-input', identity: [], moved: { text: '' }, digests: {}, forbidden: [] },
  'task.complete': {
    category: 'task-output',
    identity: [],
    moved: { summary: '', finalMessage: 'absent', document: 'absent' },
    digests: {
      ...TERMINAL_DIGESTS,
      'artifactRefs[].contentHash': 'forbidden',
      'preparedObservation.requestDigest': 'forbidden',
    },
    forbidden: ['preparedObservation', 'artifactRefs'],
  },
  'task.fail': {
    category: 'task-output',
    identity: [],
    moved: { reason: '' },
    digests: { ...TERMINAL_DIGESTS, 'preparedObservation.requestDigest': 'forbidden' },
    forbidden: ['preparedObservation'],
  },
  'task.decline': { category: 'task-output', identity: [], moved: { reason: '' }, digests: { 'agentRef.profileRevision': 'plain' }, forbidden: [] },
  'task.cancelled': { category: 'task-output', identity: [], moved: { reason: 'absent' }, digests: TERMINAL_DIGESTS, forbidden: [] },
  'task.progress': { category: 'task-output', identity: ['seq'], moved: { events: 'empty-array' }, digests: { 'events[].spill.blob.contentHash': 'sealed' }, forbidden: [] },
  'task.artifact': { category: 'task-output', identity: ['name'], moved: { inline: 'absent' }, digests: { 'blobRef.contentHash': 'forbidden' }, forbidden: ['blobRef'] },
  'task.await_approval': { category: 'task-output', identity: ['approvalId'], moved: { summary: '' }, digests: {}, forbidden: [] },
} as const satisfies { readonly [type in MessageType]?: SealedSplitEntry });

export type SealedMessageType = keyof typeof SEALED_SPLIT_TABLE;

export function isSealedMessageType(type: string): type is SealedMessageType {
  return Object.hasOwn(SEALED_SPLIT_TABLE, type);
}

function holdsPlaceholder(value: unknown, placeholder: SealedPlaceholder): boolean {
  if (placeholder === 'absent') return value === undefined;
  if (placeholder === 'empty-array') return Array.isArray(value) && value.length === 0;
  return value === placeholder;
}

/**
 * The payload rule of one sealed message type, for `superRefine`. It reads
 * the split table:
 *
 * - With `sealed`: the identity fields are present, every moved field holds
 *   its placeholder, and no forbidden field is present.
 * - On an offer: `sealing` names the task's categories. `sealed` is present
 *   exactly when they include `task-input`, and its scope is the task's scope
 *   at the task's epoch. `sealed` never travels without `sealing`.
 *
 * Whether a task's later messages must be sealed is the Host's and the
 * device's check: they know the task's `sealing`, this payload does not.
 */
export function sealedPayloadRule(type: SealedMessageType) {
  const entry: SealedSplitEntry = SEALED_SPLIT_TABLE[type];
  return (payload: { readonly sealed?: SealedPayload; readonly sealing?: TaskSealing }, ctx: z.RefinementCtx): void => {
    const fields = payload as { readonly [field: string]: unknown };
    const { sealed, sealing } = payload;
    if (entry.category === 'task-input' && 'instruction' in entry.moved) {
      const sealsInput = sealing?.categories.includes('task-input') === true;
      if (sealsInput !== (sealed !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['sealed'], message: 'an offer carries sealed exactly when its sealing includes task-input' });
        return;
      }
      if (sealed !== undefined && (sealed.scope.id !== sealing!.scopeId || sealed.scope.epoch !== sealing!.epoch)) {
        ctx.addIssue({ code: 'custom', path: ['sealed', 'scope'], message: 'the offer task-input must be sealed under the task scope at the task epoch' });
      }
    }
    if (sealed === undefined) return;
    for (const [field, placeholder] of Object.entries(entry.moved)) {
      if (!holdsPlaceholder(fields[field], placeholder)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: placeholder === 'absent' ? `a sealed ${type} must not carry ${field}` : `a sealed ${type} carries the ${field} placeholder only`,
        });
      }
    }
    for (const field of entry.identity) {
      if (fields[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `a sealed ${type} must carry its identity field ${field}` });
    }
    for (const field of entry.forbidden) {
      if (fields[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `a sealed ${type} must not carry ${field}` });
    }
  };
}
