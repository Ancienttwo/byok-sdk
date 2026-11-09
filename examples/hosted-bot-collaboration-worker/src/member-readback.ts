/** Example-private ciphertext readback; the request never supplies an object id or URL. */
import type { ByokCloud, TenantId } from '@byok-sdk/cloud';
export async function readMemberCiphertext(request: Request, cloud: Pick<ByokCloud, 'readDeviceTerminal'>,
  blobs: { getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined> }, get: typeof fetch = fetch): Promise<Response> {
  const { tenant, taskId } = await request.json() as { tenant: string; taskId: string };
  const terminal = await cloud.readDeviceTerminal(tenant as TenantId, taskId);
  if (!terminal || terminal.envelope.task_id !== taskId) return new Response('sealed terminal unavailable', { status: 404 });
  const payload = terminal.envelope.payload;
  if (!('sealed' in payload) || !payload.sealed?.ciphertextRef) return new Response('sealed reference unavailable', { status: 404 });
  const url = await blobs.getDownloadUrl(tenant as TenantId, payload.sealed.ciphertextRef.blobId);
  if (!url) return new Response('ciphertext unavailable', { status: 404 });
  const response = await get(url, { redirect: 'error' });
  if (!response.ok) return new Response('ciphertext unavailable', { status: 502 });
  return new Response(response.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}

/** These two public static assets contain no credentials, tenant data or deployment configuration. */
export async function memberAsset(request: Request, assets?: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET required', { status: 405 });
  if (!assets) return new Response('member assets unavailable', { status: 503 });
  const url = URL.parse(request.url)!;
  if (url.pathname === '/member') url.pathname = '/index.html';
  const response = await assets.fetch(new Request(url, { method: request.method }));
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  return new Response(response.body, { status: response.status, headers });
}
