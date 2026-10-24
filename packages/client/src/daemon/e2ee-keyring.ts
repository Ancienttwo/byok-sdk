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
 * `scope-policy` lies after h. The points are rebuilt from opened content
 * after a restart.
 *
 * Device rotation (E2d-4, §7.5): when no epoch is fresh, the device is the
 * next sender, so it rotates. It wraps a new scope key at the epoch after the
 * newest one it knows to every current member of the scope policy, puts the
 * packages, and only then keeps the key, with the head it chose the
 * recipients at as the epoch's freshness point.
 *
 * KEM rotation (E2d-5, §7.5): the member stores a next KEM key beside the
 * current one, appends its `rotate` entry after a local walk (§7.9
 * requirement 2), re-wraps each of its own packages that it may use now to
 * the next key, reads them back, and only then drops the old private key.
 * Until then a package opens with either key, and a resumed rotation picks
 * up where it stopped.
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
import { entryHashes, type DeviceMemberLog, type DeviceMemberSession } from './device-member';
import { E2EE_SCOPE_KEY_PACKAGE_PUT_MAX } from '@byok-sdk/protocol';
import { E2eeMemberClientError, type E2eeMemberClient } from './e2ee-member-client';
import type { SealedScopeKeyring, SealingKey } from './sealed-task';

/** How many rotations one seal waits for or starts before it fails closed. */
const MAX_ROTATION_ROUNDS = 3;

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
  /** A re-wrapped package does not read back with the next key, or a package still opens only with the old key. */
  | 'rewrap_unverified'
  /** The verified chain moved during each try of a scope's re-wrap. */
  | 'chain_moved';

export type KemRotationResult =
  | { readonly ok: true; readonly epoch: number }
  | { readonly ok: false; readonly reason: KemRotationFailure };

export interface DeviceMemberKeyringOptions {
  readonly records: DeviceMemberRecords;
  readonly client: E2eeMemberClient;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly log: DeviceMemberLog;
  /** Called once when this run loses the member. */
  readonly onLost?: () => void;
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
  /** The newest authenticated chain head per scope, then per epoch. */
  readonly #fresh = new Map<string, Map<number, MemberChainPoint>>();
  /** The rotation in flight per scope, so concurrent seals rotate once. */
  readonly #rotations = new Map<string, Promise<void>>();
  #kemRotation: Promise<KemRotationResult> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(session: DeviceMemberSession, private readonly options: DeviceMemberKeyringOptions) {
    this.#session = session;
    this.#record(session.entries);
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
   * opened. A transport failure throws; every other end is a result.
   */
  async fetch(scopeId: string, epoch: number): Promise<ScopeKeyFetchResult> {
    await this.catchUp();
    const session = this.#session;
    if (session === undefined) return { ok: false, reason: 'member_lost' };
    const failure = this.#scopeFailure(session, scopeId);
    if (failure !== undefined) return { ok: false, reason: failure };
    const known = this.cached(scopeId, epoch);
    if (known !== undefined) return { ok: true, key: known };
    const self = session.member.memberId;
    const packages = await this.options.client.readKeyPackages(scopeId, epoch);
    // The Host keeps one package per (scope, epoch, recipient).
    if (packages.length !== 1) return { ok: false, reason: packages.length === 0 ? 'key_package_missing' : 'key_package_invalid' };
    const pkg: unknown = packages[0];
    if (typeof pkg !== 'object' || pkg === null) return { ok: false, reason: 'key_package_invalid' };
    const senderId = (pkg as { readonly sender?: unknown }).sender;
    const sender = typeof senderId === 'string' && this.#scopeFailure(session, scopeId, senderId) === undefined ? session.state.members.get(senderId) : undefined;
    if (sender === undefined) return { ok: false, reason: 'key_package_sender_invalid' };
    const opened = await this.#openOwn(session, scopeId, epoch, pkg, sender.signingPublicJwk, kemKeys(session.keys));
    if (!opened.ok) return opened;
    // A concurrent fetch may have settled this epoch, or a catch-up moved the view, while the package was read and opened.
    const raced = this.cached(scopeId, epoch);
    const current = this.#session;
    const lost = current === undefined ? 'member_lost' : this.#scopeFailure(current, scopeId, sender.memberId);
    if (raced !== undefined || lost !== undefined) {
      opened.scopeKey.fill(0);
      return raced !== undefined ? { ok: true, key: raced } : { ok: false, reason: lost! };
    }
    const key = { scopeKey: opened.scopeKey, keyId: opened.keyId, sender: sender.memberId };
    this.#keys.set(keyOf(scopeId, epoch), key);
    return { ok: true, key };
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
    const result = await this.fetch(scope.id, scope.epoch);
    if (result.ok) return result.key.scopeKey.slice();
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
    if (fresh !== undefined) return this.#sealingAt(session, scopeId, fresh);
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
      if (rotated !== undefined) return this.#sealingAt(current, scopeId, rotated);
      if (!joined) break;
    }
    this.options.log(`no fresh epoch at or after ${minEpoch} for scope ${JSON.stringify(scopeId)}; output is not sealed`);
    return undefined;
  }

  #freshEpoch(scopeId: string, minEpoch: number, headSeq: number): number | undefined {
    const epochs = [...(this.#fresh.get(scopeId) ?? new Map<number, MemberChainPoint>())]
      .filter(([epoch, point]) => epoch >= minEpoch && !this.#stale(scopeId, point.seq, headSeq))
      .map(([epoch]) => epoch);
    return epochs.length === 0 ? undefined : Math.max(...epochs);
  }

  async #sealingAt(session: DeviceMemberSession, scopeId: string, epoch: number): Promise<SealingKey | undefined> {
    const head = session.state.head!;
    const key = await this.openingKey({ id: scopeId, epoch });
    return key === undefined ? undefined : { scopeKey: key, epoch, sender: session.member.memberId, chainHead: { seq: head.seq, hash: head.hash } };
  }

  /**
   * Catch up, then wrap a new scope key at the epoch after the newest this
   * member knows (the offer's, a fresh one, or one the Host holds for it) to
   * every current member of the scope policy, and put the packages. A Host
   * that holds that epoch under another key refuses the put, and the seal
   * fails closed. So does a policy that leaves no current member but this
   * one, whose output no client could open. A transport failure throws.
   */
  async #rotate(scopeId: string, minEpoch: number): Promise<void> {
    await this.catchUp();
    const session = this.#session;
    if (session === undefined || this.#scope(session, scopeId) === undefined) return;
    const head = session.state.head!;
    if (this.#freshEpoch(scopeId, minEpoch, head.seq) !== undefined) return;
    const held = (await this.options.client.readKeyPackages(scopeId)).flatMap((pkg) => {
      const epoch = typeof pkg === 'object' && pkg !== null ? (pkg as { readonly epoch?: unknown }).epoch : undefined;
      return typeof epoch === 'number' && Number.isSafeInteger(epoch) ? [epoch] : [];
    });
    const epoch = Math.max(minEpoch, ...held, ...(this.#fresh.get(scopeId)?.keys() ?? [])) + 1;
    const self = session.member.memberId;
    // This member's own package goes in the first put: after any put that landed, the next rotation sees the epoch and moves past it.
    const recipients = [...memberChainScopeRecipients(session.state, scopeId)].sort((left, right) => Number(right.memberId === self) - Number(left.memberId === self));
    if (recipients.every((recipient) => recipient.memberId === self)) {
      this.options.log(`scope ${JSON.stringify(scopeId)} has no current member but this device; it is not rotated`);
      return;
    }
    const sender = { signingPublicJwk: session.keys.signing.publicJwk, signingPrivateKey: session.keys.signing.privateKey };
    const scopeKey = generateScopeKey();
    try {
      const packages = await Promise.all(recipients.map((recipient) => sealScopeKeyPackage({
        scopeKey, tenantId: this.options.tenantId, scopeId, epoch,
        recipient: { memberId: recipient.memberId, kemPublicJwk: recipient.kemPublicJwk }, sender,
      })));
      // The Host takes at most this many per put; the epoch is fresh only after every put.
      for (let at = 0; at < packages.length; at += E2EE_SCOPE_KEY_PACKAGE_PUT_MAX) {
        await this.options.client.putKeyPackages(packages.slice(at, at + E2EE_SCOPE_KEY_PACKAGE_PUT_MAX));
      }
      const current = this.#session;
      if (current === undefined || this.#scopeFailure(current, scopeId) !== undefined) {
        scopeKey.fill(0);
        return;
      }
      this.#keys.set(keyOf(scopeId, epoch), { scopeKey, keyId: packages[0]!.keyId, sender: self });
      const points = this.#fresh.get(scopeId) ?? new Map<number, MemberChainPoint>();
      this.#fresh.set(scopeId, points);
      points.set(epoch, { seq: head.seq, hash: head.hash });
      this.options.log(`rotated scope ${JSON.stringify(scopeId)} to epoch ${epoch} for ${recipients.length} members`);
    } catch (error) {
      scopeKey.fill(0);
      if (!(error instanceof E2eeMemberClientError && error.code === 'e2ee_scope_key_conflict')) throw error;
      this.options.log(`the Host holds epoch ${epoch} of scope ${JSON.stringify(scopeId)} under another key; output is not sealed`);
    }
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
    const failure = await this.#registerKem(next) ?? await this.#rewrap(next);
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
        await this.options.client.appendChain([entry]);
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
   * signature. Then read them back.
   */
  async #rewrap(next: MemberKemKey): Promise<KemRotationFailure | undefined> {
    // An epoch rotation that read the scope members before the `rotate` may still wrap to the old key: let it land first.
    await Promise.allSettled([...this.#rotations.values()]);
    const session = this.#session;
    if (session === undefined) return 'member_lost';
    for (const scopeId of session.state.scopes.keys()) {
      const failure = await this.#rewrapScope(scopeId, next);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  /**
   * One scope's re-wrap. Its senders are checked against the verified view
   * of one try; when a catch-up moves the view during the try, it starts
   * again, at most three times. Every re-wrapped package must then read back
   * and open with `next` under its `keyId`, and no package that `fetch`
   * accepts may still open only with the old key.
   */
  async #rewrapScope(scopeId: string, next: MemberKemKey): Promise<KemRotationFailure | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = this.#session;
      if (view === undefined) return 'member_lost';
      if (this.#scopeFailure(view, scopeId) !== undefined) return undefined;
      const { kem: old, signing } = view.keys;
      const rewrapped: ScopeKeyPackageV1[] = [];
      for (const pkg of await this.options.client.readKeyPackages(scopeId)) {
        const current = await this.#openAccepted(view, scopeId, pkg, next);
        current?.scopeKey.fill(0);
        if (current !== undefined) continue;
        const held = await this.#openAccepted(view, scopeId, pkg, old);
        if (held === undefined) {
          this.options.log(`a key package of scope ${JSON.stringify(scopeId)} is not re-wrapped: its sender is not a current member of the scope policy, or no member KEM key opens it`);
          continue;
        }
        rewrapped.push(await sealScopeKeyPackage({
          scopeKey: held.scopeKey, tenantId: this.options.tenantId, scopeId, epoch: held.epoch,
          recipient: { memberId: view.member.memberId, kemPublicJwk: next.publicJwk },
          sender: { signingPublicJwk: signing.publicJwk, signingPrivateKey: signing.privateKey },
        }));
        held.scopeKey.fill(0);
      }
      if (this.#session !== view) continue;
      for (let at = 0; at < rewrapped.length; at += E2EE_SCOPE_KEY_PACKAGE_PUT_MAX) {
        await this.options.client.putKeyPackages(rewrapped.slice(at, at + E2EE_SCOPE_KEY_PACKAGE_PUT_MAX));
      }
      const unconfirmed = new Map(rewrapped.map((pkg) => [pkg.epoch, pkg.keyId]));
      const back = this.#session ?? view;
      for (const pkg of await this.options.client.readKeyPackages(scopeId)) {
        const current = await this.#openAccepted(back, scopeId, pkg, next);
        current?.scopeKey.fill(0);
        if (current !== undefined) {
          if (unconfirmed.get(current.epoch) === current.keyId) unconfirmed.delete(current.epoch);
          continue;
        }
        const held = await this.#openAccepted(back, scopeId, pkg, old);
        held?.scopeKey.fill(0);
        if (held !== undefined) return 'rewrap_unverified';
      }
      return unconfirmed.size === 0 ? undefined : 'rewrap_unverified';
    }
    return 'chain_moved';
  }

  /** Open an own package with `kem`, when `fetch` would accept its sender in `view`. */
  async #openAccepted(view: DeviceMemberSession, scopeId: string, pkg: unknown, kem: MemberKemKey) {
    const { epoch, sender } = fieldsOf(pkg);
    if (epoch === undefined || sender === undefined || this.#scopeFailure(view, scopeId, sender) !== undefined) return undefined;
    const result = await this.#openOwn(view, scopeId, epoch, pkg, view.state.members.get(sender)!.signingPublicJwk, [kem]);
    return result.ok ? { epoch, keyId: result.keyId, scopeKey: result.scopeKey } : undefined;
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

  async #advance(): Promise<void> {
    const current = this.#session;
    if (current === undefined) return;
    const head = current.state.head!;
    const entries = await this.options.client.readChainFrom(head.seq);
    if (entries.length === 0 || this.#session !== current) return;
    const applied = await applyMemberChainEntries(current.state, entries);
    if (!applied.ok) return this.#lose(`a member chain entry after seq ${head.seq} is invalid (${applied.reason}); E2EE stays off`);
    if (!applied.state.members.has(current.member.memberId)) return this.#lose('this device is no longer a current member of the chain; E2EE stays off');
    const { records, tenantId, deviceId } = this.options;
    await records.saveState({ tenantId, deviceId, member: current.member, anchor: current.anchor, head: applied.state.head! });
    const verified = entries as MemberChainEntryV1[];
    const session = {
      ...current, state: applied.state, entries: [...current.entries, ...verified], hashes: [...current.hashes, ...await entryHashes(entries)],
    };
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
      }
    }
  }

  #policyAt(scopeId: string, seq: number): PolicyVersion | undefined {
    return (this.#policies.get(scopeId) ?? []).filter((version) => version.seq <= seq).at(-1);
  }

  /**
   * Whether a chain change after `from`, up to `to`, may have left a member
   * out of the epoch. Conservative: a member of any policy version counts.
   */
  #stale(scopeId: string, from: number, to: number): boolean {
    const versions = this.#policies.get(scopeId) ?? [];
    const members = new Set(versions.flatMap((version) => version.members));
    if (this.#removals.some((removal) => removal.seq > from && removal.seq <= to && members.has(removal.memberId))) return true;
    return versions.some((version, index) => version.seq > from && version.seq <= to && index > 0
      && versions[index - 1]!.members.some((member) => !version.members.includes(member)));
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

function fieldsOf(pkg: unknown): { readonly epoch?: number; readonly sender?: string } {
  if (typeof pkg !== 'object' || pkg === null) return {};
  const { epoch, sender } = pkg as { readonly epoch?: unknown; readonly sender?: unknown };
  return {
    ...(typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0 ? { epoch } : {}),
    ...(typeof sender === 'string' ? { sender } : {}),
  };
}
