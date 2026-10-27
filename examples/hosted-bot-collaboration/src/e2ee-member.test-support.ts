/**
 * A web client member of a hosted tenant (#654 design §7.2), built on `@byok-sdk/core/sealed-payload` and the
 * `ByokCloud` member methods only. It starts the member chain, checks the paired device's MAC, signs `add(device)`,
 * relays its own MAC and puts one scope's key packages, as a browser member does against a hosted Host.
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
  openSealedContent,
  parseMemberKeyBundle,
  sealContent,
  sealScopeKeyPackage,
  signMemberChainEntry,
  verifyDevicePairingMac,
  type MemberChainOp,
  type MemberKeyBundleV1,
  type MemberKeys,
  type SealedBinding,
} from '@byok-sdk/core/sealed-payload';
import type { AgentRef, ByokCloud } from '@byok-sdk/cloud';

type JsonObject = { [key: string]: never };
type Tenant = Parameters<ByokCloud['appendMemberChainEntries']>[0];
/** The `sealing` of a task offer: the scope, its epoch and the sealed categories. */
export type TaskSealing = Parameters<ByokCloud['submitSealedAgentExecution']>[1]['payload']['sealing'];
/** The frame's own length limit. The receiver applies the protocol's plaintext limit when it opens. */
const FRAME_MAX_CONTENT_LENGTH = 0xffff_ffff;

/** The plaintext header and the ciphertext bytes of one sealed member. */
export interface SealedMember {
  readonly header: Record<string, unknown>;
  readonly ciphertext: Uint8Array;
}

export class HostedMember {
  readonly pv: Uint8Array = generatePairingVerificationSecret();
  #head: { seq: number; hash: string } | undefined;
  #scope: { readonly sealing: TaskSealing; readonly key: Uint8Array } | undefined;

  private constructor(private readonly cloud: ByokCloud, private readonly tenant: Tenant, readonly keys: MemberKeys,
    readonly member: MemberKeyBundleV1) {}

  /** A member with its genesis `add(self)` on the tenant's chain. */
  static async create(cloud: ByokCloud, tenant: Tenant): Promise<HostedMember> {
    const keys = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: tenant })))!;
    const member = await createMemberKeyBundle({
      signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch,
    });
    const created = new HostedMember(cloud, tenant, keys, member);
    await created.#append('add', { member });
    return created;
  }

  /** The base32 `pv` the device is given with the pairing code. */
  get verificationSecret(): string {
    return encodePairingVerificationSecret(this.pv);
  }

  /** The scope that {@link putScope} created. */
  get sealing(): TaskSealing {
    if (this.#scope === undefined) throw new Error('the member has no scope yet');
    return this.#scope.sealing;
  }

  /**
   * Pairing step 4: check the device MAC over its registered bundle, sign `add(device)`, and relay the client MAC
   * over the new head.
   */
  async approve(deviceId: string): Promise<MemberKeyBundleV1> {
    const registration = await this.cloud.readMemberKeyRegistration(this.tenant, deviceId);
    if (registration?.deviceMac === undefined) throw new Error(`device ${deviceId} registered no member bundle with a MAC`);
    const device = await parseMemberKeyBundle(registration.member);
    if (device === undefined
      || !(await verifyDevicePairingMac(this.pv, { tenantId: this.tenant, deviceId, member: device }, registration.deviceMac))) {
      throw new Error('the device pairing MAC does not verify');
    }
    await this.#append('add', { member: device });
    const chainHead = this.#head!;
    await this.cloud.relayClientPairingMac(this.tenant, deviceId, {
      mac: await computeClientPairingMac(this.pv, { member: this.member, chainHead }), member: this.member, chainHead,
    });
    return device;
  }

  /** Sign the `scope-policy` of `scopeId` for this member and `device`, then put a key package of a new scope key for each. */
  async putScope(scopeId: string, device: MemberKeyBundleV1, categories: TaskSealing['categories']): Promise<void> {
    const key = generateScopeKey(), epoch = 1;
    await this.#append('scope-policy', { scopeId, categories, members: [this.member.memberId, device.memberId].sort() });
    const sender = { signingPublicJwk: this.keys.signing.publicJwk, signingPrivateKey: this.keys.signing.privateKey };
    const packages = await Promise.all([this.member, device].map((recipient) => sealScopeKeyPackage({
      scopeKey: key, tenantId: this.tenant, scopeId, epoch, sender,
      recipient: { memberId: recipient.memberId, kemPublicJwk: recipient.kemPublicJwk, kemEpoch: recipient.kemEpoch },
    })));
    await this.cloud.putScopeKeyPackages(this.tenant, { packages });
    this.#scope = { sealing: { scopeId, epoch, categories: [...categories] }, key };
  }

  /** One `task-input` member for the device, in the inline wire form. */
  async seal(family: string, identity: SealedBinding['identity'], deviceId: string, agentRef: AgentRef, plaintext: object) {
    const { header, ciphertext } = await sealContent({
      scopeKey: this.#scope!.key, scope: { id: this.sealing.scopeId, epoch: this.sealing.epoch }, chainHead: this.#head!,
      sender: this.member.memberId, category: 'task-input', binding: this.#binding(family, 'server-to-daemon', identity, deviceId, agentRef),
      plaintext: plaintext as never, maxContentLength: FRAME_MAX_CONTENT_LENGTH,
    });
    return { ...header, category: 'task-input' as const, ciphertext: Buffer.from(ciphertext).toString('base64url') };
  }

  /** Open a member that the device sealed for `family`; it throws when the member does not open. */
  async open(family: string, identity: SealedBinding['identity'], deviceId: string, agentRef: AgentRef, sealed: SealedMember): Promise<unknown> {
    const opened = await openSealedContent({
      header: sealed.header as never, ciphertext: sealed.ciphertext, scopeKey: this.#scope!.key,
      binding: this.#binding(family, 'daemon-to-server', identity, deviceId, agentRef),
      // The padded length bounds the content, so it is a limit the member's own check never trips.
      sealing: { scopeId: this.sealing.scopeId, epoch: this.sealing.epoch }, maxContentLength: sealed.header.paddedLength as number,
    });
    if (!opened.ok) throw new Error(`the member could not open ${family}: ${opened.reason}`);
    return opened.plaintext;
  }

  #binding(family: string, direction: SealedBinding['direction'], identity: SealedBinding['identity'], deviceId: string,
    agentRef: AgentRef): SealedBinding {
    return { tenantId: this.tenant, family, direction, identity, deviceId, agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
      categories: this.sealing.categories, notAfter: null };
  }

  async #append(op: MemberChainOp, subject: object): Promise<void> {
    const seq = (this.#head?.seq ?? 0) + 1;
    const unsigned = { v: 1 as const, tenantId: this.tenant, seq, prev: this.#head?.hash ?? null, op, subject: subject as JsonObject, signer: this.member.memberId };
    await this.cloud.appendMemberChainEntries(this.tenant, { entries: [await signMemberChainEntry(unsigned, this.keys.signing)] });
    this.#head = { seq, hash: await memberChainEntryHash(unsigned) };
  }
}
