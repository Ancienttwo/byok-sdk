import { assertAgyGeminiBaseUrl } from './agy-profile';

/**
 * TODO(#1469): agy has no credential path yet, so an adapter refuses every
 * task. The local proxy will supply this address when a session opens.
 */
const AGY_ENDPOINTS = new WeakMap<object, string>();

export function agyEndpointOf(adapter: object): string | undefined {
  return AGY_ENDPOINTS.get(adapter);
}

/** Internal, unreachable from any public entry: `adapter` calls `geminiBaseUrl`, which owns the credential. Only tests use it. */
export function agyAdapterWithEndpoint<T extends object>(adapter: T, geminiBaseUrl: string): T {
  assertAgyGeminiBaseUrl(geminiBaseUrl, 'geminiBaseUrl');
  AGY_ENDPOINTS.set(adapter, geminiBaseUrl);
  return adapter;
}
