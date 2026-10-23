/**
 * Host storage for member keys, the member chain and scope key packages
 * (#654 design §7.2–§7.4, E2c).
 *
 * The Host holds no key. It checks shapes, keeps the chain contiguous and
 * first-writer-wins per seq, fixes one `keyId` per scope epoch, and relays
 * the pairing MACs. Members verify everything else (§7.3).
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
  E2EE_SCOPE_KEY_PACKAGE_PUT_MAX,
  E2eeClientPairingMacSchema,
  E2eeMemberChainEntrySchema,
  E2eeMemberKeyBundleSchema,
  E2eeMemberKeyRegisterRequestSchema,
  E2eeScopeKeyPackageSchema,
  type E2eeClientPairingMac,
  type E2eeMemberChainEntry,
  type E2eeMemberKeyBundle,
  type E2eeScopeKeyPackage,
} from '@byok-sdk/protocol';
import type { z } from 'zod';
import { PAIRING_CODE_TTL_MS } from './auth/plane';
import type { DeviceDirectory } from './stores/ports';
import { ByokCloudError } from './errors';

/** One stored chain entry: its seq and its canonical JSON. */
export interface E2eeMemberChainRow {
  readonly seq: number;
  readonly entry: string;
}

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
  | { readonly outcome: 'gap'; readonly seq: number; readonly headSeq: number };

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

export type E2eeScopeKeyPackagePutResult =
  | { readonly outcome: 'stored'; readonly stored: number }
  /** The first package of this scope epoch fixed another `keyId`. Nothing was written. */
  | { readonly outcome: 'key_id_conflict'; readonly scopeId: string; readonly epoch: number; readonly keyId: string };

export interface E2eeMemberRegistrationInput {
  readonly deviceId: string;
  readonly memberId: string;
  /** Canonical JSON of the device's member key bundle. */
  readonly bundle: string;
  /** The device pairing MAC (§7.2 step 3). */
  readonly deviceMac: string;
  readonly macExpiresAt: string;
}

/**
 * - `registered`: the bundle and the MAC were stored.
 * - `replayed`: the same bundle was already stored; the MAC and its expiry were replaced.
 * - `device_conflict`: the device registered another bundle. Nothing changed.
 * - `member_conflict`: another device registered this member id. Nothing changed.
 */
export type E2eeMemberRegisterResult = 'registered' | 'replayed' | 'device_conflict' | 'member_conflict';

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
 */
export interface E2eeMemberStore {
  /**
   * Rows have contiguous ascending seqs. A row at a stored seq must hold the
   * same bytes (a replay). The first new row must be the stored head plus one.
   */
  appendChainEntries(tenant: TenantId, rows: readonly E2eeMemberChainRow[]): Promise<E2eeMemberChainAppendResult>;
  /** Entries with `seq > afterSeq`, ascending, at most `limit`. */
  readChainEntries(
    tenant: TenantId,
    input: { readonly afterSeq: number; readonly limit: number },
  ): Promise<readonly E2eeMemberChainRow[]>;
  /**
   * The first package of a `(scopeId, epoch)` fixes its `keyId`, also within
   * this call: a second `keyId` for that scope epoch refuses the whole put. A
   * package with that `keyId` inserts or replaces the row of its recipient.
   */
  putScopeKeyPackages(tenant: TenantId, rows: readonly E2eeScopeKeyPackageRow[]): Promise<E2eeScopeKeyPackagePutResult>;
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

/**
 * The longest scope id, in UTF-16 code units, as for other opaque Host ids.
 * Core sets no maximum, so the bound lives here, not in the protocol shape
 * the parity test compares; it keeps every backend's index key in range.
 */
const E2EE_SCOPE_ID_MAX_LENGTH = 512;

function invalid(message: string): ByokCloudError {
  return new ByokCloudError('coordination_input_invalid', message);
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
}

export async function appendMemberChainEntries(
  ctx: E2eeMemberContext,
  input: { readonly entries: readonly E2eeMemberChainEntry[] },
): Promise<{ readonly appended: number; readonly replayed: number }> {
  const list = boundedList(() => input.entries, E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES, 'Member chain entries');
  const rows = list.map((input, index) => {
    const { text, value } = canonicalParse(E2eeMemberChainEntrySchema, input, `Member chain entry ${index}`);
    if (new TextEncoder().encode(text).byteLength > E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES) {
      throw invalid(`Member chain entry ${index} exceeds ${E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES} bytes`);
    }
    if (value.tenantId !== ctx.tenant) throw invalid(`Member chain entry ${index} names another tenant`);
    return { seq: value.seq, entry: text };
  });
  if (rows.some((row, index) => row.seq !== rows[0]!.seq + index)) {
    throw invalid('Member chain entries must have contiguous ascending seqs');
  }
  const result = await ctx.store.appendChainEntries(ctx.tenant, rows);
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
  input: { readonly packages: readonly E2eeScopeKeyPackage[] },
): Promise<{ readonly stored: number }> {
  const list = boundedList(() => input.packages, E2EE_SCOPE_KEY_PACKAGE_PUT_MAX, 'Scope key packages');
  const rows = list.map((input, index) => {
    const { text, value } = canonicalParse(E2eeScopeKeyPackageSchema, input, `Scope key package ${index}`);
    if (value.tenantId !== ctx.tenant) throw invalid(`Scope key package ${index} names another tenant`);
    if (!scopeIdValid(value.scopeId)) throw invalid(`Scope key package ${index} has a scopeId over ${E2EE_SCOPE_ID_MAX_LENGTH} characters`);
    return {
      scopeId: value.scopeId,
      epoch: value.epoch,
      recipient: value.recipient,
      keyId: value.keyId,
      sender: value.sender,
      package: text,
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
  const result = await ctx.store.putScopeKeyPackages(ctx.tenant, rows);
  if (result.outcome === 'key_id_conflict') {
    throw new ByokCloudError(
      'e2ee_scope_key_conflict',
      `Scope ${result.scopeId} epoch ${result.epoch} already has keyId ${result.keyId}.`,
    );
  }
  return { stored: result.stored };
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
  deviceId: string,
  input: unknown,
): Promise<{ readonly memberId: string }> {
  const { value } = canonicalParse(E2eeMemberKeyRegisterRequestSchema, input, 'Member key registration');
  if (value.member.deviceId !== deviceId) throw invalid('The member key bundle names another device');
  const result = await ctx.store.registerMember(ctx.tenant, {
    deviceId,
    memberId: value.member.memberId,
    bundle: canonicalizeJson(value.member as unknown as JsonValue),
    deviceMac: value.mac,
    macExpiresAt: new Date(ctx.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(),
  });
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

/** The scope key packages addressed to the device's own registered member. */
export async function readDeviceScopeKeyPackages(
  ctx: E2eeMemberContext,
  deviceId: string,
  input: { readonly scopeId: string; readonly epoch?: number },
): Promise<{ readonly packages: readonly E2eeScopeKeyPackage[] }> {
  const query = scopeQuery(readFields(input));
  const registration = await ctx.store.readMemberRegistration(ctx.tenant, { deviceId, now: ctx.now().toISOString() });
  if (registration === undefined) {
    throw new ByokCloudError('e2ee_member_not_registered', `Device ${deviceId} has not registered a member key bundle.`);
  }
  return readScopeKeyPackages(ctx, { ...query, recipient: registration.memberId });
}

/** The client pairing MAC relayed to the device, while its pairing window is open. */
export async function readDeviceClientPairingMac(
  ctx: E2eeMemberContext,
  deviceId: string,
): Promise<E2eeClientPairingMac | undefined> {
  const body = await ctx.store.readClientPairingMac(ctx.tenant, { deviceId, now: ctx.now().toISOString() });
  return body === undefined ? undefined : storedValue(E2eeClientPairingMacSchema, body, 'client pairing MAC');
}
