/**
 * Host storage for member keys, the member chain and scope key packages
 * (#654 design §7.2–§7.4, E2c), and the Host part of crypto-shredding
 * (§11.2, E5b-1).
 *
 * The Host holds no key. It checks shapes, keeps the chain contiguous and
 * first-writer-wins per seq, fixes one `keyId` per scope epoch, and relays
 * the pairing MACs. Members verify everything else (§7.3).
 *
 * A `shred` entry deletes its scope's key packages and epochs in the append
 * that stores it, and later package puts for that scope are refused. The
 * Host verifies no signature, so any paired device of the tenant can append
 * a well-shaped `shred` (owner batch §50g A, `docs/security.md`).
 *
 * Every input is read once into canonical JSON text. The store keeps that
 * text, so a replay compares by bytes and a later read returns the same
 * bytes the writer sent.
 */
import { canonicalizeJson, type JsonValue, type TenantId } from '@byok-sdk/core';
import {
  E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES,
  E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES,
  E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES,
  E2EE_SCOPE_ID_MAX_LENGTH,
  E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX,
  E2EE_SCOPE_KEY_PACKAGE_PUT_MAX,
  E2eeClientPairingMacSchema,
  E2eeMemberChainEntrySchema,
  E2eeMemberKeyBundleSchema,
  E2eeMemberKeyRegisterRequestSchema,
  E2eeScopeKeyPackageSchema,
  E2eeScopeKeyPackageV2Schema,
  requiredReceiverCapabilities,
  type E2eeClientPairingMac,
  type E2eeKeyPackageAvailablePayload,
  type E2eeMemberChainEntry,
  type E2eeMemberKeyBundle,
  type E2eeScopeKeyPackage,
} from '@byok-sdk/protocol';
import { z } from 'zod';
import { PAIRING_CODE_TTL_MS } from './auth/plane';
import type { DeviceDirectory } from './stores/ports';
import { ByokCloudError, DeviceRetiredError } from './errors';

/** One stored chain entry: its seq and its canonical JSON. */
export interface E2eeMemberChainRow {
  readonly seq: number;
  readonly entry: string;
}

/**
 * The binding of a device-proof write (owner batch §41a A). The proof's
 * `requestId` is single-use per device, as on the truth put: a store records
 * it with the write and its result. A later write with the same `requestId`
 * and the same binding gets the stored result and writes nothing; one with
 * another binding is refused.
 */
export interface E2eeProofRequest {
  readonly requestId: string;
  readonly operation: string;
  readonly resource: string;
  readonly bodySha256: string;
  readonly bodySize: number;
}

/** A device write: the proven device and its proof binding. A Host control-plane write has none. */
export interface E2eeProvenWrite {
  readonly deviceId: string;
  readonly request: E2eeProofRequest;
}

/** The audit receipt key prefix of a scope shred. It is an identity receipt and never expires. */
export const E2EE_SCOPE_SHRED_RECEIPT_PREFIX = 'e2ee-scope-shred:';

/** A `shred` entry of an append, read by cloud from the entry's strict subject. */
export interface E2eeScopeShred {
  /** The seq of the `shred` entry. It is one of the appended rows. */
  readonly seq: number;
  readonly scopeId: string;
  /** The audit receipt cloud built. The store writes it in the receipt store, first writer wins. */
  readonly receipt: { readonly key: string; readonly body: string };
}

export interface E2eeMemberChainAppendInput {
  readonly rows: readonly E2eeMemberChainRow[];
  /** The `shred` entries among `rows`, in seq order. */
  readonly shreds: readonly E2eeScopeShred[];
  /** The `rotate` entries among `rows`, in seq order: each raises its member's KEM floor (owner batch §77a). */
  readonly rotations: readonly { readonly seq: number; readonly memberId: string; readonly kemEpoch: number }[];
  /** Set for a device write, absent for a Host control-plane write. */
  readonly proof?: E2eeProvenWrite;
}

/** Who wrote: the Host control plane, or a device through its proof route. A shred receipt records it. */
export type E2eeMemberWriter =
  | { readonly kind: 'host' }
  | { readonly kind: 'device'; readonly proof: E2eeProvenWrite };

export type E2eeMemberChainAppendResult =
  | {
      readonly outcome: 'appended';
      /** New rows written. */
      readonly appended: number;
      /** Rows already stored with the same bytes. */
      readonly replayed: number;
    }
  /** A different entry is stored at `seq`. Nothing was written. */
  | { readonly outcome: 'conflict'; readonly seq: number }
  /** The first new entry does not follow the stored head. Nothing was written. */
  | { readonly outcome: 'gap'; readonly seq: number; readonly headSeq: number }
  /** The device already used this `requestId` with another binding. Nothing was written. */
  | { readonly outcome: 'request_conflict' };

/** One stored scope key package, with the columns the store keys and filters on. */
export interface E2eeScopeKeyPackageRow {
  readonly scopeId: string;
  readonly epoch: number;
  readonly recipient: string;
  readonly keyId: string;
  readonly sender: string;
  /** Canonical JSON of the package. */
  readonly package: string;
}

export interface E2eeScopeKeyPackagePutInput {
  /**
   * Sorted by `(scopeId, epoch, recipient)` in code point order, one row per
   * scope epoch and recipient. `recipientKemEpoch` is the package's own field,
   * for the floor check only; the store keeps it in `package` and nowhere else.
   */
  readonly rows: readonly (E2eeScopeKeyPackageRow & { readonly recipientKemEpoch: number })[];
  /** Set for a device write, absent for a Host control-plane write. */
  readonly proof?: E2eeProvenWrite;
}

export type E2eeScopeKeyPackagePutResult =
  | { readonly outcome: 'stored'; readonly stored: number }
  /** The first package of this scope epoch fixed another `keyId`. Nothing was written. */
  | { readonly outcome: 'key_id_conflict'; readonly scopeId: string; readonly epoch: number; readonly keyId: string }
  /** The member chain shredded this scope. Nothing was written. */
  | { readonly outcome: 'scope_shredded'; readonly scopeId: string }
  /** A package is wrapped to an older KEM epoch than its recipient's floor. Nothing was written. */
  | { readonly outcome: 'kem_epoch_stale'; readonly recipient: string; readonly kemEpoch: number; readonly floor: number }
  /** The device already used this `requestId` with another binding. Nothing was written. */
  | { readonly outcome: 'request_conflict' };

export interface E2eeMemberRegistrationInput {
  readonly deviceId: string;
  readonly memberId: string;
  /** Canonical JSON of the device's member key bundle. */
  readonly bundle: string;
  /** The device pairing MAC (§7.2 step 3). */
  readonly deviceMac: string;
  readonly macExpiresAt: string;
  /** The proof binding of the registration write; its device is `deviceId`. */
  readonly request: E2eeProofRequest;
}

/**
 * - `registered`: the bundle and the MAC were stored.
 * - `replayed`: the same bundle was already stored; the MAC and its expiry were replaced.
 * - `device_conflict`: the device registered another bundle. Nothing changed.
 * - `member_conflict`: another device registered this member id. Nothing changed.
 * - `request_conflict`: the device already used this `requestId` with another binding. Nothing changed.
 */
export type E2eeMemberRegisterResult = 'registered' | 'replayed' | 'device_conflict' | 'member_conflict' | 'request_conflict';

export interface E2eeMemberRegistrationRow {
  readonly memberId: string;
  /** Canonical JSON of the bundle. */
  readonly bundle: string;
  /** Absent once the pairing window has passed. */
  readonly deviceMac?: string;
}

/**
 * Durable E2EE member state. Every method is scoped to `tenant`. Each write
 * is atomic: a refused write leaves nothing behind.
 *
 * A device write carries its proof binding (`proof`, or `request` on a
 * registration). In the same atomic write, the store records the device's
 * `requestId`, its binding and the write's result. If that `requestId` is
 * already recorded for the device, the store writes nothing: with the same
 * binding it returns the recorded result, and with another binding it
 * returns `request_conflict`. A refused write records nothing.
 */
export interface E2eeMemberStore {
  /**
   * Rows have contiguous ascending seqs. A row at a stored seq must hold the
   * same bytes (a replay). The first new row must be the stored head plus one.
   *
   * For each shred whose row this call newly stores, in the same atomic
   * write: delete the scope's key packages, then its epochs, record the scope
   * as shredded with the seq of its first shred, and record the shred's
   * receipt in the deployment's request receipt store unless that key is
   * already there. A replayed row shreds nothing again. A refused append
   * deletes nothing. A store that has concurrent writers serializes each
   * shred with every package put of the same scope.
   *
   * For each rotation whose row this call newly stores, in the same atomic
   * write: raise the member's KEM floor to `kemEpoch`; a floor never falls.
   * A store that has concurrent writers serializes it with every package put
   * to that member.
   */
  appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult>;
  /** Entries with `seq > afterSeq`, ascending, at most `limit`. */
  readChainEntries(
    tenant: TenantId,
    input: { readonly afterSeq: number; readonly limit: number },
  ): Promise<readonly E2eeMemberChainRow[]>;
  /**
   * A row of a shredded scope refuses the whole put. Then a row whose
   * `recipientKemEpoch` is below its recipient's KEM floor refuses the whole
   * put, naming the first such row. The first package of a
   * `(scopeId, epoch)` fixes its `keyId`, also within this call: a second
   * `keyId` for that scope epoch refuses the whole put. A package with that
   * `keyId` inserts or replaces the row of its recipient.
   */
  putScopeKeyPackages(tenant: TenantId, input: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult>;
  /** This recipient's packages of one scope with `epoch > afterEpoch`, by epoch, at most `limit`; and the scope's newest epoch. */
  readOwnScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly recipient: string; readonly afterEpoch: number; readonly limit: number },
  ): Promise<{ readonly rows: readonly E2eeScopeKeyPackageRow[]; readonly scopeHeadEpoch: number | undefined }>;
  /** Ordered by epoch, then recipient. */
  readScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
  ): Promise<readonly E2eeScopeKeyPackageRow[]>;
  registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult>;
  /** The MAC is returned only while `now` is before its expiry. */
  readMemberRegistration(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly now: string },
  ): Promise<E2eeMemberRegistrationRow | undefined>;
  /** Store or replace the client pairing MAC (§7.2 step 4) of a registered device. */
  putClientPairingMac(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly body: string; readonly expiresAt: string },
  ): Promise<'stored' | 'not_registered'>;
  /** Canonical JSON of the client MAC, while `now` is before its expiry. */
  readClientPairingMac(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly now: string },
  ): Promise<string | undefined>;
}

function invalid(message: string): ByokCloudError {
  return new ByokCloudError('coordination_input_invalid', message);
}

function requestConflict(): ByokCloudError {
  return new ByokCloudError('proof_request_conflict', 'This device already used the proof requestId with another request.');
}

function proofOf(writer: E2eeMemberWriter): { readonly proof?: E2eeProvenWrite } {
  return writer.kind === 'host' ? {} : { proof: writer.proof };
}

/** A stored row must still be the value its schema requires; only the store writes it. */
function storedValue<S extends z.ZodType>(schema: S, text: string, what: string): z.infer<S> {
  let parsed: z.ZodSafeParseResult<z.infer<S>> | undefined;
  try {
    parsed = schema.safeParse(JSON.parse(text));
  } catch {}
  if (parsed?.success !== true) {
    throw new ByokCloudError('e2ee_member_state_unreadable', `A stored ${what} is not valid. The store contract is broken.`);
  }
  return parsed.data;
}

const CHAIN_APPEND_RESULT = z.strictObject({
  outcome: z.literal('appended'),
  appended: z.number().int().nonnegative(),
  replayed: z.number().int().nonnegative(),
});
const KEY_PACKAGE_PUT_RESULT = z.strictObject({ outcome: z.literal('stored'), stored: z.number().int().nonnegative() });
const MEMBER_KEY_REGISTER_RESULT = z.enum(['registered', 'replayed']);

/**
 * The result a store recorded with a device write, read back for a replay.
 * A store records only a successful result, so any other stored text breaks
 * the store contract and fails closed.
 */
export function parseRecordedWriteResult(write: 'chainAppend', text: string): Extract<E2eeMemberChainAppendResult, { readonly outcome: 'appended' }>;
export function parseRecordedWriteResult(write: 'keyPackagePut', text: string): Extract<E2eeScopeKeyPackagePutResult, { readonly outcome: 'stored' }>;
export function parseRecordedWriteResult(write: 'memberKeyRegister', text: string): Extract<E2eeMemberRegisterResult, 'registered' | 'replayed'>;
export function parseRecordedWriteResult(write: 'chainAppend' | 'keyPackagePut' | 'memberKeyRegister', text: string) {
  switch (write) {
    case 'chainAppend':
      return storedValue(CHAIN_APPEND_RESULT, text, 'recorded request result');
    case 'keyPackagePut':
      return storedValue(KEY_PACKAGE_PUT_RESULT, text, 'recorded request result');
    case 'memberKeyRegister':
      return storedValue(MEMBER_KEY_REGISTER_RESULT, text, 'recorded request result');
  }
}

function scopeIdValid(scopeId: unknown): scopeId is string {
  return typeof scopeId === 'string' && scopeId.length > 0 && scopeId.length <= E2EE_SCOPE_ID_MAX_LENGTH;
}

/** Read caller data once into canonical JSON, then check it against the wire shape. */
function canonicalParse<S extends z.ZodType>(schema: S, value: unknown, what: string): { readonly text: string; readonly value: z.infer<S> } {
  let text: string;
  try {
    text = canonicalizeJson(value as JsonValue);
  } catch {
    throw invalid(`${what} is not canonical JSON`);
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw invalid(`${what} is invalid`);
  return { text, value: parsed.data };
}

/** Read a list field once: the field, the list and every item become one plain JSON snapshot. */
function boundedList(read: () => unknown, max: number, what: string): readonly unknown[] {
  let list: unknown;
  try {
    list = JSON.parse(canonicalizeJson(read() as JsonValue));
  } catch {
    throw invalid(`${what} must be a canonical JSON list`);
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > max) {
    throw invalid(`${what} must hold 1 to ${max} items`);
  }
  return list;
}

/** Read the named fields of a small input object once each. */
function readFields<T extends object>(input: T | undefined): Partial<T> {
  try {
    return input === undefined ? {} : { ...input };
  } catch {
    throw invalid('Input could not be read');
  }
}

export interface E2eeMemberContext {
  readonly store: E2eeMemberStore;
  readonly tenant: TenantId;
  readonly devices: DeviceDirectory;
  readonly now: () => Date;
  /** Enqueue `e2ee.key_package.available` for one device; it refuses a device without the gate capability. */
  readonly enqueueKeyPackageNotice: (deviceId: string, payload: E2eeKeyPackageAvailablePayload) => Promise<unknown>;
}

export async function appendMemberChainEntries(
  ctx: E2eeMemberContext,
  input: { readonly entries: readonly E2eeMemberChainEntry[] },
  writer: E2eeMemberWriter,
): Promise<{ readonly appended: number; readonly replayed: number }> {
  const list = boundedList(() => input.entries, E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES, 'Member chain entries');
  const shreds: E2eeScopeShred[] = [];
  const rotations: { seq: number; memberId: string; kemEpoch: number }[] = [];
  const shreddedAt = ctx.now().toISOString();
  const rows = list.map((input, index) => {
    const { text, value } = canonicalParse(E2eeMemberChainEntrySchema, input, `Member chain entry ${index}`);
    if (new TextEncoder().encode(text).byteLength > E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES) {
      throw invalid(`Member chain entry ${index} exceeds ${E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES} bytes`);
    }
    if (value.tenantId !== ctx.tenant) throw invalid(`Member chain entry ${index} names another tenant`);
    // The entry schema has checked the exact subject of a shred and a rotate.
    if (value.op === 'rotate') {
      const { memberId, kemEpoch } = value.subject as { readonly memberId: string; readonly kemEpoch: number };
      rotations.push({ seq: value.seq, memberId, kemEpoch });
    }
    const scopeId = value.op === 'shred' ? (value.subject as { readonly scopeId: string }).scopeId : undefined;
    // A scope id over the Host limit gets no shred record: every put and read
    // refuses that id, so it has no packages or epochs. It would also not fit
    // a Postgres index entry.
    if (scopeId !== undefined && scopeIdValid(scopeId)) {
      shreds.push({
        seq: value.seq,
        scopeId,
        receipt: {
          key: `${E2EE_SCOPE_SHRED_RECEIPT_PREFIX}${scopeId}`,
          body: canonicalizeJson({
            chainSeq: value.seq,
            shreddedAt,
            writer: writer.kind === 'host' ? writer : { kind: 'device', deviceId: writer.proof.deviceId },
          }),
        },
      });
    }
    return { seq: value.seq, entry: text };
  });
  if (rows.some((row, index) => row.seq !== rows[0]!.seq + index)) {
    throw invalid('Member chain entries must have contiguous ascending seqs');
  }
  const result = await ctx.store.appendChainEntries(ctx.tenant, { rows, shreds, rotations, ...proofOf(writer) });
  if (result.outcome === 'request_conflict') throw requestConflict();
  if (result.outcome === 'conflict') {
    throw new ByokCloudError('e2ee_member_chain_conflict', `A different member chain entry is stored at seq ${result.seq}.`);
  }
  if (result.outcome === 'gap') {
    throw new ByokCloudError(
      'e2ee_member_chain_conflict',
      `Member chain entry seq ${result.seq} does not follow the stored head seq ${result.headSeq}.`,
    );
  }
  return { appended: result.appended, replayed: result.replayed };
}

export async function readMemberChain(
  ctx: E2eeMemberContext,
  input: { readonly afterSeq?: number; readonly limit?: number } = {},
): Promise<{ readonly entries: readonly E2eeMemberChainEntry[] }> {
  const { afterSeq = 0, limit = E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES } = readFields(input);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw invalid('afterSeq must be a nonnegative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES) {
    throw invalid(`limit must be 1 to ${E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES}`);
  }
  const rows = await ctx.store.readChainEntries(ctx.tenant, { afterSeq, limit });
  return { entries: rows.map(row => storedValue(E2eeMemberChainEntrySchema, row.entry, 'member chain entry')) };
}

export async function putScopeKeyPackages(
  ctx: E2eeMemberContext,
  input: { readonly packages: readonly z.infer<typeof E2eeScopeKeyPackageV2Schema>[] },
  writer: E2eeMemberWriter,
): Promise<{ readonly stored: number; readonly skippedDeviceIds: readonly string[] }> {
  const list = boundedList(() => input.packages, E2EE_SCOPE_KEY_PACKAGE_PUT_MAX, 'Scope key packages');
  const rows = list.map((input, index) => {
    const { text, value } = canonicalParse(E2eeScopeKeyPackageV2Schema, input, `Scope key package ${index}`);
    if (value.tenantId !== ctx.tenant) throw invalid(`Scope key package ${index} names another tenant`);
    if (!scopeIdValid(value.scopeId)) throw invalid(`Scope key package ${index} has a scopeId over ${E2EE_SCOPE_ID_MAX_LENGTH} characters`);
    return {
      scopeId: value.scopeId,
      epoch: value.epoch,
      recipient: value.recipient,
      keyId: value.keyId,
      sender: value.sender,
      package: text,
      recipientKemEpoch: value.recipientKemEpoch,
    };
  });
  // One lock order for every writer: Postgres puts and device cleanup both
  // lock rows by (scopeId, epoch, recipient) in code point order, so two
  // writers that share rows cannot deadlock. Sorted, the rows of one scope
  // epoch are adjacent, so neighbours show a second keyId or a repeated recipient.
  rows.sort((a, b) => compareCodePoints(a.scopeId, b.scopeId) || a.epoch - b.epoch || compareCodePoints(a.recipient, b.recipient));
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const row = rows[index]!;
    if (previous.scopeId !== row.scopeId || previous.epoch !== row.epoch) continue;
    if (previous.keyId !== row.keyId) throw invalid(`Scope key packages name two keyIds for scope ${row.scopeId} epoch ${row.epoch}`);
    if (previous.recipient === row.recipient) throw invalid(`Scope key packages repeat a recipient of scope ${row.scopeId} epoch ${row.epoch}`);
  }
  const result = await ctx.store.putScopeKeyPackages(ctx.tenant, { rows, ...proofOf(writer) });
  if (result.outcome === 'request_conflict') throw requestConflict();
  if (result.outcome === 'scope_shredded') {
    throw new ByokCloudError('e2ee_scope_shredded', `Scope ${result.scopeId} was shredded on the member chain.`);
  }
  if (result.outcome === 'kem_epoch_stale') {
    throw new ByokCloudError(
      'e2ee_scope_key_package_stale',
      `A package to ${result.recipient} is wrapped to KEM epoch ${result.kemEpoch}, below its floor ${result.floor}.`,
    );
  }
  if (result.outcome === 'key_id_conflict') {
    throw new ByokCloudError(
      'e2ee_scope_key_conflict',
      `Scope ${result.scopeId} epoch ${result.epoch} already has keyId ${result.keyId}.`,
    );
  }
  return { stored: result.stored, skippedDeviceIds: await notifyRecipientDevices(ctx, rows) };
}

/**
 * After the commit, notify each recipient that is a registered device (§7.4,
 * notice-and-fetch). A replayed put notifies again, because a crash between
 * the commit and the notice must not lose it; the derived mailbox message id
 * makes a repeat return the same row. A device without the gate capability
 * gets no notice and is returned, so the Host can show it; it fetches the
 * package after an upgrade. A recipient with no device registration, such as
 * a browser member, has no mailbox. `rows` holds one row per scope epoch and
 * recipient, so each device gets one notice per scope epoch.
 */
async function notifyRecipientDevices(ctx: E2eeMemberContext, rows: readonly E2eeScopeKeyPackageRow[]): Promise<string[]> {
  const required = requiredReceiverCapabilities('e2ee.key_package.available', {});
  const now = ctx.now().toISOString();
  const skipped: string[] = [];
  for (const device of await ctx.devices.list(ctx.tenant)) {
    const registration = await ctx.store.readMemberRegistration(ctx.tenant, { deviceId: device.deviceId, now });
    const notices = rows.filter(row => row.recipient === registration?.memberId);
    if (notices.length === 0) continue;
    if (!required.every(capability => device.capabilities?.includes(capability) === true)) {
      skipped.push(device.deviceId);
      continue;
    }
    try {
      for (const row of notices) await ctx.enqueueKeyPackageNotice(device.deviceId, { scopeId: row.scopeId, epoch: row.epoch });
    } catch (refusal) {
      // Retired after the list was read: a device that no longer exists needs no notice.
      if (!(refusal instanceof DeviceRetiredError)) throw refusal;
    }
  }
  return skipped.sort(compareCodePoints);
}

function scopeQuery(fields: { readonly scopeId?: unknown; readonly epoch?: unknown }): { readonly scopeId: string; readonly epoch?: number } {
  const { scopeId, epoch } = fields;
  if (!scopeIdValid(scopeId)) throw invalid(`scopeId must have 1 to ${E2EE_SCOPE_ID_MAX_LENGTH} characters`);
  if (epoch !== undefined && (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1)) {
    throw invalid('epoch must be a positive safe integer');
  }
  return epoch === undefined ? { scopeId } : { scopeId, epoch };
}

export async function readScopeKeyPackages(
  ctx: E2eeMemberContext,
  input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
): Promise<{ readonly packages: readonly E2eeScopeKeyPackage[] }> {
  const fields = readFields(input);
  const { recipient } = fields;
  if (recipient !== undefined && (typeof recipient !== 'string' || recipient.length === 0)) {
    throw invalid('recipient must be a nonempty string');
  }
  const rows = await ctx.store.readScopeKeyPackages(ctx.tenant, {
    ...scopeQuery(fields),
    ...(recipient === undefined ? {} : { recipient }),
  });
  return { packages: rows.map(row => storedValue(E2eeScopeKeyPackageSchema, row.package, 'scope key package')) };
}

/** Code point order, which is UTF-8 byte order and Postgres `COLLATE "C"` order. */
function compareCodePoints(a: string, b: string): number {
  for (let index = 0; index < a.length && index < b.length;) {
    const left = a.codePointAt(index)!;
    const right = b.codePointAt(index)!;
    if (left !== right) return left - right;
    index += left > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

async function activeDevice(ctx: E2eeMemberContext, deviceId: string): Promise<boolean> {
  if (typeof deviceId !== 'string' || deviceId.length === 0) throw invalid('deviceId is required');
  const device = await ctx.devices.get(ctx.tenant, deviceId);
  return device !== undefined && !device.revoked;
}

/**
 * The bundle a device registered, and its pairing MAC while the pairing
 * window is open. A missing or revoked device has none, even if a cleanup
 * missed its rows.
 */
export async function readMemberKeyRegistration(
  ctx: E2eeMemberContext,
  deviceId: string,
): Promise<{ readonly member: E2eeMemberKeyBundle; readonly deviceMac?: string } | undefined> {
  if (!(await activeDevice(ctx, deviceId))) return undefined;
  const row = await ctx.store.readMemberRegistration(ctx.tenant, { deviceId, now: ctx.now().toISOString() });
  if (row === undefined) return undefined;
  const member = storedValue(E2eeMemberKeyBundleSchema, row.bundle, 'member key bundle');
  return row.deviceMac === undefined ? { member } : { member, deviceMac: row.deviceMac };
}

/** Relay the client pairing MAC to a registered device for one pairing window. */
export async function relayClientPairingMac(
  ctx: E2eeMemberContext,
  deviceId: string,
  input: E2eeClientPairingMac,
): Promise<void> {
  if (!(await activeDevice(ctx, deviceId))) {
    throw new ByokCloudError('device_not_found', `Device ${deviceId} is unknown or revoked in this tenant.`);
  }
  const { text } = canonicalParse(E2eeClientPairingMacSchema, input, 'Client pairing MAC');
  const expiresAt = new Date(ctx.now().getTime() + PAIRING_CODE_TTL_MS).toISOString();
  const result = await ctx.store.putClientPairingMac(ctx.tenant, { deviceId, body: text, expiresAt });
  if (result === 'not_registered') {
    throw new ByokCloudError('e2ee_member_not_registered', `Device ${deviceId} has not registered a member key bundle.`);
  }
}

/**
 * A device registers its own member key bundle with the device pairing MAC
 * (§7.2 step 3). The bundle must name the proven device. The MAC is kept for
 * one pairing window; a retry with the same bundle replaces the MAC and its expiry.
 */
export async function registerDeviceMemberKey(
  ctx: E2eeMemberContext,
  proof: E2eeProvenWrite,
  input: unknown,
): Promise<{ readonly memberId: string }> {
  const { deviceId } = proof;
  const { value } = canonicalParse(E2eeMemberKeyRegisterRequestSchema, input, 'Member key registration');
  if (value.member.deviceId !== deviceId) throw invalid('The member key bundle names another device');
  const result = await ctx.store.registerMember(ctx.tenant, {
    deviceId,
    memberId: value.member.memberId,
    bundle: canonicalizeJson(value.member as unknown as JsonValue),
    deviceMac: value.mac,
    macExpiresAt: new Date(ctx.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(),
    request: proof.request,
  });
  if (result === 'request_conflict') throw requestConflict();
  if (result === 'device_conflict' || result === 'member_conflict') {
    throw new ByokCloudError(
      'e2ee_member_key_conflict',
      result === 'device_conflict'
        ? `Device ${deviceId} registered another member key bundle.`
        : `Member ${value.member.memberId} is registered to another device.`,
    );
  }
  return { memberId: value.member.memberId };
}

/**
 * The scope key packages addressed to the device's own registered member,
 * with exactly one of `epoch` (that epoch) or `afterEpoch` (one page after
 * it, by epoch, and the scope's newest epoch or `null`).
 */
export async function readDeviceScopeKeyPackages(
  ctx: E2eeMemberContext,
  deviceId: string,
  input: { readonly scopeId: string; readonly epoch?: number; readonly afterEpoch?: number },
): Promise<{ readonly packages: readonly E2eeScopeKeyPackage[]; readonly scopeHeadEpoch?: number | null }> {
  const fields = readFields(input);
  const { afterEpoch } = fields;
  if ((fields.epoch === undefined) === (afterEpoch === undefined)) throw invalid('Exactly one of epoch and afterEpoch is required');
  if (afterEpoch !== undefined && (typeof afterEpoch !== 'number' || !Number.isSafeInteger(afterEpoch) || afterEpoch < 0)) {
    throw invalid('afterEpoch must be a nonnegative safe integer');
  }
  const query = scopeQuery(fields);
  const registration = await ctx.store.readMemberRegistration(ctx.tenant, { deviceId, now: ctx.now().toISOString() });
  if (registration === undefined) {
    throw new ByokCloudError('e2ee_member_not_registered', `Device ${deviceId} has not registered a member key bundle.`);
  }
  const recipient = registration.memberId;
  if (afterEpoch === undefined) return readScopeKeyPackages(ctx, { ...query, recipient });
  const page = await ctx.store.readOwnScopeKeyPackages(ctx.tenant, {
    scopeId: query.scopeId,
    recipient,
    afterEpoch,
    limit: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX,
  });
  return {
    packages: page.rows.map(row => storedValue(E2eeScopeKeyPackageSchema, row.package, 'scope key package')),
    scopeHeadEpoch: page.scopeHeadEpoch ?? null,
  };
}

/** The client pairing MAC relayed to the device, while its pairing window is open. */
export async function readDeviceClientPairingMac(
  ctx: E2eeMemberContext,
  deviceId: string,
): Promise<E2eeClientPairingMac | undefined> {
  const body = await ctx.store.readClientPairingMac(ctx.tenant, { deviceId, now: ctx.now().toISOString() });
  return body === undefined ? undefined : storedValue(E2eeClientPairingMacSchema, body, 'client pairing MAC');
}
