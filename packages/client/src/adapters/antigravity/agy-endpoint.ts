import { assertAgyGeminiBaseUrl } from './agy-profile.js';

const AGY_ENDPOINTS = new WeakMap<object, string>();

export function agyEndpointOf(adapter: object): string | undefined {
  return AGY_ENDPOINTS.get(adapter);
}

/** Internal, unreachable from any public entry: only tests replace the origin the local Gemini proxy forwards to. */
export function agyAdapterWithEndpoint<T extends object>(adapter: T, upstreamOrigin: string): T {
  assertAgyGeminiBaseUrl(upstreamOrigin, 'upstreamOrigin');
  AGY_ENDPOINTS.set(adapter, upstreamOrigin);
  return adapter;
}
