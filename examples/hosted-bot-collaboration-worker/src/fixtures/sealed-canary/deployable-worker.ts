/** Owner-deployed, disposable canary. The example-private RPC requires the operator bearer. */
import { timingSafeEqual, createHash } from 'node:crypto';
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration,
  type ByokCloudObserver } from '@byok-sdk/cloud';
import { createByokPool, createPostgresCloudStores, createPostgresCoreStores, PostgresE2eeMemberStore, PostgresProofReceiptRetentionAuthority } from '@byok-sdk/cloud-dataplane/runtime';
import { memberAsset, readMemberCiphertext } from '../../member-readback';
import { CANARY_METHODS, decodeCanaryRpc, encodeCanaryRpc } from '../../../../hosted-bot-collaboration/src/canary-cloud.test-support';

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  BYOK_PG: { connectionString: string };
  BYOK_CANARY_STORAGE: string;
  HOST_ADMIN_TOKEN?: string;
  /** Exactly 32 bytes, encoded as 64 lowercase hex characters. */
  BYOK_TOKEN_SECRET?: string;
}
interface Context { waitUntil(promise: Promise<unknown>): void }
const json = (value: unknown) => new Response(encodeCanaryRpc({ value }), { headers: { 'content-type': 'application/json' } });
const MEMBER_METHODS = [...CANARY_METHODS, 'readMemberChain', 'readScopeKeyPackages'] as const;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Log only routing metadata and a digest: neither plain payloads nor credentials reach the tail. */
const observer: ByokCloudObserver = { onInboundCommitted({ envelope }) {
  console.info('canary observer', JSON.stringify({ type: envelope.type, taskId: envelope.task_id,
    payloadSha256: digest(encodeCanaryRpc(envelope.payload)).toString('hex') }));
} };

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === '/member' || route === '/member.js') return memberAsset(request, env.ASSETS);
    if (!route.startsWith('/byok/')) {
      if (!env.HOST_ADMIN_TOKEN) return new Response('operator secret unavailable', { status: 503 });
      const expected = digest(`Bearer ${env.HOST_ADMIN_TOKEN}`);
      const supplied = digest(request.headers.get('authorization') ?? '');
      if (!timingSafeEqual(expected, supplied)) return new Response('unauthorized', { status: 401 });
    }
    if (!env.BYOK_TOKEN_SECRET || !/^[0-9a-f]{64}$/u.test(env.BYOK_TOKEN_SECRET)) {
      return new Response('token key unavailable', { status: 503 });
    }
    if (!route.startsWith('/byok/') && route !== '/probe/call' && route !== '/member/ciphertext') return new Response('unknown canary route', { status: 404 });
    if ((route === '/probe/call' || route === '/member/ciphertext') && request.method !== 'POST') return new Response('POST required', { status: 405 });
    const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString, max: 4 });
    try {
      const clock = { now: () => new Date() }, crypto = createWebCrypto();
      const objectStorage = { ...JSON.parse(env.BYOK_CANARY_STORAGE), signingClock: clock };
      const core = createPostgresCoreStores({ pool, clock, objectStorage });
      const stores = await createPostgresCloudStores({ rateLimit: { tokensPerSecond: 50, burst: 100 }, pool, clock, crypto, objectStorage });
      const full = fullCapabilityDeclaration(undefined, { includeE2eeMember: true });
      const cloud = createByokCloud({ proofReceiptRetention: { authority: new PostgresProofReceiptRetentionAuthority(pool) }, core, cloud: stores, clock, crypto,
        mailboxWake: createInProcessMailboxWake({ fallbackMs: 100 }), e2eeMemberStore: new PostgresE2eeMemberStore(pool, clock),
        tokenSigner: createHmacTokenSigner(Uint8Array.from(env.BYOK_TOKEN_SECRET.match(/../gu)!, byte => parseInt(byte, 16)), clock),
        capabilities: { ...full, capabilities: full.capabilities.filter(capability => capability !== 'blobs.contentproxy') }, observer });
      if (route.startsWith('/byok/')) return await cloud.fetch(request);
      if (route === '/member/ciphertext') return await readMemberCiphertext(request, cloud, stores.blobs);
      const { method, args } = decodeCanaryRpc(await request.text()) as { method: typeof MEMBER_METHODS[number]; args: never[] };
      if (!MEMBER_METHODS.includes(method)) return new Response('unknown canary method', { status: 404 });
      const call = cloud[method] as (...args: never[]) => unknown;
      return json(await call.apply(cloud, args));
    } catch {
      // Exception messages may contain input or connection strings. Emit only a fixed diagnostic.
      console.error('canary request failed');
      return new Response('canary request failed', { status: 500 });
    } finally {
      ctx.waitUntil(pool.end());
    }
  },
};
