import { ByokKeysError } from './errors.js';
import { providerHeaders, requiredProviderSecret } from './headers.js';
import { fetchWithProviderGuards, isProviderTransportError, objectValue, parseBoundedJsonResponseWithReadError, PROVIDER_TIMEOUT_MS, type ProviderFetch } from './http.js';
import type { ProviderAuthMode } from './provider-profile.js';
import { normalizeProviderUrl } from './url.js';

export interface ModelDiscoveryConnection {
  adapter: 'openai_compatible' | 'anthropic';
  auth_mode: ProviderAuthMode;
  base_url: string;
}

export interface DiscoveredModel { id: string; name: string }

const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

export async function discoverProviderModels(
  connection: ModelDiscoveryConnection,
  secret: string | undefined,
  fetchImpl: ProviderFetch = fetch,
): Promise<DiscoveredModel[]> {
  const base = URL.parse(normalizeProviderUrl(connection.base_url));
  if (base === null) throw new ByokKeysError('PROVIDER_URL_INVALID', 'Provider URL is not valid');
  base.pathname = base.pathname.replace(/\/$/u, '') + '/models';
  const auth = { kind: 'model', auth_mode: connection.auth_mode };
  const headers = providerHeaders(auth, requiredProviderSecret(auth, secret));
  if (connection.adapter === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  let afterId: string | undefined;
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      const target = new URL(base);
      if (afterId !== undefined) target.searchParams.set('after_id', afterId);
      response = await fetchWithProviderGuards((_url, init) => fetchImpl(target.href, init), base.href,
        { method: 'GET', headers, redirect: 'error' }, signal);
    } catch (error) {
      throw mapModelListTransportError(error);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'MODEL_LIST_AUTH_FAILED'
        : response.status === 404 || response.status === 405 ? 'MODEL_LIST_UNSUPPORTED' : 'MODEL_LIST_HTTP_ERROR';
      throw new ByokKeysError(code, `Model list request failed (HTTP ${response.status})`, { httpStatus: response.status });
    }
    let body: unknown;
    try {
      body = await parseBoundedJsonResponseWithReadError(response, mapModelListTransportError);
    } catch (error) {
      if (error instanceof ByokKeysError && error.code === 'PROVIDER_RESPONSE_INVALID') {
        throw new ByokKeysError('MODEL_LIST_INVALID_RESPONSE', 'Invalid model list response', { cause: error });
      }
      throw error;
    }
    const payload = objectValue(body);
    if (!Array.isArray(payload?.data) || payload.data.length > MAX_MODELS) {
      throw new ByokKeysError('MODEL_LIST_INVALID_RESPONSE', 'Invalid model list response');
    }
    for (const item of payload.data) {
      const model = objectValue(item);
      if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 256 || /[\u0000-\u001f\u007f]/u.test(model.id)) {
        throw new ByokKeysError('MODEL_LIST_INVALID_IDENTIFIER', 'Invalid model identifier');
      }
      const id = model.id.trim();
      const label = typeof model.display_name === 'string' ? model.display_name : model.name;
      models.set(id, { id, name: typeof label === 'string' && label.length <= 256 ? label : id });
      if (models.size > MAX_MODELS) throw new ByokKeysError('MODEL_LIST_INVALID_RESPONSE', 'Model list is too large');
    }
    if (connection.adapter === 'openai_compatible' || payload.has_more !== true) {
      return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    const cursor = payload.last_id;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 256 || cursors.has(cursor)) {
      throw new ByokKeysError('MODEL_LIST_INVALID_PAGINATION', 'Invalid model list pagination');
    }
    cursors.add(cursor);
    afterId = cursor;
  }
  throw new ByokKeysError('MODEL_LIST_INVALID_PAGINATION', 'Model list has too many pages');
}

function mapModelListTransportError(error: unknown) {
  return isProviderTransportError(error)
    ? new ByokKeysError('MODEL_LIST_UNREACHABLE', 'Model list provider is unreachable', { cause: error })
    : error;
}
