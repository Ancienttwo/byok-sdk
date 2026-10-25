import { describe, expect, it } from 'vitest';
import {
  MODEL_PROVIDER_VENDORS,
  PI_DEFAULT_THINKING_LEVEL,
  PI_THINKING_LEVELS,
  applyModelRouteChange,
  createModelRouteDraft,
  listPiCatalogModels,
  modelRouteContext,
  modelRouteSubmission,
  modelRouteView,
  providerSecretReusable,
  validateModelRoute,
  type ModelRouteChange,
  type ModelRouteContext,
  type ModelRouteDraft,
  type ModelRouteHostEntry,
  type ModelRoutePolicy,
  type ModelRouteStoredProfile,
  type PiModelCatalogTable,
} from './model-route';
import { ModelProviderProfileSchema } from './provider-profile';

const GROQ_URL = MODEL_PROVIDER_VENDORS.groq.base_url;

function apply(context: ModelRouteContext, ...changes: ModelRouteChange[]): ModelRouteDraft {
  return changes.reduce((draft, change) => applyModelRouteChange(draft, change, context), createModelRouteDraft(context));
}

function named(context: ModelRouteContext, ...changes: ModelRouteChange[]): ModelRouteDraft {
  return apply(context,
    { field: 'profile_ref', value: 'main' },
    { field: 'display_name', value: 'Main' },
    ...changes);
}

function field(draft: ModelRouteDraft, context: ModelRouteContext, name: string) {
  return modelRouteView(draft, context).fields.find((view) => view.field === name)!;
}

function stored(profile: Partial<ModelRouteStoredProfile['profile']> = {}, secret_configured = true): ModelRouteStoredProfile {
  return {
    profile: {
      profile_ref: 'main',
      display_name: 'Main',
      provider_kind: 'groq',
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: GROQ_URL,
      model: 'openai/gpt-oss-120b',
      capabilities: [],
      ...profile,
    },
    secret_configured,
  };
}

/** Parse a submission the way the device does after it adds the persisted fields. */
function persisted(draft: ModelRouteDraft, context: ModelRouteContext) {
  const submission = modelRouteSubmission(draft, context);
  if (!submission.ok) throw new Error(JSON.stringify(submission.errors));
  const at = '2026-10-26T00:00:00.000Z';
  return { profile: ModelProviderProfileSchema.parse({ ...submission.profile, enabled: true, created_at: at, updated_at: at }), secret: submission.secret };
}

const SYNTHETIC_CONFIG = { contextWindow: 1000, maxTokens: 100, reasoning: true, compat: {} };
const SYNTHETIC: PiModelCatalogTable = {
  groq: {
    'openai-completions': {
      both: { config: SYNTHETIC_CONFIG, input: ['text'] },
      vision: { config: { ...SYNTHETIC_CONFIG, reasoning: false }, input: ['text', 'image'] },
      blocked: { unrepresentable: ['compat.sendSessionAffinityHeaders'] },
    },
    'openai-responses': {
      both: { config: { ...SYNTHETIC_CONFIG, api: 'openai-responses' }, input: ['text'] },
    },
  },
};

describe('catalog view', () => {
  it('lists pinned entries with their classification, input, reasoning and thinking levels', () => {
    const groq = listPiCatalogModels({ provider: 'groq', api: 'openai-completions' });
    expect(groq.find((entry) => entry.model === 'llama-3.3-70b-versatile')).toEqual({
      model: 'llama-3.3-70b-versatile', api: 'openai-completions', status: 'representable',
      input: ['text'], reasoning: false, thinking_levels: ['off'],
    });
    expect(groq.find((entry) => entry.model === 'openai/gpt-oss-120b')).toMatchObject({
      status: 'representable', reasoning: true, thinking_levels: ['low', 'medium', 'high'],
    });
    expect(listPiCatalogModels({ provider: 'zai' }).find((entry) => entry.model === 'glm-4.7')).toMatchObject({
      api: 'openai-completions', status: 'representable', thinking_levels: ['off', 'minimal', 'low', 'medium', 'high'],
    });
    expect(listPiCatalogModels({ provider: 'groq', api: 'anthropic-messages' })).toEqual([]);
    expect(listPiCatalogModels({ provider: 'custom' })).toEqual([]);
  });

  it('names an unrepresentable entry with the paths that block it', () => {
    const context: ModelRouteContext = { catalog: SYNTHETIC, stored: null, policy: {} };
    const draft = named(context, { field: 'provider_kind', value: 'groq' });
    const choices = field(draft, context, 'model').choices!;
    expect(choices.map((choice) => [choice.value, (choice as { api: string }).api])).toEqual([
      ['blocked', 'openai-completions'], ['both', 'openai-completions'], ['vision', 'openai-completions'],
      ['both', 'openai-responses'],
    ]);
    expect(choices[0]).toMatchObject({ status: 'unrepresentable', unrepresentable: ['compat.sendSessionAffinityHeaders'], source: 'catalog' });
  });

  it("exports Pi's default thinking level as one of Pi's levels", () => {
    expect(PI_THINKING_LEVELS).toContain(PI_DEFAULT_THINKING_LEVEL);
  });
});

describe('linkage', () => {
  const context = modelRouteContext();

  it('fills adapter, auth mode and base URL from a vendor and resets the model', () => {
    const draft = named(context,
      { field: 'provider_kind', value: 'groq' },
      { field: 'model', value: 'openai/gpt-oss-120b' },
      { field: 'provider_kind', value: 'zai' });
    expect(draft).toMatchObject({
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: MODEL_PROVIDER_VENDORS.zai.base_url,
      model: '', model_source: null, thinking_level: null, pi_model: null,
    });
  });

  it('gives custom no defaults unless the Host policy supplies them', () => {
    const bare = named(context, { field: 'provider_kind', value: 'custom' });
    expect(bare).toMatchObject({ adapter: null, auth_mode: null, base_url: '' });
    expect(validateModelRoute(bare, context)).toMatchObject({
      adapter: { code: 'required' }, auth_mode: { code: 'required' }, base_url: { code: 'required' },
    });
    const policy = modelRouteContext({ policy: { custom_defaults: { adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://localhost:11434/v1' } } });
    expect(named(policy, { field: 'provider_kind', value: 'custom' })).toMatchObject({
      adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://localhost:11434/v1', secret: 'none',
    });
  });

  it('narrows auth modes by adapter and resets an illegal one', () => {
    const draft = named(context,
      { field: 'provider_kind', value: 'custom' },
      { field: 'adapter', value: 'anthropic' },
      { field: 'auth_mode', value: 'x_api_key' });
    expect(field(draft, context, 'auth_mode').choices).toEqual([{ value: 'x_api_key', label: null }]);
    const switched = applyModelRouteChange(draft, { field: 'adapter', value: 'openai_compatible' }, context);
    expect(switched.auth_mode).toBeNull();
    expect(field(switched, context, 'auth_mode').choices!.map((choice) => choice.value)).toEqual(['bearer', 'none']);
  });

  it('reports adapter rules with the profile schema codes', () => {
    const draft = named(context, { field: 'provider_kind', value: 'groq' }, { field: 'adapter', value: 'anthropic' });
    expect(draft.auth_mode).toBeNull();
    const forced = { ...draft, auth_mode: 'bearer' as const };
    expect(validateModelRoute(forced, context)).toMatchObject({
      adapter: { code: 'vendor_adapter_mismatch' }, auth_mode: { code: 'adapter_auth_mismatch' },
    });
  });

  it('hides the secret for auth none and restores a stored key afterwards', () => {
    const withStored = modelRouteContext({ stored: stored() });
    const draft = applyModelRouteChange(createModelRouteDraft(withStored), { field: 'auth_mode', value: 'none' }, withStored);
    expect(draft.secret).toBe('none');
    expect(field(draft, withStored, 'secret').visible).toBe(false);
    const back = applyModelRouteChange(draft, { field: 'auth_mode', value: 'bearer' }, withStored);
    expect(back.secret).toBe('keep');
  });

  it("selects Pi's default level only when the model supports it", () => {
    const supported = named(context, { field: 'provider_kind', value: 'groq' }, { field: 'model', value: 'openai/gpt-oss-120b' });
    expect(supported).toMatchObject({ model_source: 'catalog', model_api: 'openai-completions', thinking_level: PI_DEFAULT_THINKING_LEVEL });
    const offOnly = applyModelRouteChange(supported, { field: 'model', value: 'llama-3.3-70b-versatile' }, context);
    expect(offOnly.thinking_level).toBeNull();
    expect(field(offOnly, context, 'thinking_level')).toMatchObject({
      visible: true, required: true, choices: [{ value: 'off', label: null }], error: { code: 'required' },
    });
    const unsupported = applyModelRouteChange(offOnly, { field: 'thinking_level', value: 'high' }, context);
    expect(validateModelRoute(unsupported, context).thinking_level).toEqual({ code: 'thinking_level_unsupported' });
  });

  it('sends an unrepresentable or unknown model to manual pi_model', () => {
    const synthetic: ModelRouteContext = { catalog: SYNTHETIC, stored: null, policy: {} };
    const blocked = named(synthetic, { field: 'provider_kind', value: 'groq' }, { field: 'model', value: 'blocked' });
    expect(blocked).toMatchObject({ model_source: 'manual', pi_model: null, thinking_level: null });
    expect(validateModelRoute(blocked, synthetic).pi_model).toEqual({ code: 'pi_model_required' });
    const unknown = applyModelRouteChange(blocked, { field: 'model', value: 'not-listed' }, synthetic);
    expect(unknown.model_source).toBe('manual');
    const invalid = applyModelRouteChange(unknown, { field: 'pi_model', value: { ...SYNTHETIC_CONFIG, compat: { foo: true } } }, synthetic);
    expect(invalid.thinking_level).toBe(PI_DEFAULT_THINKING_LEVEL);
    expect(validateModelRoute(invalid, synthetic).pi_model).toEqual({ code: 'pi_model_invalid', paths: ['compat.foo'] });
    const levelInside = applyModelRouteChange(unknown, { field: 'pi_model', value: { ...SYNTHETIC_CONFIG, thinkingLevel: 'low' } }, synthetic);
    expect(validateModelRoute(levelInside, synthetic).pi_model).toEqual({ code: 'pi_model_invalid', paths: ['thinkingLevel'] });
  });

  it('applies the adapter compat rule to a manual pi_model', () => {
    const draft = named(context,
      { field: 'provider_kind', value: 'custom' },
      { field: 'adapter', value: 'openai_compatible' },
      { field: 'auth_mode', value: 'none' },
      { field: 'base_url', value: 'http://localhost:8080/v1' },
      { field: 'model', value: 'local' },
      { field: 'pi_model', value: { ...SYNTHETIC_CONFIG, compat: { forceAdaptiveThinking: true } } });
    expect(validateModelRoute(draft, context).pi_model).toEqual({ code: 'pi_model_invalid', paths: ['compat.forceAdaptiveThinking'] });
  });

  it('needs an api when a model id is in more than one api', () => {
    const synthetic: ModelRouteContext = { catalog: SYNTHETIC, stored: null, policy: {} };
    const ambiguous = named(synthetic, { field: 'provider_kind', value: 'groq' }, { field: 'model', value: 'both' });
    expect(ambiguous.model_source).toBeNull();
    expect(validateModelRoute(ambiguous, synthetic).model).toEqual({ code: 'not_a_choice' });
    const chosen = applyModelRouteChange(ambiguous, { field: 'model', value: 'both', api: 'openai-responses' }, synthetic);
    expect(chosen).toMatchObject({ model_source: 'catalog', model_api: 'openai-responses' });
    const done = applyModelRouteChange(chosen, { field: 'secret', value: { replace: 'k' } }, synthetic);
    expect(persisted(done, synthetic).profile.pi_model).toMatchObject({ api: 'openai-responses', thinkingLevel: 'medium' });
  });

  it('derives capabilities from the catalog input', () => {
    const synthetic: ModelRouteContext = { catalog: SYNTHETIC, stored: null, policy: {} };
    const draft = named(synthetic,
      { field: 'provider_kind', value: 'groq' },
      { field: 'model', value: 'vision' },
      { field: 'thinking_level', value: 'off' },
      { field: 'secret', value: { replace: 'k' } });
    expect(field(draft, synthetic, 'capabilities').visible).toBe(false);
    expect(persisted(draft, synthetic).profile.capabilities).toEqual(['image-input']);
  });
});

describe('catalog entries apply only at the vendor base URL (D6)', () => {
  const context = modelRouteContext();

  it('keeps a catalog entry for an equivalent URL and drops it for another endpoint', () => {
    const draft = named(context, { field: 'provider_kind', value: 'groq' }, { field: 'model', value: 'openai/gpt-oss-120b' });
    const slash = applyModelRouteChange(draft, { field: 'base_url', value: `${GROQ_URL}/` }, context);
    expect(slash.model_source).toBe('catalog');
    expect(modelRouteView(slash, context).catalog_applies).toBe(true);
    const gateway = applyModelRouteChange(draft, { field: 'base_url', value: 'https://gateway.example.com/v1' }, context);
    expect(gateway).toMatchObject({ model: 'openai/gpt-oss-120b', model_source: 'manual', pi_model: null, thinking_level: null });
    const view = modelRouteView(gateway, context);
    expect(view.catalog_applies).toBe(false);
    expect(field(gateway, context, 'model').choices).toEqual([]);
    const reselected = applyModelRouteChange(gateway, { field: 'model', value: 'llama-3.3-70b-versatile' }, context);
    expect(reselected.model_source).toBe('manual');
  });
});

describe('secret', () => {
  it('keeps a stored key only while the identity is unchanged', () => {
    const context = modelRouteContext({ stored: stored() });
    const draft = createModelRouteDraft(context);
    expect(draft.secret).toBe('keep');
    expect(validateModelRoute(draft, context).secret).toBeUndefined();
    const sameUrl = applyModelRouteChange(draft, { field: 'base_url', value: 'https://API.GROQ.COM/openai/v1/' }, context);
    expect(validateModelRoute(sameUrl, context).secret).toBeUndefined();
    for (const change of [
      { field: 'profile_ref', value: 'other' },
      { field: 'base_url', value: 'https://api.groq.com/openai/v2' },
      { field: 'provider_kind', value: 'cerebras' },
    ] as ModelRouteChange[]) {
      expect(validateModelRoute(applyModelRouteChange(draft, change, context), context).secret)
        .toEqual({ code: 'secret_reentry_required' });
    }
    const replaced = applyModelRouteChange(
      applyModelRouteChange(draft, { field: 'profile_ref', value: 'other' }, context),
      { field: 'secret', value: { replace: 'new-key' } }, context);
    expect(validateModelRoute(replaced, context).secret).toBeUndefined();
  });

  it('reports an invalid URL on base_url, not as a secret re-entry', () => {
    const context = modelRouteContext({ stored: stored() });
    const draft = applyModelRouteChange(createModelRouteDraft(context), { field: 'base_url', value: 'http://api.groq.com' }, context);
    const errors = validateModelRoute(draft, context);
    expect(errors.base_url).toEqual({ code: 'invalid_url' });
    expect(errors.secret).toBeUndefined();
  });

  it('compares identity with normalized URLs and fails closed on an invalid one', () => {
    const identity = { profile_ref: 'main', provider_kind: 'groq', adapter: 'openai_compatible', auth_mode: 'bearer', base_url: GROQ_URL };
    expect(providerSecretReusable(identity, { ...identity, base_url: `${GROQ_URL}/` })).toBe(true);
    expect(providerSecretReusable(identity, { ...identity, auth_mode: 'none' })).toBe(false);
    expect(providerSecretReusable({ ...identity, base_url: 'nope' }, { ...identity, base_url: 'nope' })).toBe(false);
  });

  it('applies the shared secret shape and size rules to a new key', () => {
    const context = modelRouteContext();
    const draft = named(context, { field: 'provider_kind', value: 'groq' });
    const code = (value: ModelRouteDraft['secret']) =>
      validateModelRoute(applyModelRouteChange(draft, { field: 'secret', value }, context), context).secret;
    expect(code('none')).toEqual({ code: 'secret_required' });
    expect(code('keep')).toEqual({ code: 'secret_required' });
    expect(code({ replace: '  ' })).toEqual({ code: 'secret_required' });
    expect(code({ replace: 'a\nb' })).toEqual({ code: 'secret_invalid' });
    expect(code({ replace: 'x'.repeat(2561) })).toEqual({ code: 'secret_invalid' });
    expect(code({ replace: 'x'.repeat(2560) })).toBeUndefined();
  });

  it('never puts a new key in a view, and keeps it out of the profile', () => {
    const context = modelRouteContext();
    const draft = named(context,
      { field: 'provider_kind', value: 'groq' },
      { field: 'model', value: 'openai/gpt-oss-120b' },
      { field: 'secret', value: { replace: 'sk-write-only-123' } });
    const view = modelRouteView(draft, context);
    expect(JSON.stringify(view)).not.toContain('sk-write-only-123');
    expect(field(draft, context, 'secret').value).toBe('replace');
    const submission = modelRouteSubmission(draft, context);
    expect(submission.ok && JSON.stringify(submission.profile)).not.toContain('sk-write-only-123');
    expect(submission.ok && submission.secret).toEqual({ replace: 'sk-write-only-123' });
  });
});

describe('stored profile', () => {
  it('recognizes a stored catalog pi_model and keeps any other as manual', () => {
    const context = modelRouteContext();
    const fresh = named(context,
      { field: 'provider_kind', value: 'groq' },
      { field: 'model', value: 'openai/gpt-oss-120b' },
      { field: 'thinking_level', value: 'high' },
      { field: 'secret', value: { replace: 'k' } });
    const { profile } = persisted(fresh, context);
    const reopened = modelRouteContext({ stored: { profile, secret_configured: true } });
    expect(createModelRouteDraft(reopened)).toMatchObject({
      model_source: 'catalog', model_api: 'openai-completions', pi_model: null, thinking_level: 'high', secret: 'keep',
    });
    const edited = { ...profile, pi_model: { ...profile.pi_model!, maxTokens: 1000 } };
    const manual = createModelRouteDraft(modelRouteContext({ stored: { profile: edited, secret_configured: true } }));
    expect(manual).toMatchObject({ model_source: 'manual', thinking_level: 'high' });
    expect(manual.pi_model).toMatchObject({ maxTokens: 1000 });
    expect(manual.pi_model).not.toHaveProperty('thinkingLevel');
  });
});

describe('Host policy', () => {
  const override = {
    provider_kind: 'groq' as const, api: 'openai-completions' as const, model: 'openai/gpt-oss-120b',
    config: { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { supportsStrictMode: true } },
    input: ['text' as const],
  };
  const policy: ModelRoutePolicy = {
    vendors: ['groq', 'custom'],
    models: { groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'] },
    vendor_labels: { custom: 'Self-hosted' },
    model_labels: { groq: { 'llama-3.3-70b-versatile': 'Llama 3.3' } },
    default_vendor: 'groq',
    default_models: { groq: 'openai/gpt-oss-120b' },
    overrides: [override],
  };
  const context = modelRouteContext({ policy });

  it('limits and labels choices, and starts from the default selection', () => {
    const draft = createModelRouteDraft(context);
    expect(draft).toMatchObject({ provider_kind: 'groq', model: 'openai/gpt-oss-120b', model_source: 'host' });
    expect(field(draft, context, 'provider_kind').choices).toEqual([
      { value: 'groq', label: 'Groq' }, { value: 'custom', label: 'Self-hosted' },
    ]);
    const models = field(draft, context, 'model').choices!;
    expect(models.map((choice) => [choice.value, choice.label, (choice as { source: string }).source])).toEqual([
      ['llama-3.3-70b-versatile', 'Llama 3.3', 'catalog'], ['openai/gpt-oss-120b', null, 'host'],
    ]);
    expect(validateModelRoute(applyModelRouteChange(draft, { field: 'provider_kind', value: 'zai' }, context), context).provider_kind)
      .toEqual({ code: 'not_a_choice' });
    const other = applyModelRouteChange(draft, { field: 'model', value: 'qwen/qwen3.8-27b' }, context);
    expect(other.model_source).toBeNull();
    expect(validateModelRoute(other, context).model).toEqual({ code: 'not_a_choice' });
  });

  it('submits a Host entry with the selected thinking level', () => {
    const draft = applyModelRouteChange(
      applyModelRouteChange(createModelRouteDraft(context), { field: 'profile_ref', value: 'main' }, context),
      { field: 'display_name', value: 'Main' }, context);
    const done = applyModelRouteChange(draft, { field: 'secret', value: { replace: 'k' } }, context);
    expect(persisted(done, context).profile.pi_model).toEqual({ ...override.config, thinkingLevel: 'medium' });
  });

  it('offers an invalid Host entry as unrepresentable and never applies it', () => {
    const invalid = modelRouteContext({ policy: { overrides: [{ ...override, config: { ...override.config, maxTokens: 0 } }] } });
    const draft = named(invalid, { field: 'provider_kind', value: 'groq' });
    const choice = field(draft, invalid, 'model').choices!.find((entry) => entry.value === override.model);
    expect(choice).toMatchObject({ source: 'host', status: 'unrepresentable', unrepresentable: ['maxTokens'] });
    expect(applyModelRouteChange(draft, { field: 'model', value: override.model }, invalid).model_source).toBe('manual');
  });
});

describe('acceptance review fixes', () => {
  const houseConfig = { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: {} };
  const entry = (overrides: Partial<ModelRouteHostEntry>): ModelRouteHostEntry => ({
    provider_kind: 'openai', api: 'openai-responses', model: 'house', config: houseConfig, input: ['text'], ...overrides,
  });

  /** A submission the device accepts carries the api and model the page showed. */
  function assertDeviceAccepts(draft: ModelRouteDraft, context: ModelRouteContext): void {
    const { profile } = persisted(draft, context);
    expect(profile.model).toBe(draft.model);
    const projected = profile.adapter === 'anthropic' ? 'anthropic-messages' : profile.pi_model?.api ?? 'openai-completions';
    if (draft.model_api !== null) expect(projected).toBe(draft.model_api);
  }

  it('1: offers a Host entry as unrepresentable when its config projects another api', () => {
    const context = modelRouteContext({ policy: { overrides: [entry({})] } });
    const draft = named(context, { field: 'provider_kind', value: 'openai' });
    const choice = field(draft, context, 'model').choices!.find((option) => option.value === 'house');
    expect(choice).toMatchObject({ source: 'host', status: 'unrepresentable', unrepresentable: ['api'] });
    const selected = applyModelRouteChange(draft, { field: 'model', value: 'house', api: 'openai-responses' }, context);
    expect(selected.model_source).toBe('manual');
  });

  it('1: submits a Host entry whose config projects its own api, and the device stores that api', () => {
    const context = modelRouteContext({ policy: { overrides: [entry({ config: { ...houseConfig, api: 'openai-responses' } })] } });
    const draft = named(context,
      { field: 'provider_kind', value: 'openai' },
      { field: 'model', value: 'house', api: 'openai-responses' },
      { field: 'thinking_level', value: 'off' },
      { field: 'secret', value: { replace: 'k' } });
    expect(draft).toMatchObject({ model_source: 'host', model_api: 'openai-responses' });
    assertDeviceAccepts(draft, context);
    expect(persisted(draft, context).profile.pi_model?.api).toBe('openai-responses');
  });

  it('2: refuses an unlisted model from a stored profile', () => {
    const policy: ModelRoutePolicy = { vendors: ['groq'], models: { groq: ['openai/gpt-oss-120b'] } };
    const context = modelRouteContext({ policy, stored: stored({
      model: 'some-other-model',
      pi_model: { contextWindow: 1000, maxTokens: 100, reasoning: false, compat: {}, thinkingLevel: 'off' },
    }) });
    const draft = createModelRouteDraft(context);
    expect(draft.model_source).toBe('manual');
    expect(validateModelRoute(draft, context).model).toEqual({ code: 'not_a_choice' });
    expect(modelRouteSubmission(draft, context).ok).toBe(false);
  });

  it('2: validates a listed model the same way in either edit order', () => {
    const context = modelRouteContext({ policy: { vendors: ['groq'], models: { groq: ['openai/gpt-oss-120b'] } } });
    const gateway: ModelRouteChange = { field: 'base_url', value: 'https://gw.example.com/v1' };
    const listed: ModelRouteChange = { field: 'model', value: 'openai/gpt-oss-120b' };
    const urlFirst = named(context, { field: 'provider_kind', value: 'groq' }, gateway, listed);
    const modelFirst = named(context, { field: 'provider_kind', value: 'groq' }, listed, gateway);
    expect(urlFirst).toEqual(modelFirst);
    expect(urlFirst.model_source).toBe('manual');
    expect(validateModelRoute(urlFirst, context)).toEqual(validateModelRoute(modelFirst, context));
    expect(validateModelRoute(urlFirst, context).model).toBeUndefined();
    const unlisted = applyModelRouteChange(urlFirst, { field: 'model', value: 'other' }, context);
    expect(validateModelRoute(unlisted, context).model).toEqual({ code: 'not_a_choice' });
  });

  it('1: refuses a declared api on a Host entry for an anthropic vendor', () => {
    const context = modelRouteContext({ policy: { overrides: [entry({
      provider_kind: 'minimax', api: 'anthropic-messages', config: { ...houseConfig, api: 'openai-completions' },
    })] } });
    const draft = named(context, { field: 'provider_kind', value: 'minimax' });
    expect(field(draft, context, 'model').choices!.find((option) => option.value === 'house'))
      .toMatchObject({ status: 'unrepresentable', unrepresentable: ['api'] });
  });
});

describe('submission', () => {
  it('returns errors instead of a payload for an invalid draft', () => {
    const context = modelRouteContext();
    expect(modelRouteSubmission(createModelRouteDraft(context), context)).toEqual({
      ok: false,
      errors: { profile_ref: { code: 'required' }, display_name: { code: 'required' }, provider_kind: { code: 'required' } },
    });
  });

  it('produces a profile that the profile schema accepts, for every route source', () => {
    const context = modelRouteContext();
    const catalog = named(context,
      { field: 'provider_kind', value: 'zai' },
      { field: 'model', value: 'glm-4.7' },
      { field: 'secret', value: { replace: 'k' } });
    expect(persisted(catalog, context).profile).toMatchObject({ provider_kind: 'zai', model: 'glm-4.7', pi_model: { thinkingLevel: 'medium' } });
    const manual = named(context,
      { field: 'provider_kind', value: 'custom' },
      { field: 'adapter', value: 'anthropic' },
      { field: 'auth_mode', value: 'x_api_key' },
      { field: 'base_url', value: 'https://llm.example.com/v1/' },
      { field: 'model', value: 'house-model' },
      { field: 'pi_model', value: { contextWindow: 200000, maxTokens: 8192, reasoning: false, compat: {} } },
      { field: 'thinking_level', value: 'off' },
      { field: 'capabilities', value: ['image-input'] },
      { field: 'secret', value: { replace: 'k' } });
    const saved = persisted(manual, context);
    expect(saved.profile).toMatchObject({ base_url: 'https://llm.example.com/v1', capabilities: ['image-input'], pi_model: { thinkingLevel: 'off' } });
    expect(saved.secret).toEqual({ replace: 'k' });
  });
});
