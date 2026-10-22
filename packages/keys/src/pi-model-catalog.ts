import type { ModelProviderAdapter } from './provider-profile';
import { PI_MODEL_CATALOG } from './pi-model-catalog.generated';
import {
  PI_COMPAT_KEYS_BY_API,
  PI_MODEL_APIS,
  PI_THINKING_LEVELS,
  PiModelConfigSchema,
  piCompatIssues,
  piSupportedThinkingLevels,
  type PiModelApi,
  type PiModelConfig,
  type PiThinkingLevel,
} from './pi-model-config';

export { PI_MODEL_CATALOG_PI_AI_VERSION } from './pi-model-catalog.generated';

/** The input modalities a Pi catalog entry declares; a profile states `image` as the `image-input` capability. */
export type PiCatalogModelInput = 'text' | 'image';

/** A catalog entry that `PiModelConfig` expresses exactly, without the launch-time thinking level. */
export interface PiCatalogModelEntry {
  readonly config: Omit<PiModelConfig, 'thinkingLevel'>;
  readonly input: readonly PiCatalogModelInput[];
}

/** A catalog entry that `PiModelConfig` cannot express, with every field path that blocks it. */
export interface PiCatalogUnrepresentableEntry {
  readonly unrepresentable: readonly string[];
}

/** Vendor id → Pi api → model id → entry. Generated; see `pi-model-catalog.generated.ts`. */
export type PiModelCatalogTable = Readonly<Record<string, Readonly<Partial<Record<PiModelApi,
  Readonly<Record<string, PiCatalogModelEntry | PiCatalogUnrepresentableEntry>>>>>>>;

export interface PiCatalogSelection {
  /** A `MODEL_PROVIDER_VENDORS` id, which is also the pi-ai provider id. */
  readonly provider: string;
  readonly api: PiModelApi;
  readonly model: string;
  /** The launch thinking level. The catalog has none, and this package invents no default. */
  readonly thinkingLevel: PiThinkingLevel;
}

export type PiCatalogLookup =
  | { readonly ok: true; readonly config: PiModelConfig; readonly input: readonly PiCatalogModelInput[] }
  | { readonly ok: false; readonly reason: 'not_in_catalog' }
  | { readonly ok: false; readonly reason: 'unrepresentable'; readonly fields: readonly string[] }
  | { readonly ok: false; readonly reason: 'thinking_level_unsupported'; readonly supported: readonly PiThinkingLevel[] };

/**
 * The `pi_model` for one entry of the pinned pi-ai catalog.
 *
 * The table is generated from the pi-ai version `@byok-sdk/client` pins
 * ({@link PI_MODEL_CATALOG_PI_AI_VERSION}); nothing is read at run time. An
 * entry is either expressed exactly or refused with the field paths that
 * `PiModelConfig` cannot carry. Identity, endpoint and cost fields are not
 * part of `pi_model` and never cause a refusal; `input` is returned for the
 * profile's `image-input` capability.
 */
export function piModelConfigFromPinnedCatalog(selection: PiCatalogSelection): PiCatalogLookup {
  const entry = ownEntry(selection);
  if (entry === undefined) return { ok: false, reason: 'not_in_catalog' };
  if ('unrepresentable' in entry) return { ok: false, reason: 'unrepresentable', fields: entry.unrepresentable };
  const supported = piSupportedThinkingLevels(entry.config);
  if (!supported.includes(selection.thinkingLevel)) return { ok: false, reason: 'thinking_level_unsupported', supported };
  return {
    ok: true,
    config: PiModelConfigSchema.parse({ ...entry.config, thinkingLevel: selection.thinkingLevel }),
    input: entry.input,
  };
}

function ownEntry(selection: PiCatalogSelection): PiCatalogModelEntry | PiCatalogUnrepresentableEntry | undefined {
  if (!Object.hasOwn(PI_MODEL_CATALOG, selection.provider)) return undefined;
  const byApi = PI_MODEL_CATALOG[selection.provider]!;
  if (!(PI_MODEL_APIS as readonly string[]).includes(selection.api) || !Object.hasOwn(byApi, selection.api)) return undefined;
  const models = byApi[selection.api]!;
  return Object.hasOwn(models, selection.model) ? models[selection.model] : undefined;
}

/** Pi model fields that `pi_model` does not carry by design: identity and endpoint come from the profile, cost is not projected. */
const PI_CATALOG_PROFILE_FIELDS: readonly string[] = ['id', 'name', 'provider', 'api', 'baseUrl', 'cost', 'type'];
/** Pi model fields that map onto `pi_model` or onto the returned `input`. */
const PI_CATALOG_CONFIG_FIELDS: readonly string[] = [
  'reasoning', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat', 'inputLimits', 'input',
];

/**
 * Classify one pi-ai built-in chat model for the vendor adapter that serves it.
 *
 * The generator calls this for every catalog entry. Admission is the same
 * `PiModelConfigSchema` a profile is parsed with, plus the exact compat set of
 * the entry's own api. Any Pi field this package does not know is refused, so
 * a new pi-ai field never passes silently.
 */
export function classifyPiCatalogModel(
  model: Readonly<Record<string, unknown>>,
  adapter: ModelProviderAdapter,
): PiCatalogModelEntry | PiCatalogUnrepresentableEntry {
  const api = model.api as PiModelApi;
  const fields = new Set<string>();
  if ((adapter === 'anthropic') !== (api === 'anthropic-messages')) fields.add('api');
  for (const key of Object.keys(model)) {
    if (!PI_CATALOG_PROFILE_FIELDS.includes(key) && !PI_CATALOG_CONFIG_FIELDS.includes(key)) fields.add(key);
  }
  const compat = isRecord(model.compat) ? model.compat : {};
  for (const issue of piCompatIssues(compat, PI_COMPAT_KEYS_BY_API[api] ?? [], api)) fields.add(issue.path.join('.'));
  const input = Array.isArray(model.input) ? model.input : [];
  if (input.length === 0 || input.some((modality) => modality !== 'text' && modality !== 'image')) fields.add('input');

  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : undefined;
  const thinkingLevel = model.reasoning === true
    ? PI_THINKING_LEVELS.find((level) => map?.[level] !== null) ?? 'off'
    : 'off';
  const parsed = PiModelConfigSchema.safeParse({
    ...(api === 'openai-responses' ? { api } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevel,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    compat,
    ...(model.inputLimits === undefined ? {} : { inputLimits: model.inputLimits }),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // No level is selectable when every mapped level is null; the map is what blocks it.
      const path = issue.path[0] === 'thinkingLevel' ? ['thinkingLevelMap'] : issue.path.map(String);
      if (issue.code === 'unrecognized_keys') for (const key of issue.keys) fields.add([...path, key].join('.'));
      else fields.add(path.join('.'));
    }
  }
  if (fields.size > 0 || !parsed.success) return { unrepresentable: [...fields].sort() };
  const { thinkingLevel: _, ...config } = parsed.data;
  return { config, input: input as PiCatalogModelInput[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
