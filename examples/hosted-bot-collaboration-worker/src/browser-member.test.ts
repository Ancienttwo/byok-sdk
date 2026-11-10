import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokCloud, createInMemoryByokCloud, createHmacTokenSigner, fullCapabilityDeclaration,
  InMemoryE2eeMemberStore, tenantId, type DeviceTerminal, type TaskOfferReadback } from '@byok-sdk/cloud';
import { computeDevicePairingMac, createMemberKeyBundle, parsePairingInput, memberApprovalCode,
  verifyClientPairingMac, openScopeKeyPackage, openSealedContent, sealContent } from '@byok-sdk/core/sealed-payload';
import { template } from '../../host-execution-core/src/test-support';
import { BrowserMember, base64Url, memberTransport, sha256 } from './browser-member';
import { provisionEntitlement } from './operator-provision';
import { memberAsset, readMemberCiphertext } from './member-readback';
import deployable, { MEMBER_METHODS } from './fixtures/sealed-canary/deployable-worker';

const tenant = tenantId('browser-canary'), deviceId = 'device-browser', scopeId = 'browser-scope';
const summary = 'local-browser-canary-secret';
const hash = () => sha256(new TextEncoder().encode(summary));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const base = createInMemoryByokCloud();
  const store = new InMemoryE2eeMemberStore(base.stores.receipts);
  const cloud = createByokCloud({ ...base, cloud: base.stores, e2eeMemberStore: store,
    tokenSigner: createHmacTokenSigner(crypto.getRandomValues(new Uint8Array(32)), base.clock),
    capabilities: fullCapabilityDeclaration(undefined, { includeE2eeMember: true }) });
  const terminals = new Map<string, DeviceTerminal>(), offers = new Map<string, TaskOfferReadback>(), objects = new Map<string, Uint8Array>();
  const taskKey = (t: string, task: string) => `${t}/${task}`;
  const reads = {
    readTaskOffer: async (t: typeof tenant, task: string) => offers.get(taskKey(t, task)) ?? cloud.readTaskOffer(t, task),
    readDeviceTerminal: async (t: typeof tenant, task: string) => terminals.get(taskKey(t, task)),
  };
  const blobs = { getDownloadUrl: vi.fn(async (t: typeof tenant, blobId: string) => objects.has(taskKey(t, blobId)) ? `https://objects.invalid/${blobId}` : undefined) };
  const objectFetch = vi.fn(async (url: string | URL | Request) => new Response(new Uint8Array(objects.get(taskKey(tenant, String(url).split('/').at(-1)!))!)));
  // The page's actual JSON/fetch transport crosses an authenticated Host boundary; core and cloud are real implementations.
  const request: typeof fetch = async (url, init) => {
    const request = new Request(`https://canary.invalid${url}`, init);
    if (request.headers.get('authorization') !== 'Bearer local-operator') return new Response('', { status: 401 });
    if (url === '/member/ciphertext') return readMemberCiphertext(request, reads, blobs, objectFetch);
    const { method, args } = await request.json() as { method: typeof MEMBER_METHODS[number]; args: never[] };
    if (!MEMBER_METHODS.includes(method)) return new Response('unknown canary method', { status: 404 });
    const api = { ...cloud, ...reads };
    const call = api[method as keyof typeof api] as (...args: never[]) => Promise<unknown>;
    const value = await call(...args);
    return new Response(JSON.stringify({ value }, (_key, value) => typeof value === 'bigint' ? { $canaryBigint: String(value) } : value));
  };
  const transport = memberTransport('local-operator', request);
  const browser = await BrowserMember.create(tenant, transport);
  const device = await BrowserMember.create(tenant, transport);
  const bundle = await createMemberKeyBundle({ signingPublicJwk: device.signing.publicJwk, signingPrivateKey: device.signing.privateKey,
    kemPublicJwk: device.kem.publicJwk, kemEpoch: 1, deviceId });
  const pairing = parsePairingInput(await browser.start('browser-product'));
  await base.stores.devices.register(tenant, { productId: 'browser-product', deviceId, deviceName: deviceId,
    devicePublicKey: 'proof-public-key', proofKeyId: 'identity', proofKeyEpoch: 0 });
  await base.stores.devices.recordCapabilities(tenant, { deviceId, capabilities: ['sealed-payload-v1',
    'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection'] });
  await provisionEntitlement(base.core, tenant);
  async function register(mac: string) {
    await store.registerMember(tenant, { deviceId, memberId: bundle.memberId, bundle: JSON.stringify(bundle), deviceMac: mac,
      macExpiresAt: new Date(Date.now() + 600_000).toISOString(), request: { requestId: crypto.randomUUID(),
        operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 } });
  }
  await register(await computeDevicePairingMac(pairing.pv, { tenantId: tenant, deviceId, member: bundle }));
  async function paired() { await browser.verifyDevice(deviceId); await browser.confirmDevice(); }
  async function terminal(task = 'task-browser', epoch = 1, ref = false, text = summary) {
    const { packages } = await cloud.readScopeKeyPackages(tenant, { scopeId, epoch, recipient: bundle.memberId });
    const key = await openScopeKeyPackage({ package: packages[0], expected: { tenantId: tenant, scopeId, epoch },
      recipient: { memberId: bundle.memberId, kemPublicJwk: bundle.kemPublicJwk, kemPrivateKey: device.kem.privateKey, kemEpoch: 1 },
      senderSigningPublicJwk: browser.member.signingPublicJwk });
    if (!key.ok) throw new Error(key.reason);
    const { entries } = await cloud.readMemberChain(tenant);
    const { memberChainEntryHash } = await import('@byok-sdk/core/sealed-payload');
    const { sig: _sig, ...head } = entries.at(-1)!;
    const sealed = await sealContent({ scopeKey: key.scopeKey, scope: { id: scopeId, epoch },
      chainHead: { seq: head.seq, hash: await memberChainEntryHash(head as Parameters<typeof memberChainEntryHash>[0]) }, sender: bundle.memberId, category: 'task-output',
      binding: { tenantId: tenant, family: 'task.complete', direction: 'daemon-to-server', identity: { taskId: task }, deviceId,
        agentRef: { agentId: 'agent-browser', profileRevision: 'revision-browser' }, categories: ['task-input', 'task-output'], notAfter: null },
      plaintext: { summary: JSON.stringify({ text }), document: { text } }, maxContentLength: 2 * 1024 * 1024 });
    key.scopeKey.fill(0);
    const blobId = `blob-${task}`;
    objects.set(taskKey(tenant, blobId), sealed.ciphertext);
    const wire = { ...sealed.header, ...(ref ? { ciphertextRef: { blobId, contentHash: `sha256:${await sha256(sealed.ciphertext)}`, size: sealed.ciphertext.length } }
      : { ciphertext: Buffer.from(sealed.ciphertext).toString('base64url') }) };
    terminals.set(taskKey(tenant, task), { envelope: { type: 'task.complete', task_id: task,
      payload: { sealed: wire } }, recordedAt: new Date().toISOString() } as DeviceTerminal);
    offers.set(taskKey(tenant, task), { taskId: task, deviceId, payload: {
      agentRef: { agentId: 'agent-browser', profileRevision: 'revision-browser' },
      sealing: { scopeId, epoch, categories: ['task-input', 'task-output'] } } } as TaskOfferReadback);
  }
  return { browser, device, bundle, transport, cloud, store, pairing, register, paired, terminal, terminals, objects, blobs, objectFetch, reads };
}

it('builds isolated HTML and browser assets without touching operator output', () => {
  const operatorOutput = new URL('../../../_ops/p9/member-assets/', import.meta.url);
  const snapshot = () => ['index.html', 'member.js'].map(name => {
    const target = new URL(name, operatorOutput);
    return existsSync(target) ? { bytes: readFileSync(target), mtimeNs: statSync(target, { bigint: true }).mtimeNs } : null;
  });
  const before = snapshot();
  const output = mkdtempSync(join(tmpdir(), 'byok-member-build-'));
  try {
    execFileSync('bun', [fileURLToPath(new URL('./build-member.mjs', import.meta.url)), output], { stdio: 'pipe' });
    expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('<script type="module" src="/member.js"></script>');
    expect(readFileSync(join(output, 'member.js')).byteLength).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
  } finally { rmSync(output, { recursive: true, force: true }); }
  expect(existsSync(output)).toBe(false);
});

it('keeps every browser RPC method in the deployable allowlist', () => {
  const methods = Object.keys(memberTransport('local-operator')).filter(method => method !== 'ciphertext');
  expect(MEMBER_METHODS).toEqual(expect.arrayContaining(methods));
});

it.each([0, 1, 32_768, 262_144])('encodes %s ciphertext bytes in bounded base64 chunks', length => {
  const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
  expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
});

it('adds self at genesis and keeps both private keys non-extractable', async () => {
  const f = await fixture();
  const { entries } = await f.cloud.readMemberChain(tenant);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ op: 'add', signer: f.browser.member.memberId, subject: { member: f.browser.member } });
  for (const key of [f.browser.signing.privateKey, f.browser.kem.privateKey]) {
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow();
  }
  await expect(f.browser.start('browser-product')).rejects.toThrow('fresh_tenant_required');
});

it('verifies pairing in both directions and displays the same 50 digits as the device', async () => {
  const f = await fixture();
  await expect(f.browser.confirmDevice()).rejects.toThrow('compare_code_first');
  const code = await f.browser.verifyDevice(deviceId);
  expect(code.replaceAll(' ', '')).toMatch(/^\d{50}$/u);
  expect(code).toBe(await memberApprovalCode(tenant, f.bundle.signingPublicJwk, f.browser.member.signingPublicJwk));
  await f.browser.confirmDevice();
  const relay = JSON.parse((await f.store.readClientPairingMac(tenant, { deviceId, now: new Date().toISOString() }))!);
  expect(await verifyClientPairingMac(f.pairing.pv, relay, relay.mac)).toBe(true);
  expect((await f.cloud.readMemberChain(tenant)).entries).toHaveLength(2);
});

it('refuses a substituted pairing MAC before adding the device', async () => {
  const f = await fixture();
  await f.register(await computeDevicePairingMac(crypto.getRandomValues(new Uint8Array(16)), { tenantId: tenant, deviceId, member: f.bundle }));
  await expect(f.browser.verifyDevice(deviceId)).rejects.toThrow('device_pairing_mac_invalid');
  await expect(f.browser.confirmDevice()).rejects.toThrow('compare_code_first');
  expect((await f.cloud.readMemberChain(tenant)).entries).toHaveLength(1);
});

it.each([false, true])('decrypts C3 with real key packages and reports only a matching canary hash (object=%s)', async ref => {
  const f = await fixture();
  await f.paired();
  await f.browser.scope(scopeId, 1);
  await f.terminal('task-browser', 1, ref);
  const result = await f.browser.decrypt('task-browser', await hash());
  expect(result).toEqual({ result: 'PASS', sha256: await hash(), chainLength: 3 });
  expect(JSON.stringify(result)).not.toContain(summary);
  await expect(f.browser.decrypt('task-browser', '0'.repeat(64))).rejects.toThrow('canary_hash_mismatch');
  if (ref) {
    f.objects.set(`${tenant}/blob-task-browser`, new Uint8Array(272));
    await expect(f.browser.decrypt('task-browser', await hash())).rejects.toThrow('ciphertext_hash_invalid');
  }
});

it('generates and submits private C1, then opens the echoed C3 using only the returned task id and hash', async () => {
  const f = await fixture();
  await f.paired(); await f.browser.scope(scopeId, 1);
  const { payload: { instruction: _instruction, ...payload }, ...routing } = template(deviceId, 'agent-browser');
  const result = await f.browser.submit({ ...routing, payload: { ...payload, terminalProjection: payload.terminalProjection! } }, scopeId, 1);
  const offer = (await f.cloud.readTaskOffer(tenant, result.taskId))!;
  const { packages } = await f.cloud.readScopeKeyPackages(tenant, { scopeId, epoch: 1, recipient: f.bundle.memberId });
  const key = await openScopeKeyPackage({ package: packages[0], expected: { tenantId: tenant, scopeId, epoch: 1 },
    recipient: { memberId: f.bundle.memberId, kemPublicJwk: f.bundle.kemPublicJwk, kemPrivateKey: f.device.kem.privateKey, kemEpoch: 1 },
    senderSigningPublicJwk: f.browser.member.signingPublicJwk });
  if (!key.ok || !('sealed' in offer.payload) || !offer.payload.sealed?.ciphertext) throw new Error('sealed C1 missing');
  const { ciphertext, ciphertextRef: _ref, ...header } = offer.payload.sealed;
  const opened = await openSealedContent({ header, ciphertext: Buffer.from(ciphertext, 'base64url'), scopeKey: key.scopeKey,
    sealing: { scopeId, epoch: 1 }, maxContentLength: 2 * 1024 * 1024,
    binding: { tenantId: tenant, family: 'task.offer', direction: 'server-to-daemon', identity: { taskId: result.taskId }, deviceId,
      agentRef: payload.agentRef, categories: ['task-input', 'task-output'], notAfter: null } });
  if (!opened.ok || typeof opened.plaintext.instruction !== 'string') throw new Error('device could not open C1');
  const canary = opened.plaintext.instruction;
  expect(result.sha256).toBe(await sha256(new TextEncoder().encode(canary)));
  expect(JSON.stringify(result)).not.toContain(canary);
  expect(JSON.stringify(offer)).not.toContain(canary);
  await f.terminal(result.taskId, 1, true, canary);
  expect((await f.browser.decrypt(result.taskId, result.sha256)).result).toBe('PASS');
  key.scopeKey.fill(0);
});

it('removes one tab, rotates the scope, refuses its next decrypt and lets the remaining tab decrypt', async () => {
  const f = await fixture();
  await f.paired();
  const other = await BrowserMember.create(tenant, f.transport);
  expect(await f.browser.compareBrowser(other.member)).toBe(await other.compareBrowser(f.browser.member));
  await f.browser.confirmBrowser();
  await other.join(f.browser.member);
  await f.browser.scope(scopeId, 1);
  await f.terminal();
  expect((await other.decrypt('task-browser', await hash())).result).toBe('PASS');
  await f.browser.revoke(other.member.memberId);
  await expect(other.decrypt('task-browser', await hash())).rejects.toThrow('member_revoked_scope_key_present');
  await f.browser.scope(scopeId, 2);
  await f.terminal('task-after-remove', 2, true);
  await expect(other.decrypt('task-after-remove', await hash())).rejects.toMatchObject({ message: 'member_revoked', scopeKey: 'absent' });
  expect((await f.browser.decrypt('task-after-remove', await hash())).result).toBe('PASS');
  expect((await f.cloud.readScopeKeyPackages(tenant, { scopeId, epoch: 2, recipient: other.member.memberId })).packages).toEqual([]);
});

it('rejects a chain rollback and a wrong approver before decrypting', async () => {
  const f = await fixture();
  await f.paired();
  const newcomer = await BrowserMember.create(tenant, f.transport);
  await expect(newcomer.join(f.browser.member)).rejects.toThrow('compare_approver_first');
  const rollback = vi.spyOn(f.transport, 'readMemberChain').mockResolvedValue({ entries: [] });
  await expect(f.browser.decrypt('task-browser', await hash())).rejects.toThrow('chain_anchor_invalid');
  rollback.mockRestore();
});

it('refuses another tenant or task ciphertext and ignores caller-supplied blob ids and URLs', async () => {
  const f = await fixture();
  await f.paired(); await f.browser.scope(scopeId, 1); await f.terminal('task-browser', 1, true);
  for (const [t, task] of [['other-tenant', 'task-browser'], [tenant, 'other-task']]) {
    const response = await readMemberCiphertext(new Request('https://canary.invalid/member/ciphertext', { method: 'POST',
      body: JSON.stringify({ tenant: t, taskId: task, blobId: 'blob-task-browser', url: 'https://objects.invalid/blob-task-browser' }) }), f.reads, f.blobs, f.objectFetch);
    expect(response.status).toBe(404);
  }
  expect(f.blobs.getDownloadUrl).not.toHaveBeenCalled();
  expect(f.objectFetch).not.toHaveBeenCalled();
});

it.each(['/member', '/member.js'])('exempts only GET and HEAD from bearer authentication on %s', async path => {
  const assets = { fetch: vi.fn(async (_request: Request) => new Response('static asset')) };
  const env = { ASSETS: assets, HOST_ADMIN_TOKEN: 'local-operator', BYOK_PG: { connectionString: 'unused' }, BYOK_CANARY_STORAGE: '{}' };
  const ctx = { waitUntil: vi.fn() };
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const authorized of [false, true]) {
      const headers = new Headers(authorized ? { authorization: 'Bearer local-operator' } : undefined);
      const response = await deployable.fetch(new Request(`https://canary.invalid${path}`, { method, headers }), env, ctx);
      const isRead = method === 'GET' || method === 'HEAD';
      expect(response.status, `${method} ${path} authorized=${authorized}`).toBe(isRead ? 200 : authorized ? 405 : 401);
    }
  }
  expect(assets.fetch).toHaveBeenCalledTimes(4);
  expect(ctx.waitUntil).not.toHaveBeenCalled();
});

it('serves secret-free assets publicly while all member APIs require the operator bearer', async () => {
  const assets = { fetch: vi.fn(async (_request: Request) => new Response('<html>static member</html>', { headers: { 'content-type': 'text/html' } })) };
  const env = { ASSETS: assets, HOST_ADMIN_TOKEN: 'local-operator', BYOK_PG: { connectionString: 'unused' }, BYOK_CANARY_STORAGE: '{}' };
  const ctx = { waitUntil: vi.fn() };
  const page = await deployable.fetch(new Request('https://canary.invalid/member'), env, ctx);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).not.toContain('local-operator');
  expect(assets.fetch.mock.calls[0]![0].url).toBe('https://canary.invalid/index.html');
  expect((await memberAsset(new Request('https://canary.invalid/member', { method: 'POST' }), assets)).status).toBe(405);
  expect((await memberAsset(new Request('https://canary.invalid/member'))).status).toBe(503);
  for (const path of ['/probe/call', '/member/ciphertext']) {
    expect((await deployable.fetch(new Request(`https://canary.invalid${path}`), env, ctx)).status).toBe(401);
  }
});
