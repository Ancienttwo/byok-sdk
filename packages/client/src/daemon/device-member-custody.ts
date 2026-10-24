/**
 * Device member custody (#654 E2d-1; design §7.1, §7.2; owner 10b, §50a D).
 *
 * The device member's secrets live next to the device identity, in three
 * entries of the same OS credential provider:
 *
 * - `device-member-p256-v1`: the member key record (core
 *   `generateMemberKeyRecord`), with both private keys.
 * - `device-member-pairing-v1`: the pairing verification secret `pv` and its
 *   deadline, bound to `{tenantId, deviceId}` (10b). It is deleted when
 *   pairing step 5 completes, a new enrollment begins, or the deadline passes.
 * - `device-member-state-v1`: the registered bundle, and after step 5 the
 *   pinned approver key, the anchor entry and the verified chain head.
 *
 * Each entry holds one value, so each read is one coherent snapshot. The
 * store expects one writer: the daemon owner lease serializes pairing and
 * start. A malformed entry fails closed and is never regenerated, because a
 * new signing key would silently be a new member; the recovery is a re-pair
 * (E2d-e8).
 */
import {
  beginMemberKemRotation,
  decodePairingVerificationSecret,
  deriveMemberId,
  finishMemberKemRotation,
  generateMemberKeyRecord,
  openMemberKeyRecord,
  parseMemberKeyBundle,
  type MemberKeyBinding,
  type MemberKeyBundleV1,
  type MemberKeyStore,
  type MemberKeys,
} from '@byok-sdk/core/sealed-payload';
import { DeviceCredentialStoreError, OS_CREDENTIAL_ENTRY_MAX_BYTES, OsCredentialEntry, type OsCredentialEntryOptions } from './device-credential-store';

export type DeviceMemberEntry = 'member-keys' | 'pairing-verification' | 'member-state';

/** Raw custody of the three member entries. An injected implementation owns their storage. */
export interface DeviceMemberCustodyBackend {
  read(entry: DeviceMemberEntry): Promise<string | undefined>;
  replace(entry: DeviceMemberEntry, value: string): Promise<void>;
  delete(entry: DeviceMemberEntry): Promise<void>;
}

/** A member entry that cannot be used. The message names the entry, never its content. */
export class DeviceMemberCustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceMemberCustodyError';
  }
}

const ENTRIES: Readonly<Record<DeviceMemberEntry, { readonly account: string; readonly label: string; readonly prefix: string }>> = {
  'member-keys': { account: 'device-member-p256-v1', label: 'BYOK device member keys', prefix: 'byok-device-member-keys-v1:' },
  'pairing-verification': { account: 'device-member-pairing-v1', label: 'BYOK device pairing verification', prefix: 'byok-device-member-pairing-v1:' },
  'member-state': { account: 'device-member-state-v1', label: 'BYOK device member state', prefix: 'byok-device-member-state-v1:' },
};

/** The OS backend: one {@link OsCredentialEntry} per member entry, each value prefixed and base64 encoded. */
export class OsDeviceMemberCustody implements DeviceMemberCustodyBackend {
  readonly #entries: Readonly<Record<DeviceMemberEntry, OsCredentialEntry>>;

  constructor(options: OsCredentialEntryOptions) {
    const entry = (name: DeviceMemberEntry): OsCredentialEntry => new OsCredentialEntry({
      ...options, account: ENTRIES[name].account, label: ENTRIES[name].label, subject: ENTRIES[name].label,
    });
    this.#entries = { 'member-keys': entry('member-keys'), 'pairing-verification': entry('pairing-verification'), 'member-state': entry('member-state') };
  }

  async read(name: DeviceMemberEntry): Promise<string | undefined> {
    const stored = await this.#entries[name].read();
    if (stored === undefined) return undefined;
    const { prefix } = ENTRIES[name];
    const encoded = stored.startsWith(prefix) ? stored.slice(prefix.length) : '';
    const bytes = Buffer.from(encoded, 'base64');
    if (encoded.length === 0 || bytes.toString('base64') !== encoded) {
      throw new DeviceMemberCustodyError(`the OS entry ${ENTRIES[name].account} is not owned by this client`);
    }
    return bytes.toString('utf8');
  }

  async replace(name: DeviceMemberEntry, value: string): Promise<void> {
    const encoded = `${ENTRIES[name].prefix}${Buffer.from(value, 'utf8').toString('base64')}`;
    if (Buffer.byteLength(encoded, 'utf8') > OS_CREDENTIAL_ENTRY_MAX_BYTES) {
      throw new DeviceCredentialStoreError(`${ENTRIES[name].label} exceed the OS credential entry bound`);
    }
    await this.#entries[name].replace(encoded);
  }

  async delete(name: DeviceMemberEntry): Promise<void> {
    await this.#entries[name].delete();
  }
}

function sameBinding(left: MemberKeyBinding, right: MemberKeyBinding): boolean {
  return left.tenantId === right.tenantId && left.deviceId === right.deviceId;
}

/**
 * The device's {@link MemberKeyStore}: the member key record in the
 * `member-keys` entry. Keys of another binding are not this enrollment's, so
 * `load` returns nothing for them and `loadOrCreate` replaces them. The KEM
 * rotation (E2d-5) keeps the next key in the same record, so each read is
 * still one snapshot of every key.
 */
export class DeviceMemberKeyStore implements MemberKeyStore {
  constructor(private readonly custody: DeviceMemberCustodyBackend) {}

  async load(binding: MemberKeyBinding): Promise<MemberKeys | undefined> {
    const text = await this.custody.read('member-keys');
    if (text === undefined) return undefined;
    const keys = await openMemberKeyRecord(text);
    if (keys === undefined) {
      throw new DeviceMemberCustodyError('the stored device member keys are malformed; they are never replaced automatically, re-pair the device');
    }
    return sameBinding(keys.binding, binding) ? keys : undefined;
  }

  async loadOrCreate(binding: MemberKeyBinding): Promise<MemberKeys> {
    const stored = await this.load(binding);
    if (stored !== undefined) return stored;
    await this.custody.replace('member-keys', await generateMemberKeyRecord(binding));
    // Read back: the stored keys, not the ones generated here, are the member.
    const created = await this.load(binding);
    if (created === undefined) throw new DeviceMemberCustodyError('the device member keys were not stored');
    return created;
  }

  /** Store a next KEM key beside the current one, or return the rotation that has begun. */
  async beginKemRotation(binding: MemberKeyBinding): Promise<MemberKeys> {
    return this.#rewrite(binding, (text) => beginMemberKemRotation(text), 'begin a KEM rotation');
  }

  /**
   * Make the next KEM key current and drop the old private key. A repeat
   * after the rotation finished returns the keys. Any other epoch throws and
   * changes nothing.
   */
  async finishKemRotation(binding: MemberKeyBinding, epoch: number): Promise<MemberKeys> {
    return this.#rewrite(binding, async (text) => finishMemberKemRotation(text, epoch), `finish a KEM rotation to epoch ${epoch}`);
  }

  async #rewrite(binding: MemberKeyBinding, change: (text: string) => Promise<string | undefined>, what: string): Promise<MemberKeys> {
    if ((await this.load(binding)) === undefined) throw new DeviceMemberCustodyError(`no device member keys of this enrollment to ${what}`);
    const text = (await this.custody.read('member-keys'))!;
    const next = await change(text);
    if (next === undefined) throw new DeviceMemberCustodyError(`the device member keys cannot ${what}`);
    if (next !== text) await this.custody.replace('member-keys', next);
    // Read back: the stored keys, not the ones computed here, are the member.
    const stored = await this.load(binding);
    if (stored === undefined) throw new DeviceMemberCustodyError('the device member keys were not stored');
    return stored;
  }
}

/** The pairing verification secret of one enrollment (10b). */
export interface PendingPairingVerification {
  readonly tenantId: string;
  readonly deviceId: string;
  /** Base32 text, as core encodes it. */
  readonly pv: string;
  /** Epoch milliseconds after which the secret is deleted unused. */
  readonly deadline: number;
}

export interface MemberChainPoint {
  readonly seq: number;
  readonly hash: string;
}

/** What the device keeps of its member enrollment between runs. */
export interface DeviceMemberState {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The bundle the device registered, byte for byte as the approver signed it. */
  readonly member: MemberKeyBundleV1;
  /** Set together at pairing step 5. */
  readonly anchor?: {
    /** The approver's signing key, pinned by the client pairing MAC. */
    readonly approverSigningPublicJwk: MemberKeyBundleV1['signingPublicJwk'];
    /** The `add(device)` entry the approver signed. */
    readonly entry: MemberChainPoint;
  };
  /** The newest chain head this device verified. */
  readonly head?: MemberChainPoint;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isChainPoint(value: unknown): value is MemberChainPoint {
  return isRecord(value) && hasExactly(value, ['seq', 'hash'])
    && Number.isSafeInteger(value.seq) && (value.seq as number) > 0
    && typeof value.hash === 'string' && HASH_PATTERN.test(value.hash);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function parseState(text: string): Promise<DeviceMemberState | undefined> {
  const value = parseJson(text);
  if (!isRecord(value) || value.v !== 1 || !hasExactly(value, ['v', 'tenantId', 'deviceId', 'member'], ['anchor', 'head'])) return undefined;
  const { tenantId, deviceId, anchor, head } = value;
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(deviceId)) return undefined;
  const member = await parseMemberKeyBundle(value.member);
  if (member === undefined || member.deviceId !== deviceId) return undefined;
  if ((anchor === undefined) !== (head === undefined)) return undefined;
  if (anchor === undefined) return { tenantId, deviceId, member };
  if (!isRecord(anchor) || !hasExactly(anchor, ['approverSigningPublicJwk', 'entry']) || !isChainPoint(anchor.entry) || !isChainPoint(head)) return undefined;
  const approverSigningPublicJwk = anchor.approverSigningPublicJwk as MemberKeyBundleV1['signingPublicJwk'];
  try {
    await deriveMemberId(approverSigningPublicJwk);
  } catch {
    return undefined;
  }
  if (!isRecord(approverSigningPublicJwk) || !hasExactly(approverSigningPublicJwk, ['kty', 'crv', 'x', 'y'])) return undefined;
  return { tenantId, deviceId, member, anchor: { approverSigningPublicJwk, entry: anchor.entry }, head };
}

function parsePending(text: string): PendingPairingVerification | undefined {
  const value = parseJson(text);
  if (!isRecord(value) || value.v !== 1 || !hasExactly(value, ['v', 'tenantId', 'deviceId', 'pv', 'deadline'])) return undefined;
  const { tenantId, deviceId, pv, deadline } = value;
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(deviceId) || typeof pv !== 'string' || !Number.isSafeInteger(deadline)) return undefined;
  try {
    decodePairingVerificationSecret(pv).fill(0);
  } catch {
    return undefined;
  }
  return { tenantId, deviceId, pv, deadline: deadline as number };
}

/** The member state and pending pv entries, with their shape checks. */
export class DeviceMemberRecords {
  readonly keys: DeviceMemberKeyStore;

  constructor(private readonly custody: DeviceMemberCustodyBackend) {
    this.keys = new DeviceMemberKeyStore(custody);
  }

  async readState(): Promise<DeviceMemberState | undefined> {
    const text = await this.custody.read('member-state');
    if (text === undefined) return undefined;
    const state = await parseState(text);
    if (state === undefined) throw new DeviceMemberCustodyError('the stored device member state is malformed; re-pair the device');
    return state;
  }

  async saveState(state: DeviceMemberState): Promise<void> {
    await this.custody.replace('member-state', JSON.stringify({
      v: 1,
      tenantId: state.tenantId,
      deviceId: state.deviceId,
      member: state.member,
      ...(state.anchor === undefined ? {} : { anchor: state.anchor, head: state.head }),
    }));
  }

  async readPending(): Promise<PendingPairingVerification | undefined> {
    const text = await this.custody.read('pairing-verification');
    if (text === undefined) return undefined;
    const pending = parsePending(text);
    if (pending === undefined) throw new DeviceMemberCustodyError('the stored pairing verification secret is malformed; re-pair the device');
    return pending;
  }

  async savePending(pending: PendingPairingVerification): Promise<void> {
    await this.custody.replace('pairing-verification', JSON.stringify({
      v: 1, tenantId: pending.tenantId, deviceId: pending.deviceId, pv: pending.pv, deadline: pending.deadline,
    }));
  }

  async deletePending(): Promise<void> {
    await this.#delete('pairing-verification');
  }

  /** Forget the member: a new enrollment or an unpair. */
  async clear(): Promise<void> {
    await this.#delete('pairing-verification');
    await this.#delete('member-state');
    await this.#delete('member-keys');
  }

  /** Delete and read back, as the enrollment clear does: a provider that reports a deletion it did not make throws. */
  async #delete(name: DeviceMemberEntry): Promise<void> {
    await this.custody.delete(name);
    if ((await this.custody.read(name)) !== undefined) {
      throw new DeviceMemberCustodyError(`the OS credential provider reported deleting the member entry ${name}, but it remains`);
    }
  }
}
