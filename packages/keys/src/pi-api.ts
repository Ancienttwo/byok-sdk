import type { PiModelApi, PiOpenAICompatibleApi } from './pi-model-config.js';
import type { ModelProviderAdapter } from './provider-profile.js';

/**
 * The Pi wire API a profile projects, the one derivation the route, profile
 * validation, the catalog and the launcher projection share. An `anthropic`
 * adapter projects `anthropic-messages` and declares no api; any other
 * adapter projects its declared api, `openai-completions` when absent.
 * `undefined` means an `anthropic` adapter declared an api, which a profile
 * refuses.
 */
export function piApiOf(adapter: ModelProviderAdapter, declared?: undefined): PiModelApi;
export function piApiOf(adapter: ModelProviderAdapter, declared: PiOpenAICompatibleApi | undefined): PiModelApi | undefined;
export function piApiOf(adapter: ModelProviderAdapter, declared: PiOpenAICompatibleApi | undefined): PiModelApi | undefined {
  if (adapter === 'anthropic') return declared === undefined ? 'anthropic-messages' : undefined;
  return declared ?? 'openai-completions';
}
