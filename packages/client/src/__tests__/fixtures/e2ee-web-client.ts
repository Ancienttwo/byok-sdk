/**
 * A web client member for E2EE tests (#654 design §7.2): it starts the
 * tenant's member chain, checks a device's pairing MAC, signs `add(device)`
 * and relays its own MAC, all with the core functions a browser runs.
 */
import {
  computeClientPairingMac,
  createMemberKeyBundle,
  encodePairingVerificationSecret,
  generateMemberKeyRecord,
  generatePairingVerificationSecret,
  generateScopeKey,
  memberChainEntryHash,
  openMemberKeyRecord,
  openScopeKeyPackage,
  parseMemberKeyBundle,
  sealScopeKeyPackage,
  signMemberChainEntry,
  verifyDevicePairingMac,
  type MemberChainEntryV1,
  type MemberChainOp,
  type MemberKeyBundleV1,
  type MemberKeys,
  type ScopeKeyPackageV2,
  type SealedCategory,
} from '@byok-sdk/core/sealed-payload';
import type { E2eeTestHost } from './e2ee-test-host';

type JsonObject = { [key: string]: never };

export class E2eeWebClient {
  readonly pv: Uint8Array = generatePairingVerificationSecret();
  head: { seq: number; hash: string } | undefined;

  private constructor(readonly tenantId: string, readonly keys: MemberKeys, readonly member: MemberKeyBundleV1, private readonly host: E2eeTestHost) {}

  /** A client with its genesis `add(self)` on the host's chain (11a). */
  static async create(host: E2eeTestHost, tenantId = 'tenant-test'): Promise<E2eeWebClient> {
    const keys = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId })))!;
    const member = await createMemberKeyBundle({
      signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch,
    });
    const client = new E2eeWebClient(tenantId, keys, member, host);
    await client.append('add', { member });
    return client;
  }

  /** The base32 `pv` the device is given after the pairing code. */
  get verificationSecret(): string {
    return encodePairingVerificationSecret(this.pv);
  }

  /** Take the host chain's last entry as the head, after another member appended. */
  async follow(): Promise<void> {
    const { sig: _sig, ...unsigned } = this.host.chain.at(-1) as MemberChainEntryV1;
    this.head = { seq: unsigned.seq, hash: await memberChainEntryHash(unsigned) };
  }

  /** Sign the next chain entry and append it. */
  async append(op: MemberChainOp, subject: object): Promise<MemberChainEntryV1> {
    const seq = (this.head?.seq ?? 0) + 1;
    const unsigned = { v: 1 as const, tenantId: this.tenantId, seq, prev: this.head?.hash ?? null, op, subject: subject as JsonObject, signer: this.member.memberId };
    const entry = await signMemberChainEntry(unsigned, this.keys.signing);
    this.head = { seq, hash: await memberChainEntryHash(unsigned) };
    this.host.clientAppend(entry);
    return entry;
  }

  /**
   * Pairing step 4: check the device MAC over the registered bundle, sign
   * `add(device)`, and relay the client MAC with the new head.
   */
  async approve(deviceId: string): Promise<MemberKeyBundleV1> {
    const registration = this.host.registration(deviceId);
    if (registration === undefined) throw new Error(`device ${deviceId} registered no member bundle`);
    const device = await parseMemberKeyBundle(registration.member);
    if (device === undefined || !(await verifyDevicePairingMac(this.pv, { tenantId: this.tenantId, deviceId, member: device }, registration.mac))) {
      throw new Error('the device pairing MAC does not verify');
    }
    await this.append('add', { member: device });
    await this.relay(deviceId);
    return device;
  }

  /** The relay body of step 4: the client MAC over `head`. */
  async relayBody(head = this.head!): Promise<{ mac: string; member: MemberKeyBundleV1; chainHead: { seq: number; hash: string } }> {
    return { mac: await computeClientPairingMac(this.pv, { member: this.member, chainHead: head }), member: this.member, chainHead: head };
  }

  /**
   * Create or update a scope: sign its `scope-policy` for this client and
   * `members`, then put a package of `scopeKey` at `epoch` for each of them.
   */
  async putScope(
    scopeId: string,
    members: readonly MemberKeyBundleV1[],
    options: { readonly epoch?: number; readonly scopeKey?: Uint8Array; readonly categories?: readonly SealedCategory[] } = {},
  ): Promise<Uint8Array> {
    const scopeKey = options.scopeKey ?? generateScopeKey();
    const ids = [this.member.memberId, ...members.map((member) => member.memberId)].sort();
    await this.append('scope-policy', { scopeId, categories: options.categories ?? ['task-input', 'task-output'], members: ids });
    this.host.clientPutPackages(...await Promise.all(members.map((member) => this.sealPackage(scopeId, member, scopeKey, options.epoch))));
    return scopeKey;
  }

  /** One key package of `scopeKey`, from this client to `recipient`. */
  sealPackage(scopeId: string, recipient: MemberKeyBundleV1, scopeKey: Uint8Array, epoch = 1): Promise<ScopeKeyPackageV2> {
    return sealScopeKeyPackage({
      scopeKey, tenantId: this.tenantId, scopeId, epoch,
      recipient: { memberId: recipient.memberId, kemPublicJwk: recipient.kemPublicJwk, kemEpoch: recipient.kemEpoch },
      sender: { signingPublicJwk: this.keys.signing.publicJwk, signingPrivateKey: this.keys.signing.privateKey },
    });
  }

  /** Open this client's package of one scope epoch, sealed by `sender`; it throws when there is none or it does not open. */
  async openPackage(scopeId: string, epoch: number, sender: MemberKeyBundleV1): Promise<Uint8Array> {
    const pkg = this.host.packages.find((stored) => stored.scopeId === scopeId && stored.epoch === epoch && stored.recipient === this.member.memberId);
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: this.tenantId, scopeId, epoch },
      recipient: { memberId: this.member.memberId, kemPublicJwk: this.keys.kem.publicJwk, kemPrivateKey: this.keys.kem.privateKey, kemEpoch: this.keys.kem.epoch },
      senderSigningPublicJwk: sender.signingPublicJwk,
    });
    if (!opened.ok) throw new Error(`the package of epoch ${epoch} does not open: ${opened.reason}`);
    return opened.scopeKey;
  }

  /** Relay the client MAC over the current head. */
  async relay(deviceId: string, head = this.head!): Promise<void> {
    this.host.clientRelayPairingMac(deviceId, await this.relayBody(head));
  }
}
