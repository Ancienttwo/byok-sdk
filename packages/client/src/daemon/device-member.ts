/**
 * Device member enrollment (#654 E2d-1; design §7.2; owner 10b, 11b, §50c).
 *
 * Pairing with a verification secret `pv` makes the device a member:
 *
 * 1. `pair(code, { verificationSecret })` pairs as before, then creates the
 *    member keys for the new enrollment, stores `pv` with its deadline and
 *    the bundle, and registers the bundle with the device pairing MAC
 *    (§7.2 step 3).
 * 2. The client checks that MAC, signs `add(device)` and relays its own MAC
 *    with the chain head (step 4).
 * 3. The started daemon polls for that MAC until the `pv` deadline, checks
 *    it, pins the client's signing key, and walks the chain from seq 1 to
 *    the `add(device)` entry that key signed (11b). It stores the anchor and
 *    the verified head, and deletes `pv` (step 5).
 *
 * Each later start re-walks the chain from seq 1 and requires the stored
 * head on the new walk (same hash at the same seq), so a Host that rewinds
 * the chain to hide a `remove` fails closed (E2d-e7).
 *
 * Without `pv` the device pairs as before and is no member. A member key
 * loss before step 5 needs a re-pair: the Host keeps the first bundle per
 * device (E2d-e8).
 */
import {
  applyMemberChainEntries,
  computeDevicePairingMac,
  createMemberKeyBundle,
  decodePairingVerificationSecret,
  memberChainEntryHash,
  parseMemberKeyBundle,
  verifyClientPairingMac,
  verifyMemberChainFromAnchor,
  type MemberChainState,
  type MemberKeyBundleV1,
  type MemberKeys,
  type UnsignedMemberChainEntryV1,
} from '@byok-sdk/core/sealed-payload';
import type { DeviceMemberRecords, DeviceMemberState, MemberChainPoint } from './device-member-custody';
import { E2eeMemberClientError, type E2eeMemberClient } from './e2ee-member-client';

/** How long `pv` lives after pairing: the pairing code TTL (10b). */
export const PAIRING_VERIFICATION_TTL_MS = 10 * 60_000;

/** The MAC poll and registration retry backoff, from 2 s to 15 s (E2d-e1). */
export const MEMBER_POLL_MIN_DELAY_MS = 2_000;
export const MEMBER_POLL_MAX_DELAY_MS = 15_000;

/** A verified member of the tenant's chain, held in memory for one daemon run. */
export interface DeviceMemberSession {
  readonly keys: MemberKeys;
  /** This device's own bundle, as registered. */
  readonly member: MemberKeyBundleV1;
  /** The pinned approver key and its `add(device)` entry, as stored. */
  readonly anchor: NonNullable<DeviceMemberState['anchor']>;
  readonly state: MemberChainState;
  /** `hashes[seq - 1]` is the entry hash of chain entry `seq`. */
  readonly hashes: readonly string[];
}

export interface DeviceMemberLog {
  (message: string): void;
}

export interface DeviceMemberEnrollmentOptions {
  readonly records: DeviceMemberRecords;
  readonly client: E2eeMemberClient;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly log: DeviceMemberLog;
  readonly now?: () => number;
}

/** Decode `pv` before any network call, so a mistyped secret spends no pairing code. */
export function checkVerificationSecret(text: unknown): string {
  if (typeof text !== 'string') throw new TypeError('verificationSecret must be the base32 pairing verification secret');
  decodePairingVerificationSecret(text).fill(0);
  return text;
}

async function deviceMac(pv: string, tenantId: string, deviceId: string, member: MemberKeyBundleV1): Promise<string> {
  const secret = decodePairingVerificationSecret(pv);
  try {
    return await computeDevicePairingMac(secret, { tenantId, deviceId, member });
  } finally {
    secret.fill(0);
  }
}

/**
 * Pairing step 3 for a new enrollment. The bundle and `pv` are stored before
 * the registration, so a lost response or a short-lived `pair` process is
 * retried at start with the same bundle. A failed registration is logged,
 * not thrown: the device is paired, and the daemon retries until the
 * deadline.
 */
export async function enrollDeviceMember(options: DeviceMemberEnrollmentOptions & { readonly verificationSecret: string }): Promise<void> {
  const { records, client, tenantId, deviceId, verificationSecret, log } = options;
  const now = options.now ?? Date.now;
  const keys = await records.keys.loadOrCreate({ tenantId, deviceId });
  const member = await createMemberKeyBundle({
    signingPublicJwk: keys.signing.publicJwk,
    signingPrivateKey: keys.signing.privateKey,
    kemPublicJwk: keys.kem.publicJwk,
    kemEpoch: keys.kem.epoch,
    deviceId,
  });
  await records.savePending({ tenantId, deviceId, pv: verificationSecret, deadline: now() + PAIRING_VERIFICATION_TTL_MS });
  await records.saveState({ tenantId, deviceId, member });
  try {
    await client.register(member, await deviceMac(verificationSecret, tenantId, deviceId, member));
  } catch (error) {
    log(`E2EE member registration failed; the daemon retries it until the pairing verification deadline: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePublicKey(left: { readonly x: string; readonly y: string }, right: { readonly x: string; readonly y: string }): boolean {
  return left.x === right.x && left.y === right.y;
}

function samePoint(left: MemberChainPoint | null | undefined, right: MemberChainPoint | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left.seq === right.seq && left.hash === right.hash;
}

export async function entryHashes(entries: readonly unknown[]): Promise<string[]> {
  // Only called on entries the walk verified, so each one parses.
  return Promise.all(entries.map((entry) => {
    const { sig: _sig, ...unsigned } = entry as UnsignedMemberChainEntryV1 & { sig: string };
    return memberChainEntryHash(unsigned);
  }));
}

/** Waits `ms` or until `signal` aborts; `false` when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ResumeDeviceMemberOptions extends DeviceMemberEnrollmentOptions {
  /** Aborted at shutdown and at a new enrollment: the hard stop besides the deadline. */
  readonly signal: AbortSignal;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** A 4xx other than 429 is the Host's answer, not a transport failure. */
function isFinal(error: unknown): boolean {
  return error instanceof E2eeMemberClientError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429;
}

/**
 * Call `attempt` with backoff until it gives a value. `undefined` at abort or
 * at `deadline`. A transport failure is retried; a final one throws.
 */
async function poll<T>(options: ResumeDeviceMemberOptions, deadline: number, attempt: () => Promise<T | undefined>): Promise<T | undefined> {
  const now = options.now ?? Date.now;
  let delay = options.minDelayMs ?? MEMBER_POLL_MIN_DELAY_MS;
  for (;;) {
    if (options.signal.aborted || now() >= deadline) return undefined;
    try {
      const value = await attempt();
      if (value !== undefined) return value;
    } catch (error) {
      if (options.signal.aborted) return undefined;
      if (isFinal(error)) throw error;
      options.log(`E2EE member request failed; retrying: ${describe(error)}`);
    }
    if (!(await sleep(Math.min(delay, Math.max(0, deadline - now())), options.signal))) return undefined;
    delay = Math.min(delay * 2, options.maxDelayMs ?? MEMBER_POLL_MAX_DELAY_MS);
  }
}

/**
 * The member session of this enrollment, or `undefined` when the device is
 * no member: never E2EE-paired, `pv` expired before step 5, a failed check,
 * or removed from the chain. Every failure is fail closed and logged.
 */
export async function resumeDeviceMember(options: ResumeDeviceMemberOptions): Promise<DeviceMemberSession | undefined> {
  const { records, tenantId, deviceId, log } = options;
  const state = await records.readState();
  if (state === undefined || state.tenantId !== tenantId || state.deviceId !== deviceId) return undefined;
  const keys = await records.keys.load({ tenantId, deviceId });
  if (keys === undefined || !samePublicKey(keys.signing.publicJwk, state.member.signingPublicJwk) || !samePublicKey(keys.kem.publicJwk, state.member.kemPublicJwk)) {
    log('E2EE member keys are missing or do not match the registered bundle; re-pair the device to enable E2EE');
    return undefined;
  }
  return state.anchor === undefined ? completePairing(options, state, keys) : rewalk(options, state, keys);
}

const EXPIRED = 'the E2EE pairing verification secret expired before the client confirmed it; re-pair the device to enable E2EE';

async function completePairing(options: ResumeDeviceMemberOptions, state: DeviceMemberState, keys: MemberKeys): Promise<DeviceMemberSession | undefined> {
  const { records, client, tenantId, deviceId, log, signal } = options;
  const now = options.now ?? Date.now;
  const pending = await records.readPending();
  if (pending === undefined || pending.tenantId !== tenantId || pending.deviceId !== deviceId) return undefined;
  const { member } = state;
  const { pv, deadline } = pending;
  const giveUp = async (message: string): Promise<undefined> => {
    await records.deletePending();
    log(message);
    return undefined;
  };
  try {
    const registered = await poll(options, deadline, async () => {
      await client.register(member, await deviceMac(pv, tenantId, deviceId, member));
      return true;
    });
    const relayed = registered && await poll(options, deadline, async () => checkRelay(await client.readPairingMac(), pv, log));
    const entries = relayed && await poll(options, deadline, () => client.readChainFrom(0));
    if (!relayed || !entries) return signal.aborted ? undefined : giveUp(EXPIRED);
    const anchor = { approverSigningPublicJwk: relayed.client.signingPublicJwk, entry: relayed.chainHead };
    const anchored = await verifyMemberChainFromAnchor({
      tenantId, entries, self: member, approverSigningPublicJwk: relayed.client.signingPublicJwk, authenticatedHead: relayed.chainHead,
    });
    if (!anchored.ok) return giveUp(`the member chain does not hold the add(device) entry the client confirmed (${anchored.reason}); re-pair the device to enable E2EE`);
    await records.saveState({ tenantId, deviceId, member, anchor, head: anchored.state.head! });
    await records.deletePending();
    return session(keys, member, anchor, anchored.state, await entryHashes(entries), log);
  } catch (error) {
    return now() >= deadline ? giveUp(EXPIRED) : giveUp(`E2EE member pairing failed; re-pair the device to enable E2EE: ${describe(error)}`);
  }
}

/**
 * A relayed client MAC that verifies under `pv` (§7.2 step 5), or
 * `undefined`. The Host can replace a relay, so a bad one only waits for the
 * next until the deadline.
 */
async function checkRelay(relayed: unknown, pv: string, log: DeviceMemberLog): Promise<{ client: MemberKeyBundleV1; chainHead: MemberChainPoint } | undefined> {
  if (relayed === undefined) return undefined;
  const { mac, member, chainHead } = relayed as { mac?: unknown; member?: unknown; chainHead?: MemberChainPoint };
  const client = await parseMemberKeyBundle(member);
  const secret = decodePairingVerificationSecret(pv);
  try {
    if (client !== undefined && client.deviceId === undefined && chainHead !== undefined
      && await verifyClientPairingMac(secret, { member: client, chainHead }, mac)) {
      return { client, chainHead: { seq: chainHead.seq, hash: chainHead.hash } };
    }
  } finally {
    secret.fill(0);
  }
  log('the relayed client pairing MAC does not verify; waiting for a valid one until the deadline');
  return undefined;
}

/**
 * A restart: walk the chain again from seq 1 (11b). The stored head must be
 * on the new walk, as the anchor entry at its seq; then the later entries
 * apply forward, and the new head is stored.
 */
async function rewalk(options: ResumeDeviceMemberOptions, state: DeviceMemberState, keys: MemberKeys): Promise<DeviceMemberSession | undefined> {
  const { records, client, tenantId, deviceId, log } = options;
  const { member, anchor, head } = state as Required<DeviceMemberState>;
  const entries = await poll(options, Number.POSITIVE_INFINITY, () => client.readChainFrom(0));
  if (entries === undefined) return undefined;
  if (entries.length < head.seq) {
    log(`the member chain is shorter than the verified head seq ${head.seq}; E2EE stays off`);
    return undefined;
  }
  const prefix = await verifyMemberChainFromAnchor({
    tenantId, entries: entries.slice(0, head.seq), self: member, approverSigningPublicJwk: anchor.approverSigningPublicJwk,
  });
  if (!prefix.ok || prefix.anchorSeq !== anchor.entry.seq || !samePoint(prefix.state.head, head)) {
    log(`the member chain does not extend the verified head at seq ${head.seq} (${prefix.ok ? 'another history' : prefix.reason}); E2EE stays off`);
    return undefined;
  }
  const applied = await applyMemberChainEntries(prefix.state, entries.slice(head.seq));
  if (!applied.ok) {
    log(`a member chain entry after seq ${head.seq} is invalid (${applied.reason}); E2EE stays off`);
    return undefined;
  }
  if (!samePoint(applied.state.head, head)) {
    await records.saveState({ tenantId, deviceId, member, anchor, head: applied.state.head! });
  }
  return session(keys, member, anchor, applied.state, await entryHashes(entries), log);
}

function session(
  keys: MemberKeys,
  member: MemberKeyBundleV1,
  anchor: DeviceMemberSession['anchor'],
  state: MemberChainState,
  hashes: string[],
  log: DeviceMemberLog,
): DeviceMemberSession | undefined {
  if (!state.members.has(member.memberId)) {
    log('this device is no longer a current member of the chain; E2EE stays off');
    return undefined;
  }
  return { keys, member, anchor, state, hashes };
}
