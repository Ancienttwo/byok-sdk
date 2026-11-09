/** Example-private browser member. Private CryptoKeys and pairing secrets live only in this tab. */
import {
  applyMemberChainEntries, emptyMemberChainState, createMemberKeyBundle, signMemberChainEntry,
  computeClientPairingMac, generatePairingVerificationSecret, formatPairingInput, verifyDevicePairingMac,
  parseMemberKeyBundle, memberApprovalCode, generateScopeKey, sealScopeKeyPackage, openScopeKeyPackage,
  openSealedContent, sealContent, SealedContentHeaderV1Schema, memberChainEntryHash, verifyMemberChainFromAnchor,
  type MemberKeyBundleV1, type MemberChainState, type MemberChainOp, type MemberChainEntryV1,
} from '@byok-sdk/core/sealed-payload';
import type { ByokCloud } from '@byok-sdk/cloud';

type Tenant = Parameters<ByokCloud['readMemberChain']>[0];
type MemberCloud = Pick<ByokCloud, 'readMemberChain' | 'appendMemberChainEntries' | 'createPairingCode'
  | 'readMemberKeyRegistration' | 'relayClientPairingMac' | 'putScopeKeyPackages' | 'readScopeKeyPackages'
  | 'readTaskOffer' | 'readDeviceTerminal' | 'submitSealedAgentExecution'>;
export type BrowserTaskTemplate = Pick<Parameters<ByokCloud['submitSealedAgentExecution']>[1], 'deviceId'> & {
  payload: Omit<Parameters<ByokCloud['submitSealedAgentExecution']>[1]['payload'], 'sealed' | 'sealing'>;
};
export type MemberTransport = MemberCloud & { ciphertext(tenant: Tenant, taskId: string): Promise<Uint8Array> };
type PublicJwk = MemberKeyBundleV1['signingPublicJwk'];
export class MemberFailure extends Error {}
function refuse(reason: string): never { throw new MemberFailure(reason); }
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
async function chainHash({ sig: _sig, ...entry }: MemberChainEntryV1): Promise<string> { return memberChainEntryHash(entry); }
export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');

export function memberTransport(bearer: string, request: typeof fetch = fetch): MemberTransport {
  const call = async (method: string, args: unknown[]) => {
    const response = await request('/probe/call', { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
    if (!response.ok) refuse(`host_http_${response.status}`);
    // Readback can include BigInt metadata; the example-private RPC encodes it with this tag.
    return (JSON.parse(await response.text(), (_key, item) => item && typeof item === 'object' && '$canaryBigint' in item
      ? BigInt(item.$canaryBigint) : item) as { value: unknown }).value;
  };
  return {
    ...Object.fromEntries(['readMemberChain', 'appendMemberChainEntries', 'createPairingCode', 'readMemberKeyRegistration',
      'relayClientPairingMac', 'putScopeKeyPackages', 'readScopeKeyPackages', 'readTaskOffer', 'readDeviceTerminal', 'submitSealedAgentExecution']
      .map(method => [method, (...args: unknown[]) => call(method, args)])) as MemberCloud,
    async ciphertext(tenant, taskId) {
      const response = await request('/member/ciphertext', { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ tenant, taskId }) });
      if (!response.ok) refuse(`ciphertext_http_${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export class BrowserMember {
  readonly #pv = generatePairingVerificationSecret();
  #state: MemberChainState;
  #pending: MemberKeyBundleV1 | undefined;
  #pinnedGenesis: string | undefined;
  private constructor(readonly tenant: Tenant, readonly member: MemberKeyBundleV1,
    readonly signing: { publicJwk: PublicJwk; privateKey: CryptoKey }, readonly kem: { publicJwk: PublicJwk; privateKey: CryptoKey },
    private readonly host: MemberTransport) {
    this.#state = emptyMemberChainState(tenant);
  }
  static async create(tenant: string, host: MemberTransport): Promise<BrowserMember> {
    const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const kem = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicJwk = async (key: CryptoKey): Promise<PublicJwk> => {
      const jwk = await crypto.subtle.exportKey('jwk', key);
      return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
    };
    const signingJwk = await publicJwk(signing.publicKey), kemJwk = await publicJwk(kem.publicKey);
    const member = await createMemberKeyBundle({ signingPublicJwk: signingJwk, signingPrivateKey: signing.privateKey,
      kemPublicJwk: kemJwk, kemEpoch: 1 });
    return new BrowserMember(tenant as Tenant, member, { publicJwk: signingJwk, privateKey: signing.privateKey },
      { publicJwk: kemJwk, privateKey: kem.privateKey }, host);
  }
  get chainLength(): number { return this.#state.head?.seq ?? 0; }
  async start(productId: string): Promise<string> {
    if ((await this.host.readMemberChain(this.tenant)).entries.length) refuse('fresh_tenant_required');
    this.#pinnedGenesis = this.member.memberId;
    await this.#append('add', { member: this.member });
    const pairing = await this.host.createPairingCode(this.tenant, { productId });
    return formatPairingInput(pairing.code, this.#pv);
  }
  async verifyDevice(deviceId: string): Promise<string> {
    this.#pending = undefined;
    const registration = await this.host.readMemberKeyRegistration(this.tenant, deviceId);
    const device = await parseMemberKeyBundle(registration?.member);
    if (!device || !(await verifyDevicePairingMac(this.#pv, { tenantId: this.tenant, deviceId, member: device }, registration?.deviceMac))) {
      refuse('device_pairing_mac_invalid');
    }
    this.#pending = device;
    return memberApprovalCode(this.tenant, this.member.signingPublicJwk, device.signingPublicJwk);
  }
  /** Called only after the owner compares all 50 digits on both screens. */
  async confirmDevice(): Promise<void> {
    const device = this.#pending ?? refuse('compare_code_first');
    if (device.deviceId === undefined) refuse('device_bundle_required');
    await this.refresh();
    await this.#append('add', { member: device });
    const chainHead = this.#state.head!;
    await this.host.relayClientPairingMac(this.tenant, device.deviceId!, { member: this.member, chainHead,
      mac: await computeClientPairingMac(this.#pv, { member: this.member, chainHead }) });
    this.#pending = undefined;
    this.#pv.fill(0);
  }
  /** An existing tab approves another browser's public bundle after a two-screen comparison. */
  async compareBrowser(bundle: unknown): Promise<string> {
    this.#pending = undefined;
    const member = await parseMemberKeyBundle(bundle);
    if (!member || member.deviceId !== undefined) refuse('browser_bundle_invalid');
    this.#pending = member;
    return memberApprovalCode(this.tenant, this.member.signingPublicJwk, member.signingPublicJwk);
  }
  async confirmBrowser(): Promise<void> {
    const member = this.#pending ?? refuse('compare_code_first');
    if (member.deviceId !== undefined) refuse('browser_bundle_invalid');
    await this.refresh();
    await this.#append('add', { member });
    this.#pending = undefined;
  }
  /** New tabs pin an approver's public bundle only after comparing the displayed code on both screens. */
  async join(approver: unknown): Promise<void> {
    const pinned = await parseMemberKeyBundle(approver);
    if (!pinned || pinned.deviceId !== undefined || this.#pending?.memberId !== pinned.memberId) refuse('compare_approver_first');
    const entries = await this.#entries();
    const result = await verifyMemberChainFromAnchor({ tenantId: this.tenant, entries, self: this.member,
      approverSigningPublicJwk: pinned.signingPublicJwk });
    if (!result.ok) refuse(result.reason);
    this.#pinnedGenesis = entries[0]!.signer;
    this.#state = result.state;
  }
  async #entries(): Promise<MemberChainEntryV1[]> {
    const entries: MemberChainEntryV1[] = [];
    for (;;) {
      const page = await this.host.readMemberChain(this.tenant, { afterSeq: entries.at(-1)?.seq ?? 0, limit: 100 });
      if (!page.entries.length) return entries;
      entries.push(...page.entries as MemberChainEntryV1[]);
    }
  }
  async refresh(): Promise<MemberChainState> {
    const entries = await this.#entries();
    if (!this.#pinnedGenesis || entries[0]?.signer !== this.#pinnedGenesis) refuse('chain_anchor_invalid');
    if (this.#state.head) {
      const previous = entries[this.#state.head.seq - 1];
      if (!previous || await chainHash(previous) !== this.#state.head.hash) refuse('chain_rollback');
    }
    const result = await applyMemberChainEntries(emptyMemberChainState(this.tenant), entries);
    if (!result.ok) refuse(result.reason);
    this.#state = result.state;
    return this.#state;
  }
  /** Reissue a fresh scope epoch to all currently active members, including other approved browser tabs. */
  async scope(scopeId: string, epoch: number): Promise<void> {
    const state = await this.refresh();
    if (!state.members.has(this.member.memberId)) refuse('member_revoked');
    const members = [...state.members.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    await this.#append('scope-policy', { scopeId, categories: ['task-input', 'task-output'], members });
    const key = generateScopeKey();
    try {
      const packages = await Promise.all(members.map(id => sealScopeKeyPackage({ scopeKey: key, tenantId: this.tenant, scopeId, epoch,
        recipient: this.#state.members.get(id)!, sender: { signingPublicJwk: this.signing.publicJwk, signingPrivateKey: this.signing.privateKey } })));
      await this.host.putScopeKeyPackages(this.tenant, { packages });
    } finally { key.fill(0); }
  }
  async revoke(memberId: string): Promise<void> {
    await this.refresh();
    await this.#append('remove', { memberId });
  }
  async #append(op: MemberChainOp, subject: Record<string, unknown>): Promise<void> {
    const head = this.#state.head;
    const entry = await signMemberChainEntry({ v: 1, tenantId: this.tenant, seq: (head?.seq ?? 0) + 1,
      prev: head?.hash ?? null, op, subject: subject as never, signer: this.member.memberId }, this.signing);
    const result = await applyMemberChainEntries(this.#state, [entry]);
    if (!result.ok) refuse(result.reason);
    await this.host.appendMemberChainEntries(this.tenant, { entries: [entry] });
    this.#state = result.state;
  }
  /** Generate the canary privately, seal C1, and return only the task id and expected canary hash. */
  async submit(template: BrowserTaskTemplate, scopeId: string, epoch: number): Promise<{ taskId: string; sha256: string }> {
    const state = await this.refresh();
    if (!state.members.has(this.member.memberId)) refuse('member_revoked');
    const policy = state.scopes.get(scopeId);
    const device = [...state.members.values()].find(member => member.deviceId === template.deviceId);
    if (!device || !policy?.members.includes(device.memberId) || !policy.members.includes(this.member.memberId)) refuse('scope_not_authorized');
    const key = await this.#scopeKey(state, scopeId, epoch);
    const taskId = crypto.randomUUID();
    const canary = `byok654browser${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    try {
      const sealing = { scopeId, epoch, categories: ['task-input', 'task-output'] as const };
      const { header, ciphertext } = await sealContent({ scopeKey: key, scope: { id: scopeId, epoch }, chainHead: state.head!,
        sender: this.member.memberId, category: 'task-input', binding: { tenantId: this.tenant, family: 'task.offer',
          direction: 'server-to-daemon', identity: { taskId }, deviceId: template.deviceId, agentRef: template.payload.agentRef,
          categories: sealing.categories, notAfter: null }, plaintext: { instruction: canary }, maxContentLength: 2 * 1024 * 1024 });
      await this.host.submitSealedAgentExecution(this.tenant, { deviceId: template.deviceId, taskId, payload: { ...template.payload,
        sealing: { ...sealing, categories: [...sealing.categories] }, sealed: { ...header, category: 'task-input',
          ciphertext: btoa(String.fromCharCode(...ciphertext)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') } } });
      return { taskId, sha256: await sha256(new TextEncoder().encode(canary)) };
    } finally { key.fill(0); }
  }
  async #scopeKey(state: MemberChainState, scopeId: string, epoch: number, keyId?: string): Promise<Uint8Array> {
    const { packages } = await this.host.readScopeKeyPackages(this.tenant, { scopeId, epoch, recipient: this.member.memberId });
    const policy = state.scopes.get(scopeId);
    const pkg = packages.find(p => (keyId === undefined || p.keyId === keyId) && state.members.has(p.sender) && policy?.members.includes(p.sender));
    if (!pkg) refuse('scope_key_missing');
    const opened = await openScopeKeyPackage({ package: pkg, expected: { tenantId: this.tenant, scopeId, epoch },
      recipient: { memberId: this.member.memberId, kemPublicJwk: this.kem.publicJwk, kemPrivateKey: this.kem.privateKey, kemEpoch: 1 },
      senderSigningPublicJwk: state.members.get(pkg.sender)!.signingPublicJwk });
    if (!opened.ok) refuse(opened.reason);
    return opened.scopeKey;
  }
  /** Fetch C3 and its exact offer binding. Return only the hash of decrypted document.text, never plaintext. */
  async decrypt(taskId: string, expectedHash: string): Promise<{ result: 'PASS'; sha256: string; chainLength: number }> {
    if (!/^[0-9a-f]{64}$/u.test(expectedHash)) refuse('expected_hash_required');
    const state = await this.refresh();
    if (!state.members.has(this.member.memberId)) refuse('member_revoked');
    const [offer, terminal] = await Promise.all([this.host.readTaskOffer(this.tenant, taskId), this.host.readDeviceTerminal(this.tenant, taskId)]);
    if (!offer || terminal?.envelope.type !== 'task.complete' || terminal.envelope.task_id !== taskId) refuse('sealed_terminal_required');
    const payload = offer.payload;
    if (!('sealing' in payload) || !payload.sealing || !payload.agentRef) refuse('sealed_offer_required');
    const wire = terminal.envelope.payload;
    if (!('sealed' in wire) || !wire.sealed) refuse('sealed_terminal_required');
    const { ciphertext, ciphertextRef, ...rawHeader } = wire.sealed;
    const header = SealedContentHeaderV1Schema.parse(rawHeader);
    const policy = state.scopes.get(header.scope.id);
    if (header.category !== 'task-output' || !policy?.members.includes(this.member.memberId)
      || !policy.members.includes(header.sender) || !state.members.has(header.sender) || state.shredded.has(header.scope.id)) refuse('scope_not_authorized');
    const chainEntry = (await this.#entries())[header.chainHead.seq - 1];
    if (!chainEntry || await chainHash(chainEntry) !== header.chainHead.hash) refuse('terminal_chain_head_invalid');
    const scopeKey = await this.#scopeKey(state, header.scope.id, header.scope.epoch, header.scope.keyId);
    try {
      const bytes = ciphertext === undefined ? await this.host.ciphertext(this.tenant, taskId)
        : Uint8Array.from(atob(ciphertext.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
      if (ciphertextRef && `sha256:${await sha256(bytes)}` !== ciphertextRef.contentHash) refuse('ciphertext_hash_invalid');
      const opened = await openSealedContent({ header, ciphertext: bytes, scopeKey,
        sealing: { scopeId: payload.sealing.scopeId, epoch: payload.sealing.epoch }, maxContentLength: 2 * 1024 * 1024,
        binding: { tenantId: this.tenant, family: 'task.complete', direction: 'daemon-to-server', identity: { taskId },
          deviceId: offer.deviceId, agentRef: payload.agentRef, categories: payload.sealing.categories, notAfter: null } });
      if (!opened.ok) refuse(opened.reason);
      const document = opened.plaintext.document;
      if (!document || typeof document !== 'object' || !('text' in document) || typeof document.text !== 'string') refuse('canary_document_required');
      const hash = await sha256(new TextEncoder().encode(document.text));
      if (hash !== expectedHash) refuse('canary_hash_mismatch');
      return { result: 'PASS', sha256: hash, chainLength: this.chainLength };
    } finally { scopeKey.fill(0); }
  }
}
