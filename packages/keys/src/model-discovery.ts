import { ByokKeysError } from './errors.js';
import { providerHeaders, requiredProviderSecret } from './headers.js';
import { fetchWithProviderGuards, isProviderTransportError, objectValue, parseBoundedJsonResponse, PROVIDER_TIMEOUT_MS, type ProviderFetch } from './http.js';
import type { ModelProviderKind, ProviderAuthMode } from './provider-profile.js';
import { normalizeProviderUrl } from './url.js';

export interface ModelDiscoveryConnection {
  adapter: 'openai_compatible' | 'anthropic';
  authMode: ProviderAuthMode;
  baseUrl: string;
  providerKind: ModelProviderKind;
}

export interface DiscoveredModel { id: string; name: string }

const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

export async function discoverProviderModels(
  connection: ModelDiscoveryConnection,
  secret: string | undefined,
  fetchImpl: ProviderFetch = fetch,
): Promise<DiscoveredModel[]> {
  const base = new URL(normalizeProviderUrl(connection.baseUrl));
  base.pathname = base.pathname.replace(/\/$/u, '') + '/models';
  const auth = { kind: 'model', auth_mode: connection.authMode };
  const headers = providerHeaders(auth, requiredProviderSecret(auth, secret));
  if (connection.adapter === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  let afterId: string | undefined;
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageFetch: ProviderFetch = (url, init) => {
      const target = new URL(String(url));
      if (afterId !== undefined) target.searchParams.set('after_id', afterId);
      return fetchImpl(target.href, init);
    };
    let response: Response;
    try {
      response = await fetchWithProviderGuards(pageFetch, base.href,
        { method: 'GET', headers, redirect: 'error' }, signal);
    } catch (error) {
      if (isProviderTransportError(error)) {
        throw new ByokKeysError('MODEL_LIST_UNREACHABLE', 'Model list provider is unreachable', { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'MODEL_LIST_AUTH_FAILED'
        : response.status === 404 || response.status === 405 ? 'MODEL_LIST_UNSUPPORTED' : 'MODEL_LIST_HTTP_ERROR';
      throw new ByokKeysError(code, `Model list request failed (HTTP ${response.status})`, { httpStatus: response.status });
    }
    let body: unknown;
    try {
      body = await parseBoundedJsonResponse(response);
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
