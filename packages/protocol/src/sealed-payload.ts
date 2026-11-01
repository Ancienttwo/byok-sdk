/**
 * Sealed payload on the hosted wire: v1 (#654 design §8.1, §8.3, §8.6) and
 * the v2 categories (#1045).
 *
 * Sealed is a property of the payload, not a message type: each sealable
 * type's payload is a plaintext branch or a sealed branch. The sealed branch is
 * the plaintext fields without the ones one data category moves into the
 * ciphertext, plus a sealed member; its marker field is gated on
 * `sealed-payload-v1`, and the payload is strict, so a decoder that does not
 * know the branch refuses the whole message. The Host reads only the sealed
 * member's outer fields. It checks the shape here:
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

import { AGENT_MESSAGE_MAX_BYTES } from './agent-egress';
import { BlobRefSchema, CONTENT_HASH_RE } from './blob';

import { SEALED_SPLIT_TABLE, isSealableMessageType, sealedMovedFields, type SealedSplitEntry } from './sealed-split-table';

export { SEALED_SPLIT_TABLE, isSealableMessageType, isSealedPayload, sealedMovedFields } from './sealed-split-table';
export type { SealableMessageType, SealedDigestRule, SealedSplitEntry } from './sealed-split-table';

export const SEALED_PAYLOAD_VERSION = 1;
/** The only suite v1 admits. A new suite is a new constant and a new capability, never a parser branch. */
export const SEALED_PAYLOAD_SUITE = 'byok-sealed-v1.hkdf-sha256.aes-256-gcm';

/**
 * C1–C4 in canonical order. A task lists its sealing categories in this order.
 * Input preparation and drafts have no category; they stay plaintext.
 */
export const SEALED_PAYLOAD_CATEGORIES = ['task-input', 'agent-message', 'task-output', 'memory-projection'] as const;
export type SealedPayloadCategory = (typeof SEALED_PAYLOAD_CATEGORIES)[number];

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

/**
 * The closed plaintext codes of a task whose output is sealed (#654 12d).
 * It lists each output type that has a plaintext form on such a task, with
 * the codes that each field moved or dropped by its sealed branch may hold.
 * Such a field that is not listed here must be absent. An output type with a
 * sealed branch that is not listed has no plaintext form. An
 * interrupted task reports `daemon_interrupted`; a device that cannot seal
 * reports `sealed_key_unavailable`. The Host check, the daemon and the member
 * display read this one list, and compare by exact match.
 */
export const SEALED_TASK_PLAIN_CODES = Object.freeze({
  'task.fail': { reason: ['daemon_interrupted', 'sealed_key_unavailable'] },
  'task.decline': { reason: SEALED_DECLINE_CODES },
  'task.cancelled': { reason: [] },
} as const);

/**
 * True when `payload` is a legal plaintext `type` message of a task whose
 * output is sealed under `categories`: each field that the `task-output`
 * sealed branch of `type` moves (with the `movedWith` fields of `categories`)
 * or drops is absent or holds one of {@link SEALED_TASK_PLAIN_CODES}. A type
 * that has a sealed output branch and is not listed there is never legal. A
 * plaintext decline also names its code as `code`. A type with no sealed
 * output branch is always legal.
 */
export function isSealedTaskPlainOutput(type: string, payload: object, categories: readonly SealedPayloadCategory[]): boolean {
  const codes: { readonly [field: string]: readonly string[] } = Object.hasOwn(SEALED_TASK_PLAIN_CODES, type)
    ? SEALED_TASK_PLAIN_CODES[type as keyof typeof SEALED_TASK_PLAIN_CODES]
    : {};
  const entry: SealedSplitEntry | undefined = isSealableMessageType(type) ? SEALED_SPLIT_TABLE[type] : undefined;
  const fields: readonly string[] = entry?.category === 'task-output'
    ? [...sealedMovedFields(type as keyof typeof SEALED_SPLIT_TABLE, categories), ...entry.forbidden]
    : [];
  if (fields.length > 0 && !Object.hasOwn(SEALED_TASK_PLAIN_CODES, type)) return false;
  const record = payload as Readonly<Record<string, unknown>>;
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && !(typeof value === 'string' && (codes[field] ?? []).includes(value))) return false;
  }
  return type !== 'task.decline' || record.reason === undefined || record.code === record.reason;
}

/** Padded frames above this length travel as a ciphertext blob (§8.6). */
export const SEALED_INLINE_MAX_PADDED_LENGTH = 256 * 1024;

/** Plaintext limit of every category, in UTF-8 bytes of canonical JSON (D8). */
export const SEALED_PAYLOAD_MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

/** `{"body":""}`: the canonical JSON of a sealed message around its body. */
const SEALED_AGENT_MESSAGE_FRAME_BYTES = 11;
/**
 * The canonical JSON escaping bound: `JSON.stringify` turns a one-byte
 * control character into the six bytes `\u00XX`, and nothing grows more per
 * UTF-8 byte (a lone surrogate, three bytes, becomes six).
 */
const JSON_STRING_MAX_EXPANSION = 6;

/**
 * The largest opened content of a sealed `agent.message.publish` whose body
 * is at most `maxBytes` UTF-8 bytes (#1045 O2): `6 × maxBytes + 11`. At
 * `AGENT_MESSAGE_MAX_BYTES` it is 1,572,875, below
 * {@link SEALED_PAYLOAD_MAX_CONTENT_LENGTH}, so every legal body seals. The
 * device seals within it, and the Host bounds a sealed message's
 * `paddedLength` by `sealedPayloadPaddedLength(4 + this)` for the task's
 * frozen `maxBytes`.
 */
export function sealedAgentMessageMaxContentLength(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > AGENT_MESSAGE_MAX_BYTES) {
    throw new RangeError(`An Agent message limit must be an integer from 1 to ${AGENT_MESSAGE_MAX_BYTES}`);
  }
  return JSON_STRING_MAX_EXPANSION * maxBytes + SEALED_AGENT_MESSAGE_FRAME_BYTES;
}

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

/** The largest padded length a sealed content may have. */
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
 * A message type fixes its category, so its schema names it as a literal. An
 * inline-only content refuses a padded length above the inline maximum.
 */
function sealedPayloadSchema<Category extends z.ZodType<SealedPayloadCategory>>(category: Category, inlineOnly = false) {
  return z
    .object({
      v: z.literal(SEALED_PAYLOAD_VERSION),
      suite: z.literal(SEALED_PAYLOAD_SUITE),
      category,
      scope: z
        .object({
          id: z.string().min(1),
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
      if (inlineOnly && !inline) {
        ctx.addIssue({ code: 'custom', path: ['paddedLength'], message: `an inline-only content has a padded length up to ${SEALED_INLINE_MAX_PADDED_LENGTH}` });
        return;
      }
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

/** A sealed member of any category. */
export const SealedPayloadSchema = sealedPayloadSchema(z.enum(SEALED_PAYLOAD_CATEGORIES));
export type SealedPayload = z.infer<typeof SealedPayloadSchema>;
/** The sealed member of a task-input message (offers, steer). */
export const SealedTaskInputSchema = sealedPayloadSchema(z.literal('task-input'));
/** The sealed member of a task-output message. */
export const SealedTaskOutputSchema = sealedPayloadSchema(z.literal('task-output'));
/** The sealed member of an `agent.message.publish` (#1045 C2). */
export const SealedAgentMessageSchema = sealedPayloadSchema(z.literal('agent-message'));
/**
 * The sealed member of a memory projection (#1045 C4). It is inline only
 * (owner decision O2): the Host keeps one latest snapshot per Agent and holds
 * no ciphertext blob for it.
 */
export const SealedMemoryProjectionSchema = sealedPayloadSchema(z.literal('memory-projection'), true);

function isCanonicalCategoryList(categories: readonly string[]): boolean {
  return categories.every((category, index) => index === 0
    || SEALED_PAYLOAD_CATEGORIES.indexOf(categories[index - 1] as SealedPayloadCategory)
      < SEALED_PAYLOAD_CATEGORIES.indexOf(category as SealedPayloadCategory));
}

/**
 * A task's frozen sealing policy (§6.2). The offer carries it in plaintext.
 * `epoch` is the epoch of the offer's task-input content, and the lowest epoch
 * the task accepts. `memory-projection` needs `task-output`: a terminal seals
 * the task's memory-change evidence inside its task-output ciphertext.
 */
export const TaskSealingSchema = z
  .object({
    scopeId: z.string().min(1),
    epoch: PositiveIntegerSchema,
    categories: z
      .array(z.enum(SEALED_PAYLOAD_CATEGORIES))
      .min(1)
      .refine(isCanonicalCategoryList, 'categories must be unique and in canonical order')
      .refine(
        (categories) => !categories.includes('memory-projection') || categories.includes('task-output'),
        'a task that seals memory-projection seals task-output too',
      ),
  })
  .strict();
export type TaskSealing = z.infer<typeof TaskSealingSchema>;

/**
 * A canonical UTC instant, `YYYY-MM-DDTHH:mm:ss.sssZ` and a real calendar
 * instant. This is the form core binds as `notAfter` in the AAD
 * (`@byok-sdk/core` `isCanonicalTimestamp`), so a device can rebuild the AAD
 * from the wire value byte for byte.
 */
const CanonicalInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const instant = Date.parse(value);
    return Number.isFinite(instant) && new Date(instant).toISOString() === value;
  }, 'must be a canonical UTC instant');

/**
 * The routine template of a sealed execution (design §6.3). The offer's
 * `sealed` member is then the template, family `routine.template`, which the
 * member sealed once for every occurrence. The device rebuilds its binding
 * from these fields: identity `{ routineId, definitionVersion }`, no device,
 * the offer's `agentRef` and `sealing.categories`, and `notAfter`. They travel
 * in plaintext because the AAD binds them. `definitionVersion` is an integer,
 * because the binding tells `4` and `"4"` apart. The device, not the Host,
 * checks `notAfter` against its clock.
 */
export const RoutineRefSchema = z
  .object({
    routineId: z.string().min(1),
    definitionVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    notAfter: CanonicalInstantSchema,
  })
  .strict();


/**
 * The rule of a sealed offer, for `superRefine`: `sealed` is present exactly
 * when the task's `sealing` includes `task-input`, and then `instruction` is
 * absent and `sealed.scope` is the task's scope at the task's epoch. When the
 * task seals only its output, `instruction` is plaintext and required. A
 * `routineRef` names a routine template, which is sealed task input, so it
 * needs a task that seals `task-input`.
 *
 * Whether a task's later messages must be sealed is the Host's and the
 * device's check: they know the task's `sealing`, this payload does not.
 */
export function sealedOfferRule(
  payload: { readonly instruction?: unknown; readonly sealing: TaskSealing; readonly sealed?: SealedPayload; readonly routineRef?: unknown },
  ctx: z.RefinementCtx,
): void {
  const { instruction, sealing, sealed, routineRef } = payload;
  if (!sealing.categories.includes('task-input')) {
    if (routineRef !== undefined) ctx.addIssue({ code: 'custom', path: ['routineRef'], message: 'a routine template is sealed task input, so routineRef needs a task that seals task-input' });
    if (sealed !== undefined) ctx.addIssue({ code: 'custom', path: ['sealed'], message: 'a task that does not seal task-input carries no sealed member' });
    if (instruction === undefined) ctx.addIssue({ code: 'custom', path: ['instruction'], message: 'a task that does not seal task-input carries a plaintext instruction' });
    return;
  }
  if (sealed === undefined) {
    ctx.addIssue({ code: 'custom', path: ['sealed'], message: 'a task that seals task-input carries the sealed instruction' });
    return;
  }
  if (instruction !== undefined) ctx.addIssue({ code: 'custom', path: ['instruction'], message: 'a sealed instruction never travels in plaintext too' });
  if (sealed.scope.id !== sealing.scopeId || sealed.scope.epoch !== sealing.epoch) {
    ctx.addIssue({ code: 'custom', path: ['sealed', 'scope'], message: 'the offer task-input must be sealed under the task scope at the task epoch' });
  }
}
