/** Local test fixture: every control-plane call and device request executes in workerd. Never deploy this RPC surface. */
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration,
  type ByokCloudObserver } from '@byok-sdk/cloud';
import { createByokPool, createPostgresCloudStores, createPostgresCoreStores, PostgresE2eeMemberStore } from '@byok-sdk/cloud-dataplane/runtime';
import { CANARY_METHODS, decodeCanaryRpc, encodeCanaryRpc } from '../../../../hosted-bot-collaboration/src/canary-cloud.test-support';

interface Env {
  BYOK_PG: { connectionString: string };
  BYOK_CANARY_STORAGE: string;
}
interface Context { waitUntil(promise: Promise<unknown>): void }
const observed: Parameters<NonNullable<ByokCloudObserver['onInboundCommitted']>>[0][] = [];
const json = (value: unknown) => new Response(encodeCanaryRpc({ value }), { headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === '/probe/observed') return json(observed);
    if (!route.startsWith('/byok/') && route !== '/probe/call') return new Response('local canary fixture', { status: 404 });
    const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString, max: 4 });
    try {
      const clock = { now: () => new Date() }, crypto = createWebCrypto();
      const objectStorage = { ...JSON.parse(env.BYOK_CANARY_STORAGE), signingClock: clock };
      const core = createPostgresCoreStores({ pool, clock, objectStorage });
      const stores = await createPostgresCloudStores({ rateLimit: { tokensPerSecond: 50, burst: 100 }, pool, clock, crypto, objectStorage });
      const full = fullCapabilityDeclaration(undefined, { includeE2eeMember: true });
      const cloud = createByokCloud({ core, cloud: stores, clock, crypto,
        mailboxWake: createInProcessMailboxWake({ fallbackMs: 100 }),
        e2eeMemberStore: new PostgresE2eeMemberStore(pool, clock),
        tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(3), clock),
        capabilities: { ...full, capabilities: full.capabilities.filter(capability => capability !== 'blobs.contentproxy') },
        observer: { onInboundCommitted(input) {
          observed.push(input);
          // A real log sink with a plaintext twin as its positive control, bounded to one short line per terminal.
          if (input.envelope.type === 'task.complete') {
            const payload = input.envelope.payload;
            console.info('canary terminal', payload.sealed === undefined ? payload.summary?.slice(0, 200) : 'sealed');
          }
        } },
      });
      if (route.startsWith('/byok/')) return await cloud.fetch(request);
      const { method, args } = decodeCanaryRpc(await request.text()) as { method: typeof CANARY_METHODS[number]; args: never[] };
      if (!CANARY_METHODS.includes(method)) return new Response('unknown canary method', { status: 404 });
      const call = cloud[method] as (...args: never[]) => unknown;
      return json(await call.apply(cloud, args));
    } catch (error) {
      console.error(error);
      return new Response(String(error), { status: 500 });
    } finally {
      ctx.waitUntil(pool.end());
    }
  },
};
