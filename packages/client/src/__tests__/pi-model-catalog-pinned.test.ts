import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { CompatSchemasByApi } from '@earendil-works/pi-ai/providers/compat-schema';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import clientManifest from '../../package.json' with { type: 'json' };
// Relative and test-only: the release graph keeps `@byok-sdk/keys` and the
// dispatch packages disjoint, and keys has no pi-ai dependency. This is the
// one place both the pinned pi-ai and the keys table are importable.
import { PI_MODEL_CATALOG_FILE, pinnedPiAi, renderPiModelCatalog } from '../../../../scripts/keys/generate-pi-model-catalog';
import { PI_MODEL_CATALOG, PI_MODEL_CATALOG_PI_AI_VERSION } from '../../../keys/src/pi-model-catalog.generated';
import { piModelConfigFromPinnedCatalog } from '../../../keys/src/pi-model-catalog';
import {
  PI_COMPAT_KEYS_BY_API, PI_MODEL_APIS, PI_THINKING_LEVELS, piSupportedThinkingLevels, type PiModelApi,
} from '../../../keys/src/pi-model-config';
import { buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { MODEL_PROVIDER_VENDORS, type ModelProviderVendorId } from '../../../keys/src/provider-catalog';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';

type PiModel = Record<string, unknown> & { id: string; api: string };

/** Every pinned chat model of a keys vendor, under an api a profile projects. */
function pinnedModels(): { provider: ModelProviderVendorId; model: PiModel }[] {
  return (Object.keys(MODEL_PROVIDER_VENDORS) as ModelProviderVendorId[]).flatMap((provider) =>
    (getBuiltinModels(provider as never) as unknown as PiModel[])
      .filter((model) => (PI_MODEL_APIS as readonly string[]).includes(model.api))
      .map((model) => ({ provider, model })));
}

describe('keys Pi model catalog against the pinned pi-ai', () => {
  it('is generated from the pi-ai the client pins, with no drift', async () => {
    expect(PI_MODEL_CATALOG_PI_AI_VERSION).toBe(clientManifest.byok.piRuntimePin);
    expect(PI_MODEL_CATALOG_PI_AI_VERSION).toBe(clientManifest.dependencies['@earendil-works/pi-ai']);
    // A Windows checkout may convert the file to CRLF; only the content is compared.
    expect(readFileSync(PI_MODEL_CATALOG_FILE, 'utf8').replaceAll('\r\n', '\n')).toBe(await renderPiModelCatalog());
  });

  it("admits each compat key only under a Pi api whose compat schema declares it", () => {
    for (const api of PI_MODEL_APIS) {
      const declared = CompatSchemasByApi[api].properties as Record<string, { type?: string }>;
      expect([api, PI_COMPAT_KEYS_BY_API[api].filter((key) => !Object.hasOwn(declared, key))]).toEqual([api, []]);
    }
    // The two keys added for the OpenRouter, Vercel AI Gateway and Baseten entries.
    for (const api of ['openai-completions', 'anthropic-messages'] as const) {
      expect(CompatSchemasByApi[api].properties.sendSessionAffinityHeaders.type).toBe('boolean');
    }
    expect(CompatSchemasByApi['anthropic-messages'].properties.allowEmptySignature.type).toBe('boolean');
    expect(Object.hasOwn(CompatSchemasByApi['openai-responses'].properties, 'sendSessionAffinityHeaders')).toBe(false);
    expect(Object.hasOwn(CompatSchemasByApi['openai-completions'].properties, 'allowEmptySignature')).toBe(false);
  });

  it("mirrors Pi's thinking levels", () => {
    expect(PI_THINKING_LEVELS).toEqual(MODEL_THINKING_LEVELS);
  });

  it('has exactly one entry per pinned model', () => {
    const pinned = pinnedModels().map(({ provider, model }) => `${provider}/${model.api}/${model.id}`).sort();
    const table = Object.entries(PI_MODEL_CATALOG).flatMap(([provider, byApi]) =>
      Object.entries(byApi).flatMap(([api, models]) => Object.keys(models!).map((id) => `${provider}/${api}/${id}`))).sort();
    expect(table).toEqual(pinned);
  });

  it('projects every representable entry to the pinned Pi model, field by field', () => {
    let representable = 0;
    for (const { provider, model } of pinnedModels()) {
      const vendor = MODEL_PROVIDER_VENDORS[provider];
      const levels = PI_THINKING_LEVELS.map((thinkingLevel) => piModelConfigFromPinnedCatalog({
        provider, api: model.api as PiModelApi, model: model.id, thinkingLevel,
      }));
      const accepted = levels.find((result) => result.ok);
      if (accepted === undefined) {
        const refusal = levels[0]!;
        if (refusal.ok || refusal.reason !== 'unrepresentable') throw new Error(`${provider}/${model.id}: ${JSON.stringify(refusal)}`);
        // Each refused path starts at the vendor api or at a field the pinned model declares.
        for (const field of refusal.fields) {
          const head = field.split('.')[0]!;
          const named = head === 'api' || Object.hasOwn(model, head);
          expect([provider, model.id, field, named]).toEqual([provider, model.id, field, true]);
        }
        continue;
      }
      representable += 1;
      const profile = parseModelProviderProfile({
        adapter: vendor.adapter, auth_mode: vendor.auth_mode, base_url: vendor.base_url,
        capabilities: accepted.input.includes('image') ? ['image-input'] : [],
        created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z',
        display_name: String(model.name), enabled: true, kind: 'model', model: model.id,
        profile_ref: 'catalog-parity', provider_kind: provider, pi_model: accepted.config,
      });
      const projected = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-catalog-parity'];
      const entry = projected.models[0];
      expect([provider, model.id, projected.api]).toEqual([provider, model.id, model.api]);
      const fields = ['id', 'name', 'input', 'reasoning', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat', 'inputLimits'];
      const pick = (source: Record<string, unknown>) => Object.fromEntries(fields.map((field) => [field, source[field] ?? null]));
      // The projected name is the profile display_name, which the profile schema trims
      // (pi-ai 1.4.0 openrouter google/gemma-4-26b-a4b-it carries a trailing space).
      expect({ provider, ...pick(entry) }).toEqual({ provider, ...pick({ compat: {}, ...model, name: String(model.name).trim() }) });
    }
    // Cerebras, Z.AI GLM, MiniMax and the other entries; a pi-ai upgrade that empties this set is a regression.
    expect(representable).toBeGreaterThan(0);
  });

  it('accepts exactly the thinking levels Pi offers for each representable entry', () => {
    let compared = 0;
    for (const { provider, model } of pinnedModels()) {
      const accepted = PI_THINKING_LEVELS.filter((thinkingLevel) => piModelConfigFromPinnedCatalog({
        provider, api: model.api as PiModelApi, model: model.id, thinkingLevel,
      }).ok);
      if (accepted.length === 0) continue;
      compared += 1;
      expect([provider, model.id, accepted]).toEqual([provider, model.id, getSupportedThinkingLevels(model as never)]);
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("restates Pi's supported-level rule for every map shape the schema admits", () => {
    const everyLevel = Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, level]));
    const maps = [
      undefined,
      everyLevel,
      Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, null])),
      { ...everyLevel, off: null, xhigh: null, max: 'max' },
    ];
    for (const reasoning of [true, false]) {
      for (const thinkingLevelMap of maps) {
        const config = { reasoning, ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }) };
        expect([config, piSupportedThinkingLevels(config as never)])
          .toEqual([config, getSupportedThinkingLevels(config as never)]);
      }
    }
  });
});

/**
 * How a Pi branch on the provider id behaves for a projected profile, whose
 * Pi provider id is `byok-sdk-<ref>` rather than the catalog vendor id.
 * - `url`: the branch also matches the base URL, and every catalog vendor it
 *   names has a base_url that matches, so it behaves as for the built-in provider.
 * - `unreachable`: a byok projection never takes this branch differently
 *   (no such vendor, an api the vendor does not project, or an explicit key).
 * - `differs`: a representable entry behaves differently from the built-in
 *   provider. Present before pi_model gained these compat keys; not fixed here.
 */
type PiProviderBranch = readonly [file: string, line: string, kind: 'url' | 'unreachable' | 'differs', reason: string];

const COPILOT = 'github-copilot is not a catalog vendor';
const OPENCODE_GO = 'opencode-go is not a catalog vendor';

/** Every pinned pi-ai line that branches on a provider id, reviewed against pi-ai 1.4.0. */
const REVIEWED_PI_PROVIDER_BRANCHES: readonly PiProviderBranch[] = [
  ['api/anthropic-messages.js', 'const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");', 'url', 'openrouter base_url contains openrouter.ai'],
  ['api/anthropic-messages.js', 'if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers))', 'unreachable', 'federation runs only without a key; a byok launch always supplies one'],
  ['api/anthropic-messages.js', 'if (model.provider === "github-copilot") {', 'unreachable', COPILOT],
  ['api/anthropic-messages.js', 'if (model.provider === "github-copilot") {', 'unreachable', COPILOT],
  ['api/openai-completions.js', 'const thinkingSignature = model.provider === "opencode-go" && foundReasoningField === "reasoning"', 'unreachable', OPENCODE_GO],
  ['api/openai-completions.js', 'if (model.provider === "github-copilot") {', 'unreachable', COPILOT],
  ['api/openai-completions.js', 'if (model.provider === "openai")', 'unreachable', 'the openai vendor projects openai-responses only'],
  ['api/openai-completions.js', 'if (model.provider === "opencode-go" && signature === "reasoning") {', 'unreachable', OPENCODE_GO],
  ['api/openai-completions.js', 'const isZai = provider === "zai" ||', 'url', 'zai base_url contains api.z.ai'],
  ['api/openai-completions.js', 'provider === "zai-coding-cn" ||', 'url', 'zai-coding-cn base_url contains open.bigmodel.cn'],
  ['api/openai-completions.js', 'const isTogether = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");', 'url', 'together base_url contains api.together.ai'],
  ['api/openai-completions.js', 'const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");', 'url', 'both moonshot base_urls contain api.moonshot.'],
  ['api/openai-completions.js', 'const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");', 'url', 'openrouter base_url contains openrouter.ai'],
  ['api/openai-completions.js', 'const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");', 'unreachable', 'cloudflare-workers-ai is not a catalog vendor'],
  ['api/openai-completions.js', 'const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");', 'unreachable', 'cloudflare-ai-gateway is not a catalog vendor'],
  ['api/openai-completions.js', 'const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");', 'url', 'nvidia base_url contains integrate.api.nvidia.com'],
  ['api/openai-completions.js', 'const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");', 'url', 'ant-ling base_url contains api.ant-ling.com'],
  ['api/openai-completions.js', 'const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");', 'url', 'cerebras base_url contains cerebras.ai'],
  ['api/openai-completions.js', 'const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");', 'url', 'deepseek base_url contains deepseek.com'],
  ['api/openai-completions.js', 'provider === "xai" ||', 'url', 'the next operand matches api.x.ai, which the xai base_url contains'],
  ['api/openai-completions.js', 'provider === "opencode" ||', 'unreachable', 'opencode is not a catalog vendor'],
  ['api/openai-completions.js', 'const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");', 'url', 'xai base_url contains api.x.ai'],
  ['api/openai-completions.js', 'const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;', 'differs',
    'no URL branch; every OpenRouter anthropic/* completions entry is unrepresentable (keys pi-model-catalog.test.ts guards each row)'],
  ['api/openai-responses-shared.js', 'if (!allowedToolCallProviders.has(model.provider))', 'differs',
    'a provider outside {openai, openai-codex, opencode} flattens callId|itemId tool call ids; affects the representable openai rows'],
  ['api/openai-responses.js', 'return (model.provider === "openai" &&', 'unreachable', 'ChatGPT sign-in needs provider "openai" and a non-sk- key; a byok id is never "openai"'],
  ['api/openai-responses.js', 'return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";', 'url', 'openrouter base_url contains openrouter.ai'],
  ['api/openai-responses.js', 'const errorMessage = formatProviderError(normalizeProviderError(error), `${model.provider === "openai" ? "OpenAI" : model.provider} API error`);', 'differs',
    'error text prefix only'],
  ['api/openai-responses.js', 'if (model.provider === "github-copilot") {', 'unreachable', COPILOT],
  ['api/openai-responses.js', 'else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {', 'unreachable',
    'a byok id takes the same non-copilot branch as every catalog vendor'],
  ['api/openai-responses.js', 'if (model.provider === "xai")', 'differs',
    'xai adds include reasoning.encrypted_content with thinking off; grok-4.3 supports off (effort none), so its request differs there; effect unverified'],
  ['api/typesafe-system-one.js', 'detectCompat: (model) => model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")', 'url', 'not a projected api; matches by URL regardless'],
  ['compat.js', 'if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {', 'unreachable', 'no cloudflare-* catalog vendor'],
  ['compat.js', 'if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {', 'unreachable', 'no cloudflare-* catalog vendor'],
  ['env-api-keys.js', 'if (provider === "github-copilot") {', 'unreachable', 'environment key lookup; byok passes the key explicitly'],
  ['env-api-keys.js', 'if (provider === "anthropic") {', 'unreachable', 'environment key lookup; byok passes the key explicitly'],
  ['env-api-keys.js', 'const apiKeyEnv = provider === "anthropic" ? envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV) : envKeys[0];', 'unreachable',
    'environment key lookup; byok passes the key explicitly'],
  ['env-api-keys.js', 'if (provider === "google-vertex") {', 'unreachable', 'environment key lookup; byok passes the key explicitly'],
  ['env-api-keys.js', 'if (provider === "amazon-bedrock") {', 'unreachable', 'environment key lookup; byok passes the key explicitly'],
  ['utils/identity.js', 'return target.provider === "openrouter" || target.baseUrl.includes("openrouter.ai");', 'url', 'openrouter base_url contains openrouter.ai'],
  ['utils/identity.js', 'return target.provider === "nvidia" || matchesHost(target.baseUrl, NVIDIA_NIM_HOST);', 'url', 'nvidia base_url host is integrate.api.nvidia.com'],
  ['utils/identity.js', 'return (target.provider === "opencode" || target.provider === "opencode-go" || matchesHost(target.baseUrl, OPENCODE_HOST));', 'unreachable',
    'opencode vendors are not in the catalog'],
  ['utils/overflow.js', 'if (message.provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message.errorMessage)) {', 'differs',
    'bodyless context overflow is not recognised for the representable cerebras rows'],
];

const PI_PROVIDER_BRANCH = /provider (===|!==) ?"|provider\.startsWith|\.has\((model\.)?provider\)/u;

describe('pinned pi-ai branches on the provider id', () => {
  it('match the reviewed list, so a pi-ai upgrade that adds or changes one is reviewed again', () => {
    const dist = path.join(pinnedPiAi().root, 'dist');
    const files = (readdirSync(dist, { recursive: true }) as string[]).filter((file) => file.endsWith('.js'));
    const found = files.flatMap((file) => readFileSync(path.join(dist, file), 'utf8').split('\n')
      .filter((line) => PI_PROVIDER_BRANCH.test(line))
      .map((line) => `${file.replaceAll('\\', '/')}: ${line.trim()}`));
    const reviewed = REVIEWED_PI_PROVIDER_BRANCHES.map(([file, line]) => `${file}: ${line}`);
    expect(found.sort(), 'review each new or changed branch for a byok-sdk-<ref> provider id and update the list')
      .toEqual(reviewed.sort());
  });
});
