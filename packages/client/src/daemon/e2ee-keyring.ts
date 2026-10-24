/**
 * The verified device member of one daemon run and the scope keys it opened
 * (#654 E2d-2; design §7.4).
 *
 * The chain view only moves forward: `catchUp()` reads the entries after the
 * verified head, applies them to the verified state, and stores the new
 * head. An invalid entry, or a chain that no longer holds this device as a
 * current member, ends the member for this run.
 *
 * A scope key comes from the one key package the Host holds for this
 * member at `(scope, epoch)`. The package is opened only when the scope is
 * in the verified state and both this device and the sender are in its
 * latest `scope-policy`; the sender's signing key comes from the verified
 * chain, never from the Host. The opened keys are kept in memory only.
 */
import { applyMemberChainEntries, openScopeKeyPackage, type ScopeKeyPackageOpenResult } from '@byok-sdk/core/sealed-payload';
import type { DeviceMemberRecords } from './device-member-custody';
import { entryHashes, type DeviceMemberLog, type DeviceMemberSession } from './device-member';
import type { E2eeMemberClient } from './e2ee-member-client';

export interface ScopeKey {
  readonly scopeKey: Uint8Array;
  readonly keyId: string;
  /** Member id of the member that sealed the package. */
  readonly sender: string;
}

export type ScopeKeyFetchFailure =
  | 'member_lost'
  | 'scope_unknown'
  | 'not_a_scope_member'
  | 'key_package_missing'
  | 'key_package_sender_invalid'
  | Extract<ScopeKeyPackageOpenResult, { ok: false }>['reason'];

export type ScopeKeyFetchResult =
  | { readonly ok: true; readonly key: ScopeKey }
  | { readonly ok: false; readonly reason: ScopeKeyFetchFailure };

export interface DeviceMemberKeyringOptions {
  readonly records: DeviceMemberRecords;
  readonly client: E2eeMemberClient;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly log: DeviceMemberLog;
}

function keyOf(scopeId: string, epoch: number): string {
  return `${epoch}\0${scopeId}`;
}

export class DeviceMemberKeyring {
  #session: DeviceMemberSession | undefined;
  readonly #keys = new Map<string, ScopeKey>();
  #tail: Promise<void> = Promise.resolve();

  constructor(session: DeviceMemberSession, private readonly options: DeviceMemberKeyringOptions) {
    this.#session = session;
  }

  /** The verified member, or `undefined` once this run lost it. */
  get session(): DeviceMemberSession | undefined {
    return this.#session;
  }

  /** The opened key of one scope epoch, if this run holds it and the verified scope still holds this device. */
  cached(scopeId: string, epoch: number): ScopeKey | undefined {
    return this.#session !== undefined && this.#scopeHoldsSelf(this.#session, scopeId) ? this.#keys.get(keyOf(scopeId, epoch)) : undefined;
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
   * Catch up, then fetch and open the key package of one scope epoch. A
   * transport failure throws; every other end is a result.
   */
  async fetch(scopeId: string, epoch: number): Promise<ScopeKeyFetchResult> {
    await this.catchUp();
    const session = this.#session;
    if (session === undefined) return { ok: false, reason: 'member_lost' };
    const scope = session.state.scopes.get(scopeId);
    if (scope === undefined) return { ok: false, reason: 'scope_unknown' };
    const self = session.member.memberId;
    if (!scope.members.includes(self)) return { ok: false, reason: 'not_a_scope_member' };
    const known = this.#keys.get(keyOf(scopeId, epoch));
    if (known !== undefined) return { ok: true, key: known };
    const packages = await this.options.client.readKeyPackages(scopeId, epoch);
    // The Host keeps one package per (scope, epoch, recipient).
    if (packages.length !== 1) return { ok: false, reason: packages.length === 0 ? 'key_package_missing' : 'key_package_invalid' };
    const pkg = packages[0] as { readonly sender?: unknown };
    const sender = typeof pkg.sender === 'string' && scope.members.includes(pkg.sender) ? session.state.members.get(pkg.sender) : undefined;
    if (sender === undefined) return { ok: false, reason: 'key_package_sender_invalid' };
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: this.options.tenantId, scopeId, epoch },
      recipient: { memberId: self, kemPublicJwk: session.keys.kem.publicJwk, kemPrivateKey: session.keys.kem.privateKey },
      senderSigningPublicJwk: sender.signingPublicJwk,
    });
    if (!opened.ok) return opened;
    // A concurrent fetch, or a loss, may have settled this epoch meanwhile.
    const raced = this.cached(scopeId, epoch);
    if (raced !== undefined || this.#session === undefined) {
      opened.scopeKey.fill(0);
      return raced === undefined ? { ok: false, reason: 'member_lost' } : { ok: true, key: raced };
    }
    const key = { scopeKey: opened.scopeKey, keyId: opened.keyId, sender: sender.memberId };
    this.#keys.set(keyOf(scopeId, epoch), key);
    return { ok: true, key };
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
    const session = { ...current, state: applied.state, hashes: [...current.hashes, ...await entryHashes(entries)] };
    this.#session = session;
    // A shred drops the scope, and a policy can drop this device: their keys go.
    for (const [at, key] of this.#keys) {
      if (!this.#scopeHoldsSelf(session, at.slice(at.indexOf('\0') + 1))) {
        key.scopeKey.fill(0);
        this.#keys.delete(at);
      }
    }
  }

  #scopeHoldsSelf(session: DeviceMemberSession, scopeId: string): boolean {
    return session.state.scopes.get(scopeId)?.members.includes(session.member.memberId) === true;
  }

  #lose(message: string): void {
    this.#session = undefined;
    for (const key of this.#keys.values()) key.scopeKey.fill(0);
    this.#keys.clear();
    this.options.log(message);
  }
}
