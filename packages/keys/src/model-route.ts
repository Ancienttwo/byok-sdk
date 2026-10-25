import { PI_MODEL_CATALOG } from './pi-model-catalog.generated';
import type { PiCatalogModelInput, PiModelCatalogTable } from './pi-model-catalog';
import {
  PI_MODEL_APIS,
  PiModelConfigSchema,
  piSupportedThinkingLevels,
  type PiModelApi,
  type PiModelConfig,
  type PiThinkingLevel,
} from './pi-model-config';
import { PI_DEFAULT_THINKING_LEVEL } from './pi-runtime-defaults.generated';
import {
  MODEL_PROVIDER_VENDOR_IDS,
  modelProviderVendor,
  type ModelProviderVendorId,
} from './provider-catalog';
import {
  MODEL_PROVIDER_ADAPTERS,
  ModelProviderProfileSchema,
  PROVIDER_MODEL_CAPABILITIES,
  providerAuthModesForAdapter,
  providerProfileRouteIssues,
  type ModelProviderAdapter,
  type ModelProviderKind,
  type ModelProviderProfile,
  type ModelProviderProfileInput,
  type ProviderAuthMode,
  type ProviderModelCapability,
} from './provider-profile';
import { PROVIDER_PROVISIONING_SECRET_MAX_BYTES, isSharedSecretValue } from './secret-value';
import { normalizeProviderUrl } from './url';

/** The draft fields, in the order a Host renders them. */
export const MODEL_ROUTE_FIELDS = [
  'profile_ref', 'display_name', 'provider_kind', 'adapter', 'auth_mode', 'base_url',
  'model', 'pi_model', 'thinking_level', 'capabilities', 'secret',
] as const;
export type ModelRouteField = (typeof MODEL_ROUTE_FIELDS)[number];

/** Field error codes. The Host maps each code to its own copy. */
export const MODEL_ROUTE_ERROR_CODES = [
  'required', 'invalid_value', 'invalid_url', 'not_a_choice', 'adapter_auth_mismatch',
  'vendor_adapter_mismatch', 'pi_model_required', 'pi_model_invalid', 'thinking_level_unsupported',
  'secret_required', 'secret_reentry_required', 'secret_invalid',
] as const;
export type ModelRouteErrorCode = (typeof MODEL_ROUTE_ERROR_CODES)[number];

export interface ModelRouteFieldError {
  readonly code: ModelRouteErrorCode;
  /** For `pi_model_invalid`: the refused paths, relative to `pi_model`. */
  readonly paths?: readonly string[];
}

export type ModelRouteErrors = Readonly<Partial<Record<ModelRouteField, ModelRouteFieldError>>>;

/**
 * `keep` reuses the stored key, `none` sends no key, `replace` carries a new
 * key. The new key is write-only: no view returns it.
 */
export type ModelRouteSecret = 'keep' | 'none' | { readonly replace: string };

/** Where `pi_model` comes from: the pinned catalog, the Host policy, or the user. */
export type ModelRouteModelSource = 'catalog' | 'host' | 'manual';

export interface ModelRouteDraft {
  readonly profile_ref: string;
  readonly display_name: string;
  readonly provider_kind: ModelProviderKind | null;
  readonly adapter: ModelProviderAdapter | null;
  readonly auth_mode: ProviderAuthMode | null;
  readonly base_url: string;
  readonly model: string;
  /** The Pi api of the selected catalog or Host entry; `null` otherwise. */
  readonly model_api: PiModelApi | null;
  /** `null` while no model is chosen, or when the model is not a choice. */
  readonly model_source: ModelRouteModelSource | null;
  /** The user's `pi_model` without `thinkingLevel`; set only for `manual`. */
  readonly pi_model: unknown;
  /** The only place the thinking level is set; submission writes it into `pi_model`. */
  readonly thinking_level: PiThinkingLevel | null;
  /** Edited for `manual` only; catalog and Host entries derive it from their input. */
  readonly capabilities: readonly ProviderModelCapability[];
  readonly secret: ModelRouteSecret;
}

/** The public state of a stored profile, as the device reports it. It never carries the secret. */
export interface ModelRouteStoredProfile {
  readonly profile: Pick<ModelProviderProfile, 'profile_ref' | 'display_name' | 'provider_kind' | 'adapter'
    | 'auth_mode' | 'base_url' | 'model' | 'capabilities' | 'pi_model'>;
  readonly secret_configured: boolean;
}

/** A Host's own `pi_model` for one vendor model. It must still pass `PiModelConfigSchema`. */
export interface ModelRouteHostEntry {
  readonly provider_kind: ModelProviderVendorId;
  readonly api: PiModelApi;
  readonly model: string;
  /** `pi_model` without `thinkingLevel`. */
  readonly config: unknown;
  readonly input: readonly PiCatalogModelInput[];
}

/** Product choices a Host passes in, instead of forking SDK data. */
export interface ModelRoutePolicy {
  /** Offered provider kinds, in order. Absent: every vendor, then `custom`. */
  readonly vendors?: readonly ModelProviderKind[];
  /** Offered model ids per vendor. A listed vendor admits no other model. */
  readonly models?: Readonly<Partial<Record<ModelProviderVendorId, readonly string[]>>>;
  readonly vendor_labels?: Readonly<Partial<Record<ModelProviderKind, string>>>;
  readonly model_labels?: Readonly<Partial<Record<ModelProviderVendorId, Readonly<Record<string, string>>>>>;
  /** The vendor a new draft starts with. */
  readonly default_vendor?: ModelProviderKind;
  /** The model selected when a vendor is chosen. */
  readonly default_models?: Readonly<Partial<Record<ModelProviderVendorId, string>>>;
  /** Values for a `custom` endpoint. The SDK has none of its own. */
  readonly custom_defaults?: {
    readonly adapter?: ModelProviderAdapter;
    readonly auth_mode?: ProviderAuthMode;
    readonly base_url?: string;
  };
  /** Host entries, which replace the catalog entry with the same vendor, api and model. */
  readonly overrides?: readonly ModelRouteHostEntry[];
}

export interface ModelRouteContext {
  readonly catalog: PiModelCatalogTable;
  readonly stored: ModelRouteStoredProfile | null;
  readonly policy: ModelRoutePolicy;
}

/** A context over the pinned Pi catalog. */
export function modelRouteContext(input: {
  readonly stored?: ModelRouteStoredProfile | null;
  readonly policy?: ModelRoutePolicy;
} = {}): ModelRouteContext {
  return { catalog: PI_MODEL_CATALOG, stored: input.stored ?? null, policy: input.policy ?? {} };
}

/** One entry of the pinned catalog for a vendor and api. */
export type PiCatalogModelListing =
  | {
    readonly model: string;
    readonly api: PiModelApi;
    readonly status: 'representable';
    readonly input: readonly PiCatalogModelInput[];
    readonly reasoning: boolean;
    readonly thinking_levels: readonly PiThinkingLevel[];
  }
  | {
    readonly model: string;
    readonly api: PiModelApi;
    readonly status: 'unrepresentable';
    /** The `pi_model` paths `PiModelConfig` cannot carry. */
    readonly unrepresentable: readonly string[];
  };

/**
 * The pinned catalog entries of a vendor, for one api or for all of them.
 * The catalog has no display names; the model id is the default label.
 */
export function listPiCatalogModels(selection: { readonly provider: string; readonly api?: PiModelApi }): PiCatalogModelListing[] {
  return catalogListing(PI_MODEL_CATALOG, selection.provider, selection.api);
}

export type ModelRouteChoice = { readonly value: string; readonly label: string | null };

/** A model choice; `source` says whether the catalog or the Host policy supplied it. */
export type ModelRouteModelChoice = PiCatalogModelListing & {
  readonly value: string;
  readonly label: string | null;
  readonly source: 'catalog' | 'host';
};

export interface ModelRouteFieldView {
  readonly field: ModelRouteField;
  readonly visible: boolean;
  readonly required: boolean;
  /** The draft value. For `secret` it is `keep`, `none` or `replace`, never the key. */
  readonly value: unknown;
  readonly choices: readonly (ModelRouteChoice | ModelRouteModelChoice)[] | null;
  readonly error: ModelRouteFieldError | null;
}

export interface ModelRouteView {
  readonly fields: readonly ModelRouteFieldView[];
  readonly model_source: ModelRouteModelSource | null;
  /** Whether catalog and Host entries apply: a catalog vendor at its own base URL. */
  readonly catalog_applies: boolean;
  readonly secret_configured: boolean;
  readonly valid: boolean;
}

export type ModelRouteChange =
  | { readonly field: 'profile_ref' | 'display_name' | 'base_url'; readonly value: string }
  | { readonly field: 'provider_kind'; readonly value: ModelProviderKind | null }
  | { readonly field: 'adapter'; readonly value: ModelProviderAdapter | null }
  | { readonly field: 'auth_mode'; readonly value: ProviderAuthMode | null }
  | { readonly field: 'model'; readonly value: string; readonly api?: PiModelApi }
  | { readonly field: 'pi_model'; readonly value: unknown }
  | { readonly field: 'thinking_level'; readonly value: PiThinkingLevel | null }
  | { readonly field: 'capabilities'; readonly value: readonly ProviderModelCapability[] }
  | { readonly field: 'secret'; readonly value: ModelRouteSecret };

/** The profile input a submission produces; the device adds `enabled` and the timestamps. */
export type ModelRouteProfileInput = Omit<ModelProviderProfileInput, 'created_at' | 'updated_at' | 'enabled'>;

export type ModelRouteSubmission =
  | { readonly ok: true; readonly profile: ModelRouteProfileInput; readonly secret: ModelRouteSecret }
  | { readonly ok: false; readonly errors: ModelRouteErrors };

/** The fields that bind a stored key to a profile. */
export interface ProviderSecretIdentity {
  readonly profile_ref: string;
  readonly provider_kind: string;
  readonly adapter: string;
  readonly auth_mode: string;
  readonly base_url: string;
}

/**
 * Whether a stored key may serve the next profile: every identity field is
 * unchanged, and both base URLs normalize to the same URL. A URL that does not
 * normalize never matches. The device rechecks a save with this function.
 */
export function providerSecretReusable(previous: ProviderSecretIdentity, next: ProviderSecretIdentity): boolean {
  return previous.profile_ref === next.profile_ref
    && previous.provider_kind === next.provider_kind
    && previous.adapter === next.adapter
    && previous.auth_mode === next.auth_mode
    && normalizedUrl(previous.base_url) !== undefined
    && normalizedUrl(previous.base_url) === normalizedUrl(next.base_url);
}

const EMPTY_DRAFT: ModelRouteDraft = {
  profile_ref: '', display_name: '', provider_kind: null, adapter: null, auth_mode: null, base_url: '',
  model: '', model_api: null, model_source: null, pi_model: null, thinking_level: null, capabilities: [], secret: 'none',
};

/** A new draft, or the draft of the stored profile. A stored key starts as `keep`. */
export function createModelRouteDraft(context: ModelRouteContext): ModelRouteDraft {
  const stored = context.stored;
  if (stored === null) {
    const vendor = context.policy.default_vendor;
    return vendor === undefined ? EMPTY_DRAFT : applyModelRouteChange(EMPTY_DRAFT, { field: 'provider_kind', value: vendor }, context);
  }
  const { pi_model: storedPi, ...profile } = stored.profile;
  const { thinkingLevel = null, ...config } = storedPi ?? {};
  const draft: ModelRouteDraft = {
    ...profile,
    capabilities: [...profile.capabilities],
    model_api: null,
    model_source: 'manual',
    pi_model: storedPi === undefined ? null : config,
    thinking_level: thinkingLevel,
    secret: stored.secret_configured && profile.auth_mode !== 'none' ? 'keep' : 'none',
  };
  const api: PiModelApi = profile.adapter === 'anthropic' ? 'anthropic-messages' : storedPi?.api ?? 'openai-completions';
  const choice = modelChoices(draft, context).find((entry) => entry.value === profile.model && entry.api === api);
  if (storedPi === undefined || choice?.status !== 'representable'
    || !sameJson(entryConfig(choice, profile.provider_kind, context), config)) {
    return draft;
  }
  return { ...draft, model_api: choice.api, model_source: choice.source, pi_model: null };
}

/** Change one field and reset the fields that depend on it. */
export function applyModelRouteChange(
  draft: ModelRouteDraft,
  change: ModelRouteChange,
  context: ModelRouteContext,
): ModelRouteDraft {
  switch (change.field) {
    case 'profile_ref':
    case 'display_name':
    case 'thinking_level':
    case 'capabilities':
    case 'secret':
      return { ...draft, [change.field]: change.value };
    case 'provider_kind':
      return withProviderKind(draft, change.value, context);
    case 'adapter': {
      const authLegal = change.value !== null && draft.auth_mode !== null
        && providerAuthModesForAdapter(change.value).includes(draft.auth_mode);
      return withAuthMode({ ...draft, adapter: change.value }, authLegal ? draft.auth_mode : null, context);
    }
    case 'auth_mode':
      return withAuthMode(draft, change.value, context);
    case 'base_url': {
      const next = { ...draft, base_url: change.value };
      if (next.model_source !== 'catalog' && next.model_source !== 'host') return next;
      return catalogApplies(next) ? next : { ...next, ...MANUAL_MODEL };
    }
    case 'model':
      return withModel(draft, change.value, change.api, context);
    case 'pi_model':
      return withDefaultThinking({ ...draft, pi_model: change.value }, manualThinkingLevels(change.value), true);
  }
}

/** Everything a Host renders, in field order. */
export function modelRouteView(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteView {
  const visible = visibleFields(draft);
  const errors = validateModelRoute(draft, context);
  const fields = MODEL_ROUTE_FIELDS.map((field): ModelRouteFieldView => ({
    field,
    visible: visible.has(field),
    required: visible.has(field) && field !== 'capabilities',
    value: field === 'secret' ? secretState(draft.secret) : draft[field],
    choices: fieldChoices(field, draft, context),
    error: errors[field] ?? null,
  }));
  return {
    fields,
    model_source: draft.model_source,
    catalog_applies: catalogApplies(draft),
    secret_configured: context.stored?.secret_configured ?? false,
    valid: Object.keys(errors).length === 0,
  };
}

/** One error code per visible field that is not valid. */
export function validateModelRoute(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteErrors {
  const visible = visibleFields(draft);
  const errors: Partial<Record<ModelRouteField, ModelRouteFieldError>> = {};
  const set = (field: ModelRouteField, error: ModelRouteFieldError): void => {
    if (visible.has(field) && errors[field] === undefined) errors[field] = error;
  };
  const shape = ModelProviderProfileSchema.shape;
  if (draft.profile_ref === '') set('profile_ref', { code: 'required' });
  else if (!shape.profile_ref.safeParse(draft.profile_ref).success) set('profile_ref', { code: 'invalid_value' });
  if (draft.display_name.trim() === '') set('display_name', { code: 'required' });
  else if (!shape.display_name.safeParse(draft.display_name).success) set('display_name', { code: 'invalid_value' });
  if (draft.provider_kind === null) set('provider_kind', { code: 'required' });
  else if (!offeredKinds(context.policy).includes(draft.provider_kind)) set('provider_kind', { code: 'not_a_choice' });
  if (draft.adapter === null) set('adapter', { code: 'required' });
  else if (!MODEL_PROVIDER_ADAPTERS.includes(draft.adapter)) set('adapter', { code: 'not_a_choice' });
  if (draft.auth_mode === null) set('auth_mode', { code: 'required' });
  if (draft.base_url === '') set('base_url', { code: 'required' });
  else if (normalizedUrl(draft.base_url) === undefined) set('base_url', { code: 'invalid_url' });
  if (draft.model.trim() === '') set('model', { code: 'required' });
  else if (!shape.model.safeParse(draft.model).success) set('model', { code: 'invalid_value' });
  else if (draft.model_source === null) set('model', { code: 'not_a_choice' });
  if (!shape.capabilities.safeParse(draft.capabilities).success
    || new Set(draft.capabilities).size !== draft.capabilities.length) {
    set('capabilities', { code: 'invalid_value' });
  }

  const piField: ModelRouteField = draft.model_source === 'manual' ? 'pi_model' : 'model';
  const config = draft.model_source === null ? undefined : selectedConfig(draft, context);
  let piModel: PiModelConfig | undefined;
  if (draft.model_source === 'manual' && (draft.pi_model === null || draft.pi_model === undefined)) {
    set('pi_model', { code: 'pi_model_required' });
  } else if (draft.model_source !== null && config === undefined) {
    set('model', { code: 'not_a_choice' });
  } else if (isRecord(config) && Object.hasOwn(config, 'thinkingLevel')) {
    set(piField, { code: 'pi_model_invalid', paths: ['thinkingLevel'] });
  } else if (config !== undefined) {
    const levels = thinkingLevelChoices(draft, context);
    if (draft.thinking_level === null) set('thinking_level', { code: 'required' });
    else if (!levels.includes(draft.thinking_level)) set('thinking_level', { code: 'thinking_level_unsupported' });
    const parsed = PiModelConfigSchema.safeParse({ ...(isRecord(config) ? config : {}), thinkingLevel: draft.thinking_level ?? levels[0] ?? 'off' });
    if (!isRecord(config)) set(piField, { code: 'pi_model_invalid', paths: [] });
    else if (parsed.success) piModel = parsed.data;
    else {
      const paths = issuePaths(parsed.error.issues).filter((path) => path !== 'thinkingLevel');
      if (paths.length > 0) set(piField, { code: 'pi_model_invalid', paths });
    }
  }

  if (draft.provider_kind !== null && draft.adapter !== null && draft.auth_mode !== null) {
    const issues = providerProfileRouteIssues({
      provider_kind: draft.provider_kind, adapter: draft.adapter, auth_mode: draft.auth_mode, pi_model: piModel,
    });
    for (const issue of issues) {
      if (issue.path[0] === 'auth_mode') set('auth_mode', { code: 'adapter_auth_mismatch' });
      else if (issue.path[0] === 'adapter') set('adapter', { code: 'vendor_adapter_mismatch' });
      else set(piField, { code: 'pi_model_invalid', paths: [issue.path.slice(1).join('.')] });
    }
  }

  const secretError = secretFieldError(draft, context);
  if (secretError !== undefined) set('secret', secretError);
  return errors;
}

/**
 * The profile input and the secret action for a valid draft, or the field
 * errors. The device parses `profile` with `ModelProviderProfileSchema` and
 * passes a `replace` key to `ProviderRegistry.configure`.
 */
export function modelRouteSubmission(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteSubmission {
  const errors = validateModelRoute(draft, context);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const config = selectedConfig(draft, context) as Omit<PiModelConfig, 'thinkingLevel'>;
  const entry = draft.model_source === 'manual' ? undefined : selectedChoice(draft, context);
  const input = entry?.status === 'representable' ? entry.input : undefined;
  return {
    ok: true,
    profile: {
      kind: 'model',
      profile_ref: draft.profile_ref,
      display_name: draft.display_name,
      provider_kind: draft.provider_kind!,
      adapter: draft.adapter!,
      auth_mode: draft.auth_mode!,
      base_url: draft.base_url,
      model: draft.model,
      capabilities: input === undefined ? [...draft.capabilities] : capabilitiesFor(input),
      pi_model: { ...config, thinkingLevel: draft.thinking_level! },
    },
    secret: draft.auth_mode === 'none' ? 'none' : draft.secret,
  };
}

const MANUAL_MODEL = { model_api: null, model_source: 'manual', pi_model: null, thinking_level: null, capabilities: [] } as const;
const NO_MODEL = { model: '', model_api: null, model_source: null, pi_model: null, thinking_level: null, capabilities: [] } as const;

function withProviderKind(draft: ModelRouteDraft, kind: ModelProviderKind | null, context: ModelRouteContext): ModelRouteDraft {
  const base = { ...draft, ...NO_MODEL, provider_kind: kind };
  if (kind === null) return withAuthMode({ ...base, adapter: null, base_url: '' }, null, context);
  const vendor = modelProviderVendor(kind);
  if (vendor === undefined) {
    const custom = context.policy.custom_defaults ?? {};
    return withAuthMode({ ...base, adapter: custom.adapter ?? null, base_url: custom.base_url ?? '' }, custom.auth_mode ?? null, context);
  }
  const next = withAuthMode({ ...base, adapter: vendor.adapter, base_url: vendor.base_url }, vendor.auth_mode, context);
  const model = context.policy.default_models?.[kind as ModelProviderVendorId];
  return model === undefined ? next : withModel(next, model, undefined, context);
}

function withAuthMode(draft: ModelRouteDraft, mode: ProviderAuthMode | null, context: ModelRouteContext): ModelRouteDraft {
  if (mode === 'none') return { ...draft, auth_mode: mode, secret: 'none' };
  const reopened = draft.secret === 'none' && context.stored?.secret_configured === true;
  return { ...draft, auth_mode: mode, secret: reopened ? 'keep' : draft.secret };
}

function withModel(draft: ModelRouteDraft, model: string, api: PiModelApi | undefined, context: ModelRouteContext): ModelRouteDraft {
  if (model.trim() === '') return { ...draft, ...NO_MODEL };
  const matches = modelChoices(draft, context).filter((entry) => entry.value === model && (api === undefined || entry.api === api));
  const choice = matches.length === 1 ? matches[0]! : undefined;
  if (choice?.status === 'representable') {
    return withDefaultThinking({
      ...draft, model, model_api: choice.api, model_source: choice.source, pi_model: null, capabilities: [],
    }, choice.thinking_levels, false);
  }
  const restricted = draft.provider_kind !== null && allowedModels(context.policy, draft.provider_kind) !== undefined;
  if (choice === undefined && (matches.length > 1 || restricted)) {
    return { ...draft, ...NO_MODEL, model };
  }
  return { ...draft, ...MANUAL_MODEL, model };
}

/**
 * Pi's own default level when the model supports it; otherwise no level, so
 * the user chooses one. `keep` retains a current level the model supports.
 */
function withDefaultThinking(draft: ModelRouteDraft, levels: readonly PiThinkingLevel[], keep: boolean): ModelRouteDraft {
  if (keep && draft.thinking_level !== null && levels.includes(draft.thinking_level)) return draft;
  return { ...draft, thinking_level: levels.includes(PI_DEFAULT_THINKING_LEVEL) ? PI_DEFAULT_THINKING_LEVEL : null };
}

function visibleFields(draft: ModelRouteDraft): Set<ModelRouteField> {
  const visible = new Set<ModelRouteField>(['profile_ref', 'display_name', 'provider_kind']);
  if (draft.provider_kind === null) return visible;
  for (const field of ['adapter', 'auth_mode', 'base_url', 'model'] as const) visible.add(field);
  if (draft.auth_mode !== null && draft.auth_mode !== 'none') visible.add('secret');
  if (draft.model.trim() === '' || draft.model_source === null) return visible;
  visible.add('thinking_level');
  if (draft.model_source === 'manual') {
    visible.add('pi_model');
    visible.add('capabilities');
  }
  return visible;
}

function fieldChoices(
  field: ModelRouteField,
  draft: ModelRouteDraft,
  context: ModelRouteContext,
): readonly (ModelRouteChoice | ModelRouteModelChoice)[] | null {
  const plain = (values: readonly string[]): ModelRouteChoice[] => values.map((value) => ({ value, label: null }));
  switch (field) {
    case 'provider_kind':
      return offeredKinds(context.policy).map((value) => ({
        value, label: context.policy.vendor_labels?.[value] ?? modelProviderVendor(value)?.display_name ?? null,
      }));
    case 'adapter': {
      const vendor = draft.provider_kind === null ? undefined : modelProviderVendor(draft.provider_kind);
      return plain(vendor === undefined ? MODEL_PROVIDER_ADAPTERS : [vendor.adapter]);
    }
    case 'auth_mode':
      return draft.adapter === null ? [] : plain(providerAuthModesForAdapter(draft.adapter));
    case 'model':
      return modelChoices(draft, context);
    case 'thinking_level':
      return plain(thinkingLevelChoices(draft, context));
    case 'capabilities':
      return plain(PROVIDER_MODEL_CAPABILITIES);
    default:
      return null;
  }
}

function offeredKinds(policy: ModelRoutePolicy): readonly ModelProviderKind[] {
  return policy.vendors ?? [...MODEL_PROVIDER_VENDOR_IDS, 'custom'];
}

function allowedModels(policy: ModelRoutePolicy, kind: ModelProviderKind): readonly string[] | undefined {
  return modelProviderVendor(kind) === undefined ? undefined : policy.models?.[kind as ModelProviderVendorId];
}

/**
 * Pinned Pi fills each `compat` key a model does not declare from its base URL
 * (pi-ai `detectCompat`), and some URL rules have no `compat` key at all. A
 * catalog entry is therefore exact only at the vendor's own base URL.
 */
function catalogApplies(draft: ModelRouteDraft): boolean {
  const vendor = draft.provider_kind === null ? undefined : modelProviderVendor(draft.provider_kind);
  const url = normalizedUrl(draft.base_url);
  return vendor !== undefined && url !== undefined && url === normalizedUrl(vendor.base_url);
}

/** The catalog entries of the draft's vendor, with Host entries in place, filtered by policy. */
function modelChoices(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteModelChoice[] {
  if (draft.provider_kind === null || !catalogApplies(draft)) return [];
  const vendor = draft.provider_kind as ModelProviderVendorId;
  const overrides = (context.policy.overrides ?? []).filter((entry) => entry.provider_kind === vendor);
  const key = (api: string, model: string): string => `${api}\u0000${model}`;
  const host = new Map(overrides.map((entry) => [key(entry.api, entry.model), hostListing(entry)]));
  const listed: { listing: PiCatalogModelListing; source: 'catalog' | 'host' }[] = [];
  for (const listing of catalogListing(context.catalog, vendor)) {
    const replaced = host.get(key(listing.api, listing.model));
    listed.push(replaced === undefined ? { listing, source: 'catalog' } : { listing: replaced, source: 'host' });
    host.delete(key(listing.api, listing.model));
  }
  for (const listing of host.values()) listed.push({ listing, source: 'host' });
  const allowed = allowedModels(context.policy, vendor);
  const labels = context.policy.model_labels?.[vendor];
  return listed
    .filter(({ listing }) => allowed === undefined || allowed.includes(listing.model))
    .map(({ listing, source }) => ({
      ...listing,
      value: listing.model,
      label: labels !== undefined && Object.hasOwn(labels, listing.model) ? labels[listing.model]! : null,
      source,
    }));
}

function hostListing(entry: ModelRouteHostEntry): PiCatalogModelListing {
  const levels = isRecord(entry.config) ? manualThinkingLevels(entry.config) : [];
  const parsed = PiModelConfigSchema.safeParse({ ...(isRecord(entry.config) ? entry.config : {}), thinkingLevel: levels[0] ?? 'off' });
  if (!parsed.success || !isRecord(entry.config) || Object.hasOwn(entry.config, 'thinkingLevel')) {
    const paths = parsed.success ? ['thinkingLevel'] : issuePaths(parsed.error.issues);
    return { model: entry.model, api: entry.api, status: 'unrepresentable', unrepresentable: paths };
  }
  return {
    model: entry.model, api: entry.api, status: 'representable', input: [...entry.input],
    reasoning: parsed.data.reasoning, thinking_levels: levels,
  };
}

function catalogListing(catalog: PiModelCatalogTable, provider: string, api?: PiModelApi): PiCatalogModelListing[] {
  if (!Object.hasOwn(catalog, provider)) return [];
  const byApi = catalog[provider]!;
  const listings: PiCatalogModelListing[] = [];
  for (const entryApi of PI_MODEL_APIS) {
    if ((api !== undefined && api !== entryApi) || !Object.hasOwn(byApi, entryApi)) continue;
    const models = byApi[entryApi]!;
    for (const model of Object.keys(models).sort()) {
      const entry = models[model]!;
      listings.push('unrepresentable' in entry
        ? { model, api: entryApi, status: 'unrepresentable', unrepresentable: [...entry.unrepresentable] }
        : {
          model, api: entryApi, status: 'representable', input: [...entry.input],
          reasoning: entry.config.reasoning, thinking_levels: piSupportedThinkingLevels(entry.config),
        });
    }
  }
  return listings;
}

function selectedChoice(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteModelChoice | undefined {
  return modelChoices(draft, context).find((entry) => entry.value === draft.model && entry.api === draft.model_api
    && entry.source === draft.model_source);
}

/** The `pi_model` without `thinkingLevel` that the draft selects, or `undefined` when none does. */
function selectedConfig(draft: ModelRouteDraft, context: ModelRouteContext): unknown {
  if (draft.model_source === 'manual') return draft.pi_model ?? undefined;
  const choice = selectedChoice(draft, context);
  return choice?.status === 'representable' ? entryConfig(choice, draft.provider_kind!, context) : undefined;
}

function entryConfig(choice: ModelRouteModelChoice, vendor: string, context: ModelRouteContext): unknown {
  if (choice.source === 'host') {
    return context.policy.overrides?.find((entry) => entry.provider_kind === vendor
      && entry.api === choice.api && entry.model === choice.model)?.config;
  }
  const entry = context.catalog[vendor]?.[choice.api]?.[choice.model];
  return entry === undefined || 'unrepresentable' in entry ? undefined : entry.config;
}

function thinkingLevelChoices(draft: ModelRouteDraft, context: ModelRouteContext): readonly PiThinkingLevel[] {
  if (draft.model_source === 'manual') return manualThinkingLevels(draft.pi_model);
  const choice = selectedChoice(draft, context);
  return choice?.status === 'representable' ? choice.thinking_levels : [];
}

/** The levels a `pi_model` offers, once its `reasoning` and map can be read. */
function manualThinkingLevels(config: unknown): PiThinkingLevel[] {
  if (!isRecord(config) || typeof config.reasoning !== 'boolean') return [];
  const map = config.thinkingLevelMap;
  if (map !== undefined && !isRecord(map)) return [];
  return piSupportedThinkingLevels({
    reasoning: config.reasoning,
    thinkingLevelMap: map as PiModelConfig['thinkingLevelMap'],
  });
}

function secretFieldError(draft: ModelRouteDraft, context: ModelRouteContext): ModelRouteFieldError | undefined {
  const secret = draft.secret;
  if (secret === 'none') return { code: 'secret_required' };
  if (secret !== 'keep') {
    if (secret.replace.trim() === '') return { code: 'secret_required' };
    const bytes = new TextEncoder().encode(secret.replace).byteLength;
    return isSharedSecretValue(secret.replace) && bytes <= PROVIDER_PROVISIONING_SECRET_MAX_BYTES
      ? undefined
      : { code: 'secret_invalid' };
  }
  const stored = context.stored;
  if (stored === null || !stored.secret_configured) return { code: 'secret_required' };
  if (normalizedUrl(draft.base_url) === undefined) return undefined;
  const identity = {
    profile_ref: draft.profile_ref,
    provider_kind: draft.provider_kind ?? '',
    adapter: draft.adapter ?? '',
    auth_mode: draft.auth_mode ?? '',
    base_url: draft.base_url,
  };
  return providerSecretReusable(stored.profile, identity) ? undefined : { code: 'secret_reentry_required' };
}

/** Issue paths, one per unknown key, sorted and unique. */
function issuePaths(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[]; readonly keys?: readonly string[] }[]): string[] {
  const paths = issues.flatMap((issue) => {
    const path = issue.path.map(String);
    return issue.code === 'unrecognized_keys' && issue.keys !== undefined
      ? issue.keys.map((key) => [...path, key].join('.'))
      : [path.join('.')];
  });
  return [...new Set(paths)].sort();
}

function secretState(secret: ModelRouteSecret): 'keep' | 'none' | 'replace' {
  return typeof secret === 'string' ? secret : 'replace';
}

function capabilitiesFor(input: readonly PiCatalogModelInput[]): ProviderModelCapability[] {
  return input.includes('image') ? ['image-input'] : [];
}

function normalizedUrl(value: string): string | undefined {
  try {
    return normalizeProviderUrl(value);
  } catch {
    return undefined;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    const other = Object.keys(right).filter((key) => right[key] !== undefined);
    return keys.length === other.length && keys.every((key) => sameJson(left[key], right[key]));
  }
  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { MODEL_PROVIDER_VENDORS, MODEL_PROVIDER_VENDOR_IDS } from './provider-catalog';
export type { ModelProviderVendor, ModelProviderVendorId } from './provider-catalog';
export { PI_THINKING_LEVELS, piSupportedThinkingLevels } from './pi-model-config';
export type { PiModelApi, PiModelConfig, PiThinkingLevel } from './pi-model-config';
export { PI_DEFAULT_THINKING_LEVEL };
export type { PiCatalogModelInput, PiModelCatalogTable } from './pi-model-catalog';
export type {
  ModelProviderAdapter,
  ModelProviderKind,
  ProviderAuthMode,
  ProviderModelCapability,
} from './provider-profile';
