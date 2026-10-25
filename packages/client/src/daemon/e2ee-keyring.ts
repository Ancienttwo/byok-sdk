/**
 * The verified device member of one daemon run and the scope keys it opened
 * (#654 E2d-2, E2d-3; design §7.3, §7.4, §7.9; owner §50d).
 *
 * The chain view only moves forward: `catchUp()` reads the entries after the
 * verified head, applies them to the verified state, and stores the new
 * head. An invalid entry, or a chain that no longer holds this device as a
 * current member, ends the member for this run.
 *
 * A scope is usable only while it is in the verified state and its latest
 * `scope-policy` holds this device and no other device: the other current
 * members are clients (§7.9 requirement 1). A removed member has no bundle
 * left to tell; the freshness rule covers it.
 *
 * A scope key comes from the one key package the Host holds for this
 * member at `(scope, epoch)`, sealed by a member of the scope policy. The
 * sender's signing key comes from the verified chain, never from the Host.
 * The opened keys are kept in memory only.
 *
 * Freshness (§50d, rule (ii)): opened content at epoch e with an
 * authenticated chain head h shows that an honest sender rotated past every
 * `remove` up to h. The device keeps the newest such h per (scope, e), and
 * seals at e only while no `remove` of a scope member and no member-dropping
 * `scope-policy` lies after h. A retired keyring hands its points to the
 * next run's keyring in the same process, which keeps each point that is on
 * its own verified chain and judges staleness at its own head. After a
 * process restart the points are rebuilt from opened content.
 *
 * Device rotation (E2d-4, §7.5): when no epoch is fresh, the device is the
 * next sender, so it rotates. It wraps a new scope key at the epoch after the
 * newest one it knows, or finds held in a short read above it, to every
 * current member of the scope policy, puts the packages, and only then keeps
 * the key, with the head it chose the recipients at as the epoch's freshness
 * point. Such an epoch is also stale after a member is added to the scope
 * policy or rotates its KEM key, counted from the seq it was wrapped at; a
 * carried point keeps that seq.
 *
 * KEM rotation (E2d-5, §7.5): the member stores a next KEM key beside the
 * current one, appends its `rotate` entry after a local walk (§7.9
 * requirement 2), re-wraps each of its own packages that it may use now to
 * the next key, reads them back, catches up and reads every usable scope
 * back once more, and only then drops the old private key. Until then a
 * package opens with either key, and a resumed rotation picks up where it
 * stopped.
 */
import {
  applyMemberChainEntries,
  createMemberKeyBundle,
  generateScopeKey,
  memberChainScopeRecipients,
  openScopeKeyPackage,
  sealScopeKeyPackage,
  signMemberChainEntry,
  type MemberChainEntryV1,
  type MemberChainScope,
  type MemberKemKey,
  type MemberKeyBundleV1,
  type MemberKeys,
  type ScopeKeyPackageV1,
  type ScopeKeyPackageOpenResult,
  type SealedCategory,
  type SealedContentHeaderV1,
} from '@byok-sdk/core/sealed-payload';
import type { DeviceMemberRecords, MemberChainPoint } from './device-member-custody';
import { MEMBER_REQUEST_TIMEOUT_MS, entryHashes, type DeviceMemberLog, type DeviceMemberSession } from './device-member';
import { E2EE_SCOPE_KEY_PACKAGE_PUT_MAX } from '@byok-sdk/protocol';
import { E2eeMemberClientError, type E2eeMemberClient } from './e2ee-member-client';
import type { SealedScopeKeyring, SealingKey } from './sealed-task';

/** How many rotations one seal waits for or starts before it fails closed. */
const MAX_ROTATION_ROUNDS = 3;

/**
 * The per-epoch key package reads of one rotation decision: the epochs just
 * above the newest one this run knows for the scope. Four covers the drift a
 * run can have, a missed notice or a partly put epoch, and lets a gap below a
 * held epoch pass. A package at the top epoch means the scope is further
 * ahead than the device can see, so the seal fails closed.
 */
const ROTATION_EPOCH_READS = 4;

/**
 * The epochs of one scope a KEM rotation reads in each pass, from epoch 1:
 * 64 batches of {@link ROTATION_EPOCH_READS}. A scope that needs more stops
 * the rotation, and the old key stays.
 */
const KEM_REWRAP_MAX_EPOCHS = 256;

export interface ScopeKey {
  readonly scopeKey: Uint8Array;
  readonly keyId: string;
  /** Member id of the member that sealed the package. */
  readonly sender: string;
}

type ScopeFailure = 'scope_unknown' | 'not_a_scope_member' | 'scope_shared_with_device' | 'key_package_sender_invalid';

export type ScopeKeyFetchFailure =
  | 'member_lost'
  | ScopeFailure
  | 'key_package_missing'
  | Extract<ScopeKeyPackageOpenResult, { ok: false }>['reason'];

export type ScopeKeyFetchResult =
  | { readonly ok: true; readonly key: ScopeKey }
  | { readonly ok: false; readonly reason: ScopeKeyFetchFailure };

type P256PublicJwk = MemberKeyBundleV1['signingPublicJwk'];

export type KemRotationFailure =
  | 'member_lost'
  /** The verified chain holds a KEM epoch of this member that its custody does not. */
  | 'kem_epoch_unknown'
  /** The `rotate` entry does not walk on the verified chain, or the Host did not keep it. */
  | 'rotate_entry_invalid'
  /** A scope's epochs pass {@link KEM_REWRAP_MAX_EPOCHS}, or the top epoch the rotation reads holds a package. */
  | 'scope_epochs_exceeded'
  /** The Host read no package at an epoch whose key this run holds. */
  | 'key_package_missing'
  /** A package to keep does not read back with the next key under its `keyId`, or the package of an epoch whose key this run holds does not open. */
  | 'rewrap_unverified'
  /** The verified chain moved during each try of a scope's re-wrap. */
  | 'chain_moved';

export type KemRotationResult =
  | { readonly ok: true; readonly epoch: number }
  | { readonly ok: false; readonly reason: KemRotationFailure };

/** The freshness points of a retired keyring, for the next run of the same process. Memory only. */
export interface MemberFreshness {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly memberId: string;
  readonly points: ReadonlyMap<string, ReadonlyMap<number, MemberChainPoint>>;
  /** The chain seq each scope epoch the device rotated to was wrapped at, by `keyOf`. */
  readonly rotated: ReadonlyMap<string, number>;
}

export interface DeviceMemberKeyringOptions {
  readonly records: DeviceMemberRecords;
  readonly client: E2eeMemberClient;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly log: DeviceMemberLog;
  /** Aborted at shutdown and at a new enrollment. */
  readonly signal: AbortSignal;
  /** Each Host read is cut off after this; defaults to {@link MEMBER_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
  /** Called once when this run loses the member. */
  readonly onLost?: () => void;
  /** The points the previous run of this process left; only the same member's points on this chain are kept. */
  readonly carried?: MemberFreshness;
}

/** One `scope-policy` of a scope, at its chain seq. */
interface PolicyVersion {
  readonly seq: number;
  readonly members: readonly string[];
}

function keyOf(scopeId: string, epoch: number): string {
  return `${epoch}\0${scopeId}`;
}

export class DeviceMemberKeyring implements SealedScopeKeyring {
  #session: DeviceMemberSession | undefined;
  readonly #keys = new Map<string, ScopeKey>();
  readonly #policies = new Map<string, PolicyVersion[]>();
  readonly #removals: Array<{ readonly seq: number; readonly memberId: string }> = [];
  /** The KEM key rotations of verified entries. */
  readonly #kemRotations: Array<{ readonly seq: number; readonly memberId: string }> = [];
  /** The chain seq each scope epoch this run rotated to was wrapped at, by `keyOf`. */
  readonly #rotated = new Map<string, number>();
  /**
   * Per scope, the newest epoch the Host showed taken: an epoch whose put it
   * refused as a conflict, or the top epoch of a probe that found the scope
   * further ahead. The next rotation starts above it.
   */
  readonly #taken = new Map<string, number>();
  /** The newest authenticated chain head per scope, then per epoch. */
  readonly #fresh = new Map<string, Map<number, MemberChainPoint>>();
  /** The rotation in flight per scope, so concurrent seals rotate once. */
  readonly #rotations = new Map<string, Promise<void>>();
  #kemRotation: Promise<KemRotationResult> | undefined;
  /** Aborted at retire, so no Host request of this run outlives it. */
  readonly #retired = new AbortController();
  #tail: Promise<void> = Promise.resolve();

  constructor(session: DeviceMemberSession, private readonly options: DeviceMemberKeyringOptions) {
    this.#session = session;
    this.#record(session.entries);
    this.#carry(session, options.carried);
  }

  /** The verified member, or `undefined` once this run lost it. */
  get session(): DeviceMemberSession | undefined {
    return this.#session;
  }

  /** The opened key of one scope epoch, if this run holds it and the scope and its sender are still usable. */
  cached(scopeId: string, epoch: number): ScopeKey | undefined {
    const key = this.#keys.get(keyOf(scopeId, epoch));
    return key !== undefined && this.#session !== undefined && this.#scopeFailure(this.#session, scopeId, key.sender) === undefined ? key : undefined;
  }

  /**
   * Apply the chain entries after the verified head. Calls run one at a
   * time. A transport failure throws and leaves the view as it was.
   */
  catchUp(): Promise<void> {
    const run = this.#tail.then(() => this.#advance());
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Catch up, then the key of one scope epoch: cached, or fetched and
   * opened. A failed or timed-out Host read throws, as does a final Host
   * answer (`E2eeMemberClientError.final`); every other end is a result.
   */
  fetch(scopeId: string, epoch: number): Promise<ScopeKeyFetchResult> {
    return this.#fetch(scopeId, epoch, false);
  }

  /**
   * {@link fetch}; with `copy`, the result holds a copy of the key bytes,
   * taken where the key is read, so a catch-up before the caller resumes
   * cannot zero them.
   */
  async #fetch(scopeId: string, epoch: number, copy: boolean): Promise<ScopeKeyFetchResult> {
    const own = (key: ScopeKey): ScopeKey => (copy ? { ...key, scopeKey: key.scopeKey.slice() } : key);
    await this.catchUp();
    const session = this.#session;
    if (session === undefined) return { ok: false, reason: 'member_lost' };
    const failure = this.#scopeFailure(session, scopeId);
    if (failure !== undefined) return { ok: false, reason: failure };
    const known = this.cached(scopeId, epoch);
    if (known !== undefined) return { ok: true, key: own(known) };
    const packages = await this.options.client.readKeyPackages(scopeId, epoch, this.#requestSignal());
    if (packages.length === 0) return { ok: false, reason: 'key_package_missing' };
    const pkg: unknown = packages[0];
    if (typeof pkg !== 'object' || pkg === null) return { ok: false, reason: 'key_package_invalid' };
    const senderId = (pkg as { readonly sender?: unknown }).sender;
    const sender = typeof senderId === 'string' && this.#scopeFailure(session, scopeId, senderId) === undefined ? session.state.members.get(senderId) : undefined;
    if (sender === undefined) return { ok: false, reason: 'key_package_sender_invalid' };
    const read = this.#session;
    if (read === undefined) return { ok: false, reason: 'member_lost' };
    // A package opens with any KEM key the member held while it was read.
    const kems = [...kemKeys(read.keys), ...kemKeys(session.keys)].filter((kem, index, all) => all.findIndex((other) => other.epoch === kem.epoch) === index);
    const opened = await this.#openOwn(read, scopeId, epoch, pkg, sender.signingPublicJwk, kems);
    if (!opened.ok) return opened;
    // A concurrent fetch may have settled this epoch, or a catch-up moved the view, while the package was read and opened.
    const raced = this.cached(scopeId, epoch);
    const current = this.#session;
    const lost = current === undefined ? 'member_lost' : this.#scopeFailure(current, scopeId, sender.memberId);
    if (raced !== undefined || lost !== undefined) {
      opened.scopeKey.fill(0);
      return raced !== undefined ? { ok: true, key: own(raced) } : { ok: false, reason: lost! };
    }
    const key = { scopeKey: opened.scopeKey, keyId: opened.keyId, sender: sender.memberId };
    this.#keys.set(keyOf(scopeId, epoch), key);
    return { ok: true, key: own(key) };
  }

  /** The latest policy categories of a usable scope, after a catch-up; `undefined` when it is not usable. */
  async scopeCategories(scopeId: string): Promise<readonly SealedCategory[] | undefined> {
    await this.catchUp();
    const session = this.#session;
    if (session === undefined || this.#scope(session, scopeId) === undefined) return undefined;
    return session.state.scopes.get(scopeId)!.categories;
  }

  /**
   * A copy of the cached key, or else of a key fetched on the miss
   * (E2d-e3). A catch-up zeroes the cached bytes, so an open or seal in
   * flight keeps its own.
   */
  async openingKey(scope: { readonly id: string; readonly epoch: number }): Promise<Uint8Array | undefined> {
    const known = this.cached(scope.id, scope.epoch);
    if (known !== undefined) return known.scopeKey.slice();
    const result = await this.#fetch(scope.id, scope.epoch, true);
    if (result.ok) return result.key.scopeKey;
    this.options.log(`no scope key for epoch ${scope.epoch} of scope ${JSON.stringify(scope.id)} (${result.reason})`);
    return undefined;
  }

  /**
   * The sender-view check of opened content (§7.3): its chain head must be
   * on the verified chain (caught up when it is ahead), and its sender a
   * current member in the scope's policy at that head. Accepted content
   * records its head as the freshness point of its scope epoch.
   */
  async acceptHeader(header: SealedContentHeaderV1): Promise<boolean> {
    const { scope, chainHead, sender } = header;
    if (this.#session !== undefined && chainHead.seq > this.#session.state.head!.seq) await this.catchUp();
    const session = this.#session;
    const refusal = session === undefined ? 'the member is lost'
      : session.hashes[chainHead.seq - 1] !== chainHead.hash ? 'its chain head is not on the verified chain'
      : !session.state.members.has(sender) ? 'its sender is no current member'
      : this.#policyAt(scope.id, chainHead.seq)?.members.includes(sender) !== true ? 'its sender is not in the scope policy at its chain head'
      : undefined;
    if (refusal !== undefined) {
      this.options.log(`sealed content at epoch ${scope.epoch} of scope ${JSON.stringify(scope.id)} refused: ${refusal}`);
      return false;
    }
    const points = this.#fresh.get(scope.id) ?? new Map<number, MemberChainPoint>();
    this.#fresh.set(scope.id, points);
    if ((points.get(scope.epoch)?.seq ?? 0) < chainHead.seq) points.set(scope.epoch, { seq: chainHead.seq, hash: chainHead.hash });
    return true;
  }

  /**
   * The newest epoch at `minEpoch` or later with a freshness point and no
   * `remove` of a scope member, or member-dropping `scope-policy`, after it
   * (§50d). With none, the device rotates first (E2d-4). Its header names
   * this member and the verified head.
   */
  async sealingKey(scopeId: string, minEpoch: number): Promise<SealingKey | undefined> {
    const session = this.#session;
    if (session === undefined || this.#scope(session, scopeId) === undefined) return undefined;
    const fresh = this.#freshEpoch(scopeId, minEpoch, session.state.head!.seq);
    if (fresh !== undefined) return this.#sealingAt(scopeId, fresh);
    // A shared rotation may target an epoch below this call's `minEpoch`, so
    // a call that only joined one checks again and may rotate itself.
    for (let round = 0; round < MAX_ROTATION_ROUNDS; round += 1) {
      let rotation = this.#rotations.get(scopeId);
      const joined = rotation !== undefined;
      if (rotation === undefined) {
        rotation = this.#rotate(scopeId, minEpoch).finally(() => this.#rotations.delete(scopeId));
        this.#rotations.set(scopeId, rotation);
      }
      await rotation;
      const current = this.#session;
      if (current === undefined || this.#scope(current, scopeId) === undefined) return undefined;
      const rotated = this.#freshEpoch(scopeId, minEpoch, current.state.head!.seq);
      if (rotated !== undefined) return this.#sealingAt(scopeId, rotated);
      if (!joined) break;
    }
    this.options.log(`no fresh epoch at or after ${minEpoch} for scope ${JSON.stringify(scopeId)}; output is not sealed`);
    return undefined;
  }

  #freshEpoch(scopeId: string, minEpoch: number, headSeq: number): number | undefined {
    const epochs = [...(this.#fresh.get(scopeId) ?? new Map<number, MemberChainPoint>())]
      .filter(([epoch, point]) => epoch >= minEpoch && !this.#stale(scopeId, epoch, point.seq, headSeq))
      .map(([epoch]) => epoch);
    return epochs.length === 0 ? undefined : Math.max(...epochs);
  }

  async #sealingAt(scopeId: string, epoch: number): Promise<SealingKey | undefined> {
    const key = await this.openingKey({ id: scopeId, epoch });
    if (key === undefined) return undefined;
    // The key read can catch up: the scope and the epoch must still hold at the head it left.
    const current = this.#session;
    const point = this.#fresh.get(scopeId)?.get(epoch);
    if (current === undefined || point === undefined || this.#scope(current, scopeId) === undefined || this.#stale(scopeId, epoch, point.seq, current.state.head!.seq)) {
      key.fill(0);
      return undefined;
    }
    const now = current.state.head!;
    return { scopeKey: key, epoch, sender: current.member.memberId, chainHead: { seq: now.seq, hash: now.hash } };
  }

  /**
   * Catch up, then wrap a new scope key at the next epoch (`#nextEpoch`) to
   * every current member of the scope policy, and put the packages. A Host
   * that holds that epoch under another key refuses the put, and the seal
   * fails closed. So does a scope further ahead than the device checks, and
   * a policy that leaves no current member but this one, whose output no
   * client could open. A failed or timed-out Host request throws.
   */
  async #rotate(scopeId: string, minEpoch: number): Promise<void> {
    await this.catchUp();
    const session = this.#session;
    if (session === undefined || this.#scope(session, scopeId) === undefined) return;
    const head = session.state.head!;
    if (this.#freshEpoch(scopeId, minEpoch, head.seq) !== undefined) return;
    const self = session.member.memberId;
    // This member's own package goes in the first put: after any put that landed, the next rotation sees the epoch and moves past it.
    const recipients = [...memberChainScopeRecipients(session.state, scopeId)].sort((left, right) => Number(right.memberId === self) - Number(left.memberId === self));
    if (recipients.every((recipient) => recipient.memberId === self)) {
      this.options.log(`scope ${JSON.stringify(scopeId)} has no current member but this device; it is not rotated`);
      return;
    }
    const epoch = await this.#nextEpoch(scopeId, minEpoch);
    if (epoch === undefined) return;
    const sender = { signingPublicJwk: session.keys.signing.publicJwk, signingPrivateKey: session.keys.signing.privateKey };
    const scopeKey = generateScopeKey();
    try {
      const packages = await Promise.all(recipients.map((recipient) => sealScopeKeyPackage({
        scopeKey, tenantId: this.options.tenantId, scopeId, epoch,
        recipient: { memberId: recipient.memberId, kemPublicJwk: recipient.kemPublicJwk }, sender,
      })));
      // The Host takes at most this many per put; the epoch is fresh only after every put.
      for (let at = 0; at < packages.length; at += E2EE_SCOPE_KEY_PACKAGE_PUT_MAX) {
        await this.options.client.putKeyPackages(packages.slice(at, at + E2EE_SCOPE_KEY_PACKAGE_PUT_MAX), this.#requestSignal());
      }
      const current = this.#session;
      if (current === undefined || this.#scopeFailure(current, scopeId) !== undefined) {
        scopeKey.fill(0);
        return;
      }
      // The notice of this device's own package may have cached this epoch's key during the puts.
      this.#drop(keyOf(scopeId, epoch));
      this.#keys.set(keyOf(scopeId, epoch), { scopeKey, keyId: packages[0]!.keyId, sender: self });
      this.#rotated.set(keyOf(scopeId, epoch), head.seq);
      const points = this.#fresh.get(scopeId) ?? new Map<number, MemberChainPoint>();
      this.#fresh.set(scopeId, points);
      points.set(epoch, { seq: head.seq, hash: head.hash });
      this.options.log(`rotated scope ${JSON.stringify(scopeId)} to epoch ${epoch} for ${recipients.length} members`);
    } catch (error) {
      scopeKey.fill(0);
      // Zero a key the notice cached for the abandoned epoch. A notice may cache it again; no seal uses it without a freshness point.
      this.#drop(keyOf(scopeId, epoch));
      if (!(error instanceof E2eeMemberClientError && error.code === 'e2ee_scope_key_conflict')) throw error;
      // Another client may hold the epoch without a package for this member, so a read would show it free again.
      this.#take(scopeId, epoch);
      this.options.log(`the Host holds epoch ${epoch} of scope ${JSON.stringify(scopeId)} under another key; output is not sealed`);
    }
  }

  /**
   * The epoch to rotate to: above the newest epoch this run knows for the
   * scope and above every epoch the Host holds for this member in the next
   * {@link ROTATION_EPOCH_READS}. An empty read means only that the Host
   * holds no package of that epoch for this member; the put decides whether
   * the epoch is free. `undefined` when the scope is further ahead.
   */
  async #nextEpoch(scopeId: string, minEpoch: number): Promise<number | undefined> {
    const known = Math.max(minEpoch, ...this.#knownEpochs(scopeId));
    const epochs = Array.from({ length: ROTATION_EPOCH_READS }, (_, index) => known + 1 + index);
    if (!Number.isSafeInteger(epochs.at(-1))) {
      this.options.log(`scope ${JSON.stringify(scopeId)} has no epoch left to rotate to; output is not sealed`);
      return undefined;
    }
    const held = await Promise.all(epochs.map(async (epoch) => (await this.options.client.readKeyPackages(scopeId, epoch, this.#requestSignal())).length > 0));
    const top = held.lastIndexOf(true);
    if (top === epochs.length - 1) {
      this.#take(scopeId, epochs[top]!);
      this.options.log(`the Host holds epoch ${epochs[top]} of scope ${JSON.stringify(scopeId)}, beyond the epochs this device checks; output is not sealed`);
      return undefined;
    }
    return epochs[top + 1];
  }

  /** The epochs of a scope this run holds a key of, a freshness point for, or found taken. */
  #knownEpochs(scopeId: string): number[] {
    return [...scopeEpochs(this.#keys.keys(), scopeId), ...(this.#fresh.get(scopeId)?.keys() ?? []), this.#taken.get(scopeId) ?? 0];
  }

  /**
   * The epochs of a scope whose package this member holds from a sender
   * `fetch` accepts: the keys this run opened, which a catch-up drops with
   * their sender, and the epochs it rotated to with its own package.
   */
  #heldEpochs(scopeId: string): Set<number> {
    return new Set([...scopeEpochs(this.#keys.keys(), scopeId), ...scopeEpochs(this.#rotated.keys(), scopeId)]);
  }

  /** Zero and remove the cached key at `at`, if any. */
  #drop(at: string): void {
    this.#keys.get(at)?.scopeKey.fill(0);
    this.#keys.delete(at);
  }

  #take(scopeId: string, epoch: number): void {
    this.#taken.set(scopeId, Math.max(this.#taken.get(scopeId) ?? 0, epoch));
  }

  /**
   * Rotate this member's KEM key (§7.5). Calls share one rotation. A
   * transport failure throws and leaves the rotation to resume: the next key
   * stays in custody beside the old one, so every package still opens.
   */
  rotateKem(): Promise<KemRotationResult> {
    this.#kemRotation ??= this.#rotateKem().finally(() => {
      this.#kemRotation = undefined;
    });
    return this.#kemRotation;
  }

  async #rotateKem(): Promise<KemRotationResult> {
    const { records, tenantId, deviceId, log } = this.options;
    await this.catchUp();
    if (this.#session === undefined) return { ok: false, reason: 'member_lost' };
    const keys = await records.keys.beginKemRotation({ tenantId, deviceId });
    const next = keys.nextKem!;
    await this.#useKeys(keys);
    // A run retired after its last read-back leaves the old key for the next run's resumed rotation.
    const failure = await this.#registerKem(next) ?? await this.#rewrap(next) ?? (this.#session === undefined ? 'member_lost' : undefined);
    if (failure !== undefined) {
      log(`the KEM rotation to epoch ${next.epoch} stopped (${failure}); the old key stays`);
      return { ok: false, reason: failure };
    }
    await this.#useKeys(await records.keys.finishKemRotation({ tenantId, deviceId }, next.epoch));
    log(`rotated the member KEM key to epoch ${next.epoch}`);
    return { ok: true, epoch: next.epoch };
  }

  /** Swap the session's keys in the catch-up queue, so a catch-up in flight does not put the old ones back. */
  #useKeys(keys: MemberKeys): Promise<void> {
    const run = this.#tail.then(() => {
      if (this.#session !== undefined) this.#session = { ...this.#session, keys };
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Append the `rotate` entry of `next`, unless the verified chain has it. One seq conflict is retried after a catch-up. */
  async #registerKem(next: MemberKemKey): Promise<KemRotationFailure | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      const session = this.#session;
      if (session === undefined) return 'member_lost';
      const self = session.member.memberId;
      const current = session.state.members.get(self)!;
      if (current.kemEpoch === next.epoch && sameJwk(current.kemPublicJwk, next.publicJwk)) return undefined;
      if (current.kemEpoch !== next.epoch - 1) return 'kem_epoch_unknown';
      if (attempt === 2) return 'rotate_entry_invalid';
      const { signing } = session.keys;
      const { kemSig } = await createMemberKeyBundle({
        signingPublicJwk: signing.publicJwk, signingPrivateKey: signing.privateKey, kemPublicJwk: next.publicJwk, kemEpoch: next.epoch,
        ...(current.deviceId === undefined ? {} : { deviceId: current.deviceId }),
      });
      const head = session.state.head!;
      const entry = await signMemberChainEntry({
        v: 1, tenantId: this.options.tenantId, seq: head.seq + 1, prev: head.hash, op: 'rotate', signer: self,
        subject: { memberId: self, kemPublicJwk: next.publicJwk, kemEpoch: next.epoch, kemSig },
      }, signing);
      if (!(await applyMemberChainEntries(session.state, [entry])).ok) return 'rotate_entry_invalid';
      try {
        await this.options.client.appendChain([entry], this.#requestSignal());
      } catch (error) {
        if (!(error instanceof E2eeMemberClientError && error.code === 'e2ee_member_chain_conflict')) throw error;
      }
      await this.catchUp();
    }
  }

  /**
   * Re-wrap to `next` each own package that `fetch` accepts now: of a usable
   * scope, from a current member of its policy. The re-wrap names this
   * member as the sender, so a package from any other sender, such as a
   * removed member, is left as it is and never gains this member's
   * signature. Then read them back, and once every scope is done, read back
   * every scope usable at the caught-up head.
   */
  async #rewrap(next: MemberKemKey): Promise<KemRotationFailure | undefined> {
    // An epoch rotation that read the scope members before the `rotate` may still wrap to the old key: let it land first.
    await Promise.allSettled([...this.#rotations.values()]);
    const session = this.#session;
    if (session === undefined) return 'member_lost';
    const confirmed = new Map<string, ReadonlyMap<number, string>>();
    for (const scopeId of session.state.scopes.keys()) {
      const result = await this.#rewrapScope(scopeId, next);
      if (typeof result === 'string') return result;
      confirmed.set(scopeId, result);
    }
    // A package wrapped to the old key can land after its scope's read-back:
    // a late or retried put, or a new epoch from a client that has not seen
    // the `rotate`. A scope can also become usable, or be created, during the
    // run. So every scope usable at the caught-up head is read back once
    // more. This interim pass narrows the window but does not close it: a put
    // can still land between it and the custody write. The fix is the
    // recipient `kemEpoch` in the signed package and the Host row, with the
    // Host refusing an older one; it must land before a production path
    // starts a rotation (E5b-2).
    await this.catchUp();
    for (const scopeId of this.#session?.state.scopes.keys() ?? []) {
      const view = this.#session;
      if (view === undefined) return 'member_lost';
      if (this.#scopeFailure(view, scopeId) !== undefined) continue;
      const failure = await this.#readBack(view, scopeId, confirmed.get(scopeId) ?? new Map(), next, view.keys.kem, this.#heldEpochs(scopeId), [...this.#fresh.get(scopeId)?.keys() ?? []]);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  /**
   * One scope's re-wrap; the result maps each epoch to re-wrap or that opens
   * with `next` to its `keyId`, empty for a scope the member may not use. Its
   * senders are checked against the verified view of one try; when a
   * catch-up moves the view during the try, it starts again, at most three
   * times. Every package found that `fetch` accepts, and every epoch this
   * run holds a key of, must then read back and open with `next` under its
   * `keyId`, every epoch with a freshness point must hold a package, and no
   * package `fetch` accepts may still open only with the old key.
   */
  async #rewrapScope(scopeId: string, next: MemberKemKey): Promise<KemRotationFailure | ReadonlyMap<number, string>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = this.#session;
      if (view === undefined) return 'member_lost';
      if (this.#scopeFailure(view, scopeId) !== undefined) return new Map();
      // Taken with the view: a catch-up drops the keys of a sender it drops in the same step.
      const held = this.#heldEpochs(scopeId);
      const fresh = [...(this.#fresh.get(scopeId)?.keys() ?? [])];
      const { kem: old, signing } = view.keys;
      const found = await this.#readEpochs(scopeId);
      if (found === undefined) return 'scope_epochs_exceeded';
      const expected = new Map<number, string>();
      const rewrapped: ScopeKeyPackageV1[] = [];
      for (const [epoch, pkg] of found) {
        const current = await this.#openAccepted(view, scopeId, epoch, pkg, next);
        current?.scopeKey.fill(0);
        if (current !== undefined) {
          expected.set(epoch, current.keyId);
          continue;
        }
        const opened = await this.#openAccepted(view, scopeId, epoch, pkg, old);
        if (opened === undefined) {
          this.options.log(`a key package of scope ${JSON.stringify(scopeId)} is not re-wrapped: its sender is not a current member of the scope policy, or no member KEM key opens it`);
          continue;
        }
        const sealed = await sealScopeKeyPackage({
          scopeKey: opened.scopeKey, tenantId: this.options.tenantId, scopeId, epoch,
          recipient: { memberId: view.member.memberId, kemPublicJwk: next.publicJwk },
          sender: { signingPublicJwk: signing.publicJwk, signingPrivateKey: signing.privateKey },
        });
        opened.scopeKey.fill(0);
        rewrapped.push(sealed);
        expected.set(epoch, sealed.keyId);
      }
      if (this.#session !== view) continue;
      // A row found at a fresh epoch from a sender `fetch` refuses gives no key to keep, so only a missing one stops the rotation.
      const unopened = [...held].find((epoch) => !expected.has(epoch)) ?? fresh.find((epoch) => !found.has(epoch));
      if (unopened !== undefined) {
        this.options.log(`epoch ${unopened} of scope ${JSON.stringify(scopeId)} is held but its key package was not ${found.has(unopened) ? 'opened' : 'read'}`);
        return found.has(unopened) ? 'rewrap_unverified' : 'key_package_missing';
      }
      for (let at = 0; at < rewrapped.length; at += E2EE_SCOPE_KEY_PACKAGE_PUT_MAX) {
        await this.options.client.putKeyPackages(rewrapped.slice(at, at + E2EE_SCOPE_KEY_PACKAGE_PUT_MAX), this.#requestSignal());
      }
      return await this.#readBack(this.#session ?? view, scopeId, expected, next, old, held, fresh) ?? expected;
    }
    return 'chain_moved';
  }

  /**
   * Read the scope's epochs again: each epoch of `expected` must open with
   * `next` under its `keyId`, each `held` epoch must read back and open with
   * `next`, each `fresh` epoch must read back, and a package that landed
   * since, such as one a client that has not walked the `rotate` yet wrapped
   * to `old`, must not open only with `old`.
   */
  async #readBack(
    view: DeviceMemberSession, scopeId: string, expected: ReadonlyMap<number, string>, next: MemberKemKey, old: MemberKemKey,
    held: ReadonlySet<number>, fresh: readonly number[],
  ): Promise<KemRotationFailure | undefined> {
    const found = await this.#readEpochs(scopeId);
    if (found === undefined) return 'scope_epochs_exceeded';
    const unverified = (epoch: number, why: string): KemRotationFailure => {
      this.options.log(`epoch ${epoch} of scope ${JSON.stringify(scopeId)} ${why}`);
      return 'rewrap_unverified';
    };
    for (const epoch of expected.keys()) if (!found.has(epoch)) return unverified(epoch, 'was re-wrapped but no key package reads back');
    const missing = [...held, ...fresh].find((epoch) => !found.has(epoch));
    if (missing !== undefined) {
      this.options.log(`epoch ${missing} of scope ${JSON.stringify(scopeId)} is held but its key package was not read`);
      return 'key_package_missing';
    }
    for (const [epoch, pkg] of found) {
      const current = await this.#openAccepted(view, scopeId, epoch, pkg, next);
      current?.scopeKey.fill(0);
      if (current !== undefined) {
        if (expected.has(epoch) && expected.get(epoch) !== current.keyId) return unverified(epoch, 'reads back under another key id');
        continue;
      }
      if (expected.has(epoch) || held.has(epoch)) return unverified(epoch, 'reads back with a key package the next KEM key does not open');
      const stale = await this.#openAccepted(view, scopeId, epoch, pkg, old);
      stale?.scopeKey.fill(0);
      if (stale !== undefined) return unverified(epoch, 'holds a key package that opens only with the old KEM key');
    }
    return undefined;
  }

  /**
   * The key package of each epoch of a scope from 1 up to
   * {@link KEM_REWRAP_MAX_EPOCHS}, {@link ROTATION_EPOCH_READS} at a time.
   * The verified chain holds no scope epochs, so no read stops early: the
   * device's packages may start above the epochs this run knows, after a
   * restart or past a gap. `undefined` when an epoch this run knows passes
   * the bound, or the top epoch holds a package: the scope is further ahead
   * than the device can see.
   */
  async #readEpochs(scopeId: string): Promise<Map<number, unknown> | undefined> {
    const top = KEM_REWRAP_MAX_EPOCHS;
    if (Math.max(...this.#knownEpochs(scopeId)) > top) {
      this.options.log(`scope ${JSON.stringify(scopeId)} has epochs past the ${top} a KEM rotation reads`);
      return undefined;
    }
    const found = new Map<number, unknown>();
    for (let from = 1; from <= top; from += ROTATION_EPOCH_READS) {
      const epochs = Array.from({ length: Math.min(ROTATION_EPOCH_READS, top - from + 1) }, (_, index) => from + index);
      const reads = await Promise.all(epochs.map((epoch) => this.options.client.readKeyPackages(scopeId, epoch, this.#requestSignal())));
      reads.forEach((packages, index) => {
        if (packages.length > 0) found.set(epochs[index]!, packages[0]);
      });
    }
    if (found.has(top)) {
      this.options.log(`the Host holds epoch ${top} of scope ${JSON.stringify(scopeId)}, beyond the epochs a KEM rotation reads`);
      return undefined;
    }
    return found;
  }

  /** Open an own package of `epoch` with `kem`, when `fetch` would accept its sender in `view`. */
  async #openAccepted(view: DeviceMemberSession, scopeId: string, epoch: number, pkg: unknown, kem: MemberKemKey) {
    const sender = senderOf(pkg);
    if (sender === undefined || this.#scopeFailure(view, scopeId, sender) !== undefined) return undefined;
    const result = await this.#openOwn(view, scopeId, epoch, pkg, view.state.members.get(sender)!.signingPublicJwk, [kem]);
    return result.ok ? { keyId: result.keyId, scopeKey: result.scopeKey } : undefined;
  }

  /** Open a package addressed to this member with the first of `kems` that opens it. */
  async #openOwn(
    session: DeviceMemberSession, scopeId: string, epoch: number, pkg: unknown, senderSigningPublicJwk: P256PublicJwk, kems: readonly MemberKemKey[],
  ): Promise<ScopeKeyPackageOpenResult> {
    let opened!: ScopeKeyPackageOpenResult;
    for (const kem of kems) {
      opened = await openScopeKeyPackage({
        package: pkg,
        expected: { tenantId: this.options.tenantId, scopeId, epoch },
        recipient: { memberId: session.member.memberId, kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey },
        senderSigningPublicJwk,
      });
      if (opened.ok) break;
    }
    return opened;
  }

  /**
   * Ends this keyring with its daemon run, without `onLost`: the cached keys
   * are zeroed and the chain view and freshness points are dropped, so a
   * seal or open that still holds this keyring finds no key. Its Host
   * requests in flight are aborted, so a rotation keeps no key and puts
   * nothing more. Returns the points for the next run's keyring; a lost
   * member leaves none.
   */
  retire(): MemberFreshness | undefined {
    const session = this.#session;
    const points = new Map([...this.#fresh].map(([scopeId, epochs]) => [scopeId, new Map(epochs)] as const));
    const rotated = new Map(this.#rotated);
    this.#session = undefined;
    this.#retired.abort();
    for (const key of this.#keys.values()) key.scopeKey.fill(0);
    this.#keys.clear();
    this.#fresh.clear();
    this.#rotated.clear();
    this.#taken.clear();
    if (session === undefined) return undefined;
    return { tenantId: this.options.tenantId, deviceId: this.options.deviceId, memberId: session.member.memberId, points, rotated };
  }

  /**
   * Keep each carried point of this member whose chain head is on this run's
   * verified chain, with the seq a rotated epoch was wrapped at: that seq is
   * at or before the point, so it is on the chain too.
   */
  #carry(session: DeviceMemberSession, carried: MemberFreshness | undefined): void {
    if (carried === undefined || carried.tenantId !== this.options.tenantId || carried.deviceId !== this.options.deviceId
      || carried.memberId !== session.member.memberId) return;
    for (const [scopeId, epochs] of carried.points) {
      for (const [epoch, point] of epochs) {
        if (session.hashes[point.seq - 1] !== point.hash) continue;
        const points = this.#fresh.get(scopeId) ?? new Map<number, MemberChainPoint>();
        this.#fresh.set(scopeId, points);
        points.set(epoch, point);
        const wrapped = carried.rotated.get(keyOf(scopeId, epoch));
        if (wrapped !== undefined) this.#rotated.set(keyOf(scopeId, epoch), wrapped);
      }
    }
  }

  async #advance(): Promise<void> {
    const current = this.#session;
    if (current === undefined) return;
    const head = current.state.head!;
    const entries = await this.options.client.readChainFrom(head.seq, this.#requestSignal());
    if (entries.length === 0 || this.#session !== current) return;
    const applied = await applyMemberChainEntries(current.state, entries);
    // A retire while the entries were checked ends the catch-up.
    if (this.#session !== current) return;
    if (!applied.ok) return this.#lose(`a member chain entry after seq ${head.seq} is invalid (${applied.reason}); E2EE stays off`);
    if (!applied.state.members.has(current.member.memberId)) return this.#lose('this device is no longer a current member of the chain; E2EE stays off');
    const { records, tenantId, deviceId } = this.options;
    await records.saveState({ tenantId, deviceId, member: current.member, anchor: current.anchor, head: applied.state.head! });
    const verified = entries as MemberChainEntryV1[];
    const session = {
      ...current, state: applied.state, entries: [...current.entries, ...verified], hashes: [...current.hashes, ...await entryHashes(entries)],
    };
    if (this.#session !== current) return;
    this.#session = session;
    this.#record(verified);
    // A shred drops the scope, and a policy can drop this device or the sender, or add another device: their keys go.
    for (const [at, key] of this.#keys) {
      if (this.#scopeFailure(session, at.slice(at.indexOf('\0') + 1), key.sender) !== undefined) {
        key.scopeKey.fill(0);
        this.#keys.delete(at);
      }
    }
  }

  /** A signal for one Host read, made when the read starts so a queued catch-up does not spend its time waiting. */
  #requestSignal(): AbortSignal {
    return AbortSignal.any([this.options.signal, this.#retired.signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? MEMBER_REQUEST_TIMEOUT_MS)]);
  }

  /** Keep the policy versions and removals of verified entries. */
  #record(entries: readonly MemberChainEntryV1[]): void {
    for (const entry of entries) {
      const subject = entry.subject as { readonly scopeId?: string; readonly members?: readonly string[]; readonly memberId?: string };
      if (entry.op === 'scope-policy') {
        const versions = this.#policies.get(subject.scopeId!) ?? [];
        versions.push({ seq: entry.seq, members: subject.members! });
        this.#policies.set(subject.scopeId!, versions);
      } else if (entry.op === 'remove') {
        this.#removals.push({ seq: entry.seq, memberId: subject.memberId! });
      } else if (entry.op === 'rotate') {
        this.#kemRotations.push({ seq: entry.seq, memberId: subject.memberId! });
      }
    }
  }

  #policyAt(scopeId: string, seq: number): PolicyVersion | undefined {
    return (this.#policies.get(scopeId) ?? []).filter((version) => version.seq <= seq).at(-1);
  }

  /**
   * Whether a chain change after `from`, up to `to`, may have left a member
   * out of the epoch. Conservative: a member of any policy version counts.
   * An epoch this run rotated to holds packages for the members and KEM keys
   * at the seq it was wrapped at, so a member added to the scope, or a member
   * KEM rotation, after that seq also counts, even when opened content moved
   * `from` past it: the next seal rotates again.
   */
  #stale(scopeId: string, epoch: number, from: number, to: number): boolean {
    const versions = this.#policies.get(scopeId) ?? [];
    const members = new Set(versions.flatMap((version) => version.members));
    const between = (change: { readonly seq: number }, start: number): boolean => change.seq > start && change.seq <= to;
    if (this.#removals.some((removal) => between(removal, from) && members.has(removal.memberId))) return true;
    const dropped = versions.some((version, index) => between(version, from) && index > 0
      && versions[index - 1]!.members.some((member) => !version.members.includes(member)));
    if (dropped) return true;
    const wrapped = this.#rotated.get(keyOf(scopeId, epoch));
    if (wrapped === undefined) return false;
    if (this.#kemRotations.some((rotation) => between(rotation, wrapped) && members.has(rotation.memberId))) return true;
    return versions.some((version, index) => between(version, wrapped) && index > 0
      && version.members.some((member) => !versions[index - 1]!.members.includes(member)));
  }

  #scope(session: DeviceMemberSession, scopeId: string): MemberChainScope | undefined {
    const failure = this.#scopeFailure(session, scopeId);
    if (failure === undefined) return session.state.scopes.get(scopeId);
    this.options.log(`scope ${JSON.stringify(scopeId)} is not usable (${failure})`);
    return undefined;
  }

  /** Why a key of this scope, from this sender, is not usable in the verified state; `undefined` when it is. */
  #scopeFailure(session: DeviceMemberSession, scopeId: string, sender?: string): ScopeFailure | undefined {
    const scope = session.state.scopes.get(scopeId);
    if (scope === undefined) return 'scope_unknown';
    const self = session.member.memberId;
    if (!scope.members.includes(self)) return 'not_a_scope_member';
    if (scope.members.some((id) => id !== self && session.state.members.get(id)?.deviceId !== undefined)) return 'scope_shared_with_device';
    if (sender !== undefined && !(scope.members.includes(sender) && session.state.members.has(sender))) return 'key_package_sender_invalid';
    return undefined;
  }

  #lose(message: string): void {
    this.#session = undefined;
    for (const key of this.#keys.values()) key.scopeKey.fill(0);
    this.#keys.clear();
    this.options.log(message);
    this.options.onLost?.();
  }
}

/** The KEM keys a package may be wrapped to: during a rotation, the next one first. */
function kemKeys(keys: MemberKeys): readonly MemberKemKey[] {
  return keys.nextKem === undefined ? [keys.kem] : [keys.nextKem, keys.kem];
}

function sameJwk(left: P256PublicJwk, right: P256PublicJwk): boolean {
  return left.x === right.x && left.y === right.y;
}

function senderOf(pkg: unknown): string | undefined {
  if (typeof pkg !== 'object' || pkg === null) return undefined;
  const { sender } = pkg as { readonly sender?: unknown };
  return typeof sender === 'string' ? sender : undefined;
}

/** The epochs of one scope among `keyOf` keys. */
function scopeEpochs(keys: Iterable<string>, scopeId: string): number[] {
  return [...keys].filter((at) => at.slice(at.indexOf('\0') + 1) === scopeId).map((at) => Number(at.slice(0, at.indexOf('\0'))));
}
