import { parseRuntimeDescendantPlan, type RuntimeDescendantPlanV1 } from '../adapters/pi/runtime-descendant-plan';
import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { PERMISSION_MODES, PermissionPolicySchema, type PermissionMode, type PermissionPolicy } from '@byok-sdk/protocol';
import {
  AgentSessionRuntime,
  createPreparedAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import { inputPreparationRuntimeIdentityString, type InputPreparationModelV1 } from '../input-preparation';
import { loaderEnvInjections } from '../daemon/environment';
import type { McpLaunchAttestation } from '../daemon/trusted-launch-cwd';
import {
  McpServerPool,
  parseTaskScopedMcpConfig,
  type TaskScopedMcpConfig,
} from '../adapters/pi/mcp-server-pool';
import {
  assemblePreparedPiToolSurface,
  type PreparedPiServerBinding,
} from '../adapters/pi/prepared-tools';

/**
 * The SDK-owned prepared launch entry for the pi runtime.
 *
 * `pi --mode rpc` can never consume a prepared request: only a session built by
 * `createPreparedAgentSession` carries the authorized binding, so the ordinary
 * CLI answers `prompt_prepared` with `prepared_session_unsupported`
 * (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:999`).
 * This process is that session — an in-process Node host that constructs it
 * with an explicit, complete tool closure and then runs the SAME `runRpcMode`
 * loop the CLI runs, so the adapter above it speaks one RPC protocol either
 * way.
 *
 * What it is NOT: it is not a second compiler and not a second executor. It
 * compiles nothing (the artifact arrives already compiled, over the RPC frame,
 * and the native session verifies it), and it reaches MCP servers through the
 * shared pool both Pi entries use (`../adapters/pi/mcp-server-pool.ts`).
 *
 * Every resource is explicit and empty:
 *
 * - Zero extensions, skills, prompt templates, themes and context files. The
 *   loader below is constructed and deliberately never reloaded, so no file on
 *   this device can contribute to the system prompt. That is what makes the
 *   session's own projection predictable enough for the native
 *   `prepared_context_drift` check to mean something: a preparation compiled
 *   against any other prompt shape is REFUSED rather than silently run.
 * - No native tools. See `../adapters/pi/prepared-tools.ts` for why, and for
 *   the exact native API fact that is NOT the reason.
 *
 * Failure is always closed and always before anything is sent: a malformed
 * configuration, an unresolvable runtime closure, a tool surface that no longer
 * matches what was counted, or a loader-injected environment each exit
 * non-zero with a stable reason on stderr, and no session is created at all.
 */

const CONFIG_FORMAT = 'byok.pi.prepared-launch';
const CONFIG_VERSION = 3;
/**
 * Where this process's provider credential comes from, and the ONE switch the
 * rest of this file branches on. Written by the adapter from
 * `adapters/pi/runtime-launch.ts`'s own decision; never inferred here from the
 * presence of an environment variable or a file, because "a key happens to be
 * set" is not a statement about which authority the launch was admitted under.
 */
const CREDENTIAL_SOURCES = ['pi-auth-store', 'keys-profile'] as const;
type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];
const EXIT_CONFIG = 78; // EX_CONFIG

function fail(message: string): never {
  process.stderr.write(`byok-pi-prepared: ${message}\n`);
  process.exit(EXIT_CONFIG);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function requireStringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') fail(`${field}.${key} must be a string`);
    record[key] = entry;
  }
  return Object.freeze(record);
}

/**
 * The two optional model declarations, re-validated here against this reader's
 * own closed shapes.
 *
 * Restated rather than shared with the daemon's reader
 * (`../daemon/control-protocol.ts`) or with `@byok-sdk/protocol`'s zod schema:
 * this process re-validates the record field by field precisely because it may
 * not take another reader's word for a value the native verifier will compare.
 * The three must never DISAGREE about the closed set, which
 * `../__tests__/input-preparation-model-parity.test.ts` pins by feeding one
 * fixture table through all of them.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const COMPAT_FLAGS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'zaiToolStream',
] as const;
const MAX_TOKENS_FIELDS = ['max_completion_tokens', 'max_tokens'] as const;
const THINKING_FORMATS = [
  'openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen',
  'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
] as const;

/** One provider-side effort token: bounded, portable, non-empty. */
function isThinkingEffort(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9_-]+$/u.test(value);
}

/**
 * Exactly the seven declared levels, each an effort token or `null`. A missing
 * level is refused rather than read as unsupported.
 */
function parseThinkingLevelMap(value: unknown): InputPreparationModelV1['thinkingLevelMap'] {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).some((key) => !(THINKING_LEVELS as readonly string[]).includes(key))) return undefined;
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(value, level)) return undefined;
    const entry = value[level];
    if (entry !== null && !isThinkingEffort(entry)) return undefined;
  }
  const map = value as Record<(typeof THINKING_LEVELS)[number], string | null>;
  return {
    off: map.off,
    minimal: map.minimal,
    low: map.low,
    medium: map.medium,
    high: map.high,
    xhigh: map.xhigh,
    max: map.max,
  };
}

/** The declared compatibility flags: every member optional, no member invented. */
function parseModelCompat(value: unknown): InputPreparationModelV1['compat'] {
  if (!isPlainObject(value)) return undefined;
  const admitted: readonly string[] = [...COMPAT_FLAGS, 'maxTokensField', 'thinkingFormat'];
  if (Object.keys(value).some((key) => !admitted.includes(key))) return undefined;
  const parsed: Record<string, unknown> = {};
  for (const flag of COMPAT_FLAGS) {
    if (!Object.hasOwn(value, flag)) continue;
    if (typeof value[flag] !== 'boolean') return undefined;
    parsed[flag] = value[flag];
  }
  if (Object.hasOwn(value, 'maxTokensField')) {
    if (!(MAX_TOKENS_FIELDS as readonly unknown[]).includes(value['maxTokensField'])) return undefined;
    parsed['maxTokensField'] = value['maxTokensField'];
  }
  if (Object.hasOwn(value, 'thinkingFormat')) {
    if (!(THINKING_FORMATS as readonly unknown[]).includes(value['thinkingFormat'])) return undefined;
    parsed['thinkingFormat'] = value['thinkingFormat'];
  }
  return parsed as InputPreparationModelV1['compat'];
}

/**
 * The exact model identity the durable record pinned, re-validated field by field.
 *
 * Exported for the parser-parity test alone: it is one of three INDEPENDENT
 * readers of the same model, and a parity table that could not reach this one
 * would pin only the other two.
 */
export function parsePreparedExpectedModel(value: unknown): InputPreparationModelV1 {
  if (!isPlainObject(value)) fail('expected.model must be an object');
  if (value.api !== 'openai-completions') fail('expected.model.api must be "openai-completions"');
  if (typeof value.reasoning !== 'boolean') fail('expected.model.reasoning must be a boolean');
  if (!Array.isArray(value.input) || value.input.some((entry) => entry !== 'text' && entry !== 'image')) {
    fail('expected.model.input must be an array of "text" | "image"');
  }
  if (!isPlainObject(value.cost)) fail('expected.model.cost must be an object');
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (typeof value.cost[key] !== 'number') fail(`expected.model.cost.${key} must be a number`);
  }
  for (const key of ['contextWindow', 'maxTokens']) {
    if (typeof value[key] !== 'number') fail(`expected.model.${key} must be a number`);
  }
  // The two declarations the launched model entry may carry, re-validated here
  // against the SAME closed shapes the daemon's parser applies — a key this
  // reader dropped would hand the native session an expected model that no
  // longer equals the session model, which is `prepared_model_drift`.
  let thinkingLevelMap: InputPreparationModelV1['thinkingLevelMap'];
  if (value.thinkingLevelMap !== undefined) {
    thinkingLevelMap = parseThinkingLevelMap(value.thinkingLevelMap);
    if (thinkingLevelMap === undefined) fail('expected.model.thinkingLevelMap must map exactly the seven declared levels to an effort token or null');
  }
  let compat: InputPreparationModelV1['compat'];
  if (value.compat !== undefined) {
    compat = parseModelCompat(value.compat);
    if (compat === undefined) fail('expected.model.compat declares an unknown key or an unsupported value');
  }
  return Object.freeze({
    id: requireString(value.id, 'expected.model.id'),
    name: requireString(value.name, 'expected.model.name'),
    api: 'openai-completions',
    provider: requireString(value.provider, 'expected.model.provider'),
    baseUrl: requireString(value.baseUrl, 'expected.model.baseUrl'),
    reasoning: value.reasoning,
    input: Object.freeze([...(value.input as ('text' | 'image')[])]),
    cost: Object.freeze({
      input: value.cost.input as number,
      output: value.cost.output as number,
      cacheRead: value.cost.cacheRead as number,
      cacheWrite: value.cost.cacheWrite as number,
    }),
    contextWindow: value.contextWindow as number,
    maxTokens: value.maxTokens as number,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap: Object.freeze(thinkingLevelMap) }),
    ...(compat === undefined ? {} : { compat: Object.freeze(compat) }),
  });
}

// ---------------------------------------------------------------------------
// The BYOK consent gate
// ---------------------------------------------------------------------------

/**
 * The environment name the keys launcher — and nothing else — delivers the
 * device secret under, and the reference the projection uses to name it.
 *
 * Restated rather than imported: `@byok-sdk/client` has no `@byok-sdk/keys`
 * dependency (`scripts/release/check-package-graph.mjs` keeps the device-local
 * key authority and the dispatch packages disjoint). The restatement is pinned
 * by a test that can see both.
 */
const PREPARED_PROVIDER_KEY_ENV = 'PI_PROVIDER_API_KEY';
const PREPARED_PROVIDER_KEY_REFERENCE = `$${PREPARED_PROVIDER_KEY_ENV}`;

/**
 * Every model field the consent gate compares between the durable record and
 * the launcher-minted projection, in one list.
 *
 * `baseUrl` and `api` are declared on the PROVIDER in the projection and on the
 * MODEL in the record; `provider` is the projection's own provider id. The
 * other eight are model-entry fields compared verbatim.
 *
 * Why a single exported constant: every one of these decides either the bytes
 * of D or where those bytes are sent, so a body-affecting field added to
 * `InputPreparationModelV1` (or to the device's `PiModelConfigSchema`) that
 * escaped this list would be a field the device could declare one way and the
 * Host another, with the secret already in this process.
 * `../__tests__/prepared-provider-consent.test.ts` fails on any wire field that
 * is in neither this list nor {@link PREPARED_PROJECTION_EXCLUDED_MODEL_FIELDS}.
 */
export const PREPARED_PROJECTION_COMPARED_MODEL_FIELDS = Object.freeze([
  'api', 'baseUrl', 'compat', 'contextWindow', 'id', 'input', 'maxTokens', 'name',
  'provider', 'reasoning', 'thinkingLevelMap',
] as const);

/**
 * The wire model fields deliberately NOT compared, each with its reason.
 *
 * - `cost` — accounting metadata the Host states for its own counting. The
 *   device profile does not declare it, `buildPiProviderProjection` never emits
 *   it, and the native compiler never puts it in D. Comparing it would refuse
 *   every real launch over a field the projection cannot carry.
 */
export const PREPARED_PROJECTION_EXCLUDED_MODEL_FIELDS = Object.freeze(['cost'] as const);

/**
 * The compared fields that live on the projection's MODEL ENTRY, derived from
 * the list above rather than restated.
 *
 * `api` and `baseUrl` are declared on the PROVIDER in the projection and
 * `provider` is the provider id itself, so those three are compared by their
 * own dedicated checks (which can say which one differed); everything else in
 * {@link PREPARED_PROJECTION_COMPARED_MODEL_FIELDS} is a model-entry field. This
 * list is both the admitted key set of the projected entry and the exact set of
 * keys the equality below compares, so a field added to the constant cannot
 * silently escape the comparison and a field outside it cannot silently enter.
 */
const PREPARED_PROJECTION_COMPARED_ENTRY_FIELDS: readonly string[] = Object.freeze(
  PREPARED_PROJECTION_COMPARED_MODEL_FIELDS
    .filter((field) => field !== 'api' && field !== 'baseUrl' && field !== 'provider'),
);

/**
 * The two provider-registration failure sites, each a FIXED literal.
 *
 * `registerProvider` and `getAuth` are the two calls on this path that touch
 * the resolved device credential, and the fork composes its own error strings
 * from caller-supplied provider and model values — so a foreign exception
 * message is the one value here that could carry, or be derived from, the
 * secret. Nothing about the caught error reaches the refusal: the site is named
 * by a token this file chose, exactly as every other refusal in this file is a
 * fixed literal. `../__tests__/prepared-provider-consent.test.ts` forces a real
 * fork exception whose message carries a synthetic secret and pins that neither
 * the secret nor the message appears in what this process would write.
 */
const PREPARED_PROVIDER_REGISTRATION_DETAIL = Object.freeze({
  register: 'provider registration threw',
  resolve: 'the registered provider did not resolve a credential for the counted model',
});

export type PreparedProviderRegistrationSite = keyof typeof PREPARED_PROVIDER_REGISTRATION_DETAIL;

/** The whole refusal text for a registration failure site, and the only source of it. */
export function preparedProviderRegistrationRefusal(site: PreparedProviderRegistrationSite): string {
  return `prepared_provider_registration_failed: ${PREPARED_PROVIDER_REGISTRATION_DETAIL[site]}`;
}

/** Key-sorted, absence-preserving canonical form. An absent key and a present `undefined` differ. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The one provider the launcher projected, as this process will register it. */
interface PreparedProviderRegistration {
  readonly providerId: string;
  readonly config: {
    readonly baseUrl: string;
    readonly api: 'openai-completions';
    readonly apiKey: string;
    readonly authHeader?: true;
    readonly models: readonly Record<string, unknown>[];
  };
}

/**
 * Read the launcher-minted `models.json` and refuse unless it declares exactly
 * the provider and model the durable record pinned.
 *
 * This is the SDK's endpoint/declaration binding, and it is the reason a device
 * secret may be wired into this process at all. The prepared request is sent to
 * the RECORD's `model.baseUrl`, which the Host decided, and the native
 * `prepared_endpoint_mismatch` check compares the record's model with itself —
 * so without this gate a Host-chosen URL would receive a device secret. The
 * profile the device configured is the only authority on where its own
 * credential may go, and the launcher-minted projection is that profile,
 * written by the process that read the SecretStore, into a directory only it
 * and this child can see.
 *
 * Fail closed in every direction: a missing or unreadable projection, an
 * unknown key, two providers, two model entries, or one field that differs. The
 * reader is closed and restated here rather than shared, for the same reason
 * {@link parsePreparedExpectedModel} is: this process may not take another
 * reader's word for a value that decides where a secret is sent.
 */
function admitPreparedProviderProjection(
  modelsPath: string,
  model: InputPreparationModelV1,
): PreparedProviderRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as unknown;
  } catch (cause) {
    fail(`prepared_provider_projection_missing: ${modelsPath} could not be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const refuse = (detail: string): never => fail(`prepared_provider_projection_mismatch: ${detail}`);

  if (!isPlainObject(parsed) || Object.keys(parsed).length !== 1 || !isPlainObject(parsed.providers)) {
    refuse('the launcher projection must declare exactly one "providers" object');
  }
  const providers = (parsed as { providers: Record<string, unknown> }).providers;
  const providerIds = Object.keys(providers);
  if (providerIds.length !== 1) refuse(`the launcher projection declares ${providerIds.length} providers; exactly one is admitted`);
  const providerId = providerIds[0]!;
  if (providerId !== model.provider) {
    refuse('the launcher projection declares a provider the counted request was not compiled for');
  }
  const provider = providers[providerId];
  if (!isPlainObject(provider)) refuse('the projected provider must be an object');
  const providerKeys = Object.keys(provider as Record<string, unknown>).sort();
  const admittedProviderKeys = ['api', 'apiKey', 'authHeader', 'baseUrl', 'models'];
  if (providerKeys.some((key) => !admittedProviderKeys.includes(key))) {
    refuse('the projected provider declares an unknown key');
  }
  const entry = provider as Record<string, unknown>;
  // Never the literal secret, and never a reference to some OTHER name: the
  // launcher delivers the device credential under exactly one environment
  // variable, and a projection naming anything else would either resolve to a
  // value this process cannot account for or be a secret written to disk.
  if (entry.apiKey !== PREPARED_PROVIDER_KEY_REFERENCE) {
    refuse('the projected provider must reference the launcher-delivered credential and nothing else');
  }
  if (entry.authHeader !== undefined && entry.authHeader !== true) refuse('the projected provider declares an unsupported authHeader');
  if (entry.baseUrl !== model.baseUrl) refuse('the projected provider endpoint differs from the counted model endpoint');
  if (entry.api !== model.api) refuse('the projected provider API differs from the counted model API');
  if (!Array.isArray(entry.models) || entry.models.length !== 1) {
    refuse('the projected provider must declare exactly one model entry');
  }
  const projected = (entry.models as unknown[])[0];
  if (!isPlainObject(projected)) refuse('the projected model entry must be an object');
  const projectedEntry = projected as Record<string, unknown>;

  if (Object.keys(projectedEntry).some((key) => !PREPARED_PROJECTION_COMPARED_ENTRY_FIELDS.includes(key))) {
    refuse('the projected model entry declares an unknown key');
  }
  // Re-validated against this file's own closed shapes before being compared:
  // an entry whose `compat` carried an unknown key would otherwise compare
  // equal to nothing and be reported as a plain difference.
  let projectedThinkingLevelMap: InputPreparationModelV1['thinkingLevelMap'];
  if (projectedEntry.thinkingLevelMap !== undefined) {
    projectedThinkingLevelMap = parseThinkingLevelMap(projectedEntry.thinkingLevelMap);
    if (projectedThinkingLevelMap === undefined) refuse('the projected model entry declares an invalid thinkingLevelMap');
  }
  let projectedCompat: InputPreparationModelV1['compat'];
  if (projectedEntry.compat !== undefined) {
    projectedCompat = parseModelCompat(projectedEntry.compat);
    if (projectedCompat === undefined) refuse('the projected model entry declares an invalid compat');
  }
  // Both sides are projected THROUGH the compared-field list, so the equality
  // below is the list: a name added to the constant is compared from that
  // moment, and a field outside it is compared by nobody.
  const normalizedProjected: Record<string, unknown> = {
    ...projectedEntry,
    ...(projectedThinkingLevelMap === undefined ? {} : { thinkingLevelMap: projectedThinkingLevelMap }),
    ...(projectedCompat === undefined ? {} : { compat: projectedCompat }),
  };
  const countedModel = model as unknown as Record<string, unknown>;
  const comparable: Record<string, unknown> = {};
  const counted: Record<string, unknown> = {};
  for (const field of PREPARED_PROJECTION_COMPARED_ENTRY_FIELDS) {
    if (normalizedProjected[field] !== undefined) comparable[field] = normalizedProjected[field];
    if (countedModel[field] !== undefined) counted[field] = countedModel[field];
  }
  if (canonicalJson(comparable) !== canonicalJson(counted)) {
    refuse('the projected model entry differs from the counted model');
  }
  return Object.freeze({
    providerId,
    config: Object.freeze({
      baseUrl: entry.baseUrl as string,
      api: 'openai-completions' as const,
      // The REFERENCE, never the value. The fork resolves `$NAME` from this
      // process's environment at request time, and a literal here would put
      // the device secret into an object the session can serialize.
      apiKey: PREPARED_PROVIDER_KEY_REFERENCE,
      ...(entry.authHeader === true ? { authHeader: true as const } : {}),
      models: Object.freeze([Object.freeze({ ...projectedEntry })]),
    }),
  });
}

function parseLaunch(value: unknown): McpLaunchAttestation {
  if (!isPlainObject(value)) fail('launch must be an object');
  const launchCwd = requireString(value.launchCwd, 'launch.launchCwd');
  if (!isAbsolute(launchCwd)) fail('launch.launchCwd must be an absolute path');
  const launcher = value.launcher;
  if (launcher !== null && !isPlainObject(launcher)) fail('launch.launcher must be an object or null');
  return Object.freeze({
    launchCwd,
    launcher: launcher === null
      ? null
      : Object.freeze({ ...launcher }) as McpLaunchAttestation['launcher'],
  });
}

/** What the pi adapter writes for exactly one prepared operation. */
interface PreparedLaunchConfig {
  readonly binding: ImplementationSpawnBindingV1;
  readonly descendantPlan: RuntimeDescendantPlanV1 | null;
  readonly credentialSource: CredentialSource;
  readonly cwd: string;
  readonly policy: PermissionPolicy;
  readonly countedPermissionMode: PermissionMode;
  readonly model: InputPreparationModelV1;
  readonly toolBindingDigest: string;
  readonly observationDigest: string;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly launch: McpLaunchAttestation;
  readonly mcp: TaskScopedMcpConfig;
}

function loadConfig(configPath: string, digest: string): PreparedLaunchConfig {
  let parsed: unknown;
  try {
    parsed = readPiHostConfig(configPath, digest);
  } catch (cause) {
    fail(`${configPath} could not be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isPlainObject(parsed)) fail('the prepared launch configuration must be an object');
  const keys = ['format','version','binding','descendantPlan','credentialSource','cwd','policy','countedPermissionMode','expected','toolBindingDigest','observationDigest','toolsetDefinitionRevisions','launch','mcp'];
  if (Object.keys(parsed).length !== keys.length || !keys.every(key => Object.hasOwn(parsed, key))) fail('prepared config has missing or unknown keys');
  if (parsed.format !== CONFIG_FORMAT) fail(`the prepared launch configuration must declare format ${CONFIG_FORMAT}`);
  if (parsed.version !== CONFIG_VERSION) fail(`the prepared launch configuration must declare version ${CONFIG_VERSION}`);

  // Parsed with the protocol's own schema rather than by hand: this value is
  // what decides the native tool selection, and a hand-rolled reader would be a
  // second, laxer definition of a security-control shape that is `.strict()` on
  // purpose.
  const policyResult = PermissionPolicySchema.safeParse(parsed.policy);
  if (!policyResult.success) fail(`policy is not a valid permission policy: ${policyResult.error.message}`);

  const countedPermissionMode = parsed.countedPermissionMode;
  if (typeof countedPermissionMode !== 'string'
    || !(PERMISSION_MODES as readonly string[]).includes(countedPermissionMode)) {
    fail(`countedPermissionMode must be one of [${PERMISSION_MODES.join(', ')}]`);
  }
  if (!isPlainObject(parsed.expected)) fail('expected must be an object');

  const credentialSource = parsed.credentialSource;
  if (typeof credentialSource !== 'string' || !(CREDENTIAL_SOURCES as readonly string[]).includes(credentialSource)) {
    fail(`credentialSource must be one of [${CREDENTIAL_SOURCES.join(', ')}]`);
  }

  const cwd = requireString(parsed.cwd, 'cwd');
  if (!isAbsolute(cwd)) fail('cwd must be an absolute path');

  const mcp = parseTaskScopedMcpConfig(parsed.mcp, fail);
  // One mode, stated once. The pool's own configuration carries it because the
  // ordinary extension reads the same shape; a disagreement between the two
  // copies would mean the registered set and the verified set were chosen under
  // different policies.
  if (mcp.permissionMode !== countedPermissionMode) {
    fail('mcp.permissionMode disagrees with countedPermissionMode');
  }

  const binding = requirePiHostBinding(parsed.binding);
  let descendantPlan: RuntimeDescendantPlanV1 | null;
  try {
    descendantPlan = parseRuntimeDescendantPlan(parsed.descendantPlan, 'pi-prepared', parsed.binding as ImplementationSpawnBindingV1);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({
    binding, descendantPlan,
    credentialSource: credentialSource as CredentialSource,
    cwd,
    policy: policyResult.data,
    countedPermissionMode: countedPermissionMode as PermissionMode,
    model: parsePreparedExpectedModel(parsed.expected.model),
    toolBindingDigest: requireString(parsed.toolBindingDigest, 'toolBindingDigest'),
    observationDigest: requireString(parsed.observationDigest, 'observationDigest'),
    toolsetDefinitionRevisions: requireStringRecord(parsed.toolsetDefinitionRevisions, 'toolsetDefinitionRevisions'),
    launch: parseLaunch(parsed.launch),
    mcp,
  });
}

/**
 * The projected servers, in the canonical order the preparation digested them
 * in: by server name, byte-wise.
 *
 * Derived from the pool's own configuration rather than carried as a second
 * list. The binding digest commits to `(serverName, toolsetId, command, args)`,
 * and every one of those already travels in the task-scoped MCP configuration —
 * a separate copy could disagree with the servers this process actually starts.
 */
function projectedServerBindings(mcp: TaskScopedMcpConfig): readonly PreparedPiServerBinding[] {
  return Object.freeze(Object.keys(mcp.observation)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((serverName) => {
      const server = mcp.mcpServers[serverName]!;
      return Object.freeze({
        serverName,
        toolsetId: mcp.observation[serverName]!.toolsetId,
        command: server.command,
        args: Object.freeze([...(server.args ?? [])]),
      });
    }));
}

function parseArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config') fail('usage: byok-pi-prepared --config <path>');
  const configPath = argv[1]!;
  if (!isAbsolute(configPath)) fail('--config must be an absolute path');
  return configPath;
}

export async function runPiPreparedHost(argv: readonly string[]): Promise<void> {
  // The same assertion `bin/byok-launch-cwd.mjs` makes, for the same reason and
  // at the same kind of boundary: these take effect before this file's first
  // statement, so this process cannot sanitize them for itself — it can only
  // refuse to establish a prepared session under them.
  if (process.execArgv.length > 0) {
    fail(`refusing to launch with a non-empty interpreter argv: ${process.execArgv.join(' ')}`);
  }
  const injected = loaderEnvInjections(process.env);
  if (injected.length > 0) {
    fail(`refusing to launch with loader environment variables set: ${injected.join(', ')}`);
  }

  const owned = extractPiConfigDigest(argv, fail);
  const config = loadConfig(parseArgs(owned.args), owned.digest);

  // Derived from the VERIFIED installed artifact closure, never from the
  // configuration: a runtime identity a caller could state is a fingerprint
  // input a caller could choose.
  let runtimeIdentity: string;
  try {
    runtimeIdentity = inputPreparationRuntimeIdentityString(await verifyPiHostBinding(config.binding, 'pi-prepared', fail));
  } catch (cause) {
    fail(`the installed pi closure could not be verified: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const pool = new McpServerPool(config.mcp, fail);
  const surface = await assemblePreparedPiToolSurface({
    policy: config.policy,
    countedPermissionMode: config.countedPermissionMode,
    observation: config.mcp.observation,
    toolsetDefinitionRevisions: config.toolsetDefinitionRevisions,
    servers: projectedServerBindings(config.mcp),
    launch: config.launch,
    toolImplementations: config.mcp.toolImplementations,
    runtimeIdentity,
    expectedToolBindingDigest: config.toolBindingDigest,
    expectedObservationDigest: config.observationDigest,
    host: pool,
  });
  if (!surface.ok) {
    await pool.close();
    fail(`${surface.code}: ${surface.message}`);
  }

  // pi's OWN resolution of where its per-user state lives, run in THIS process
  // where HOME is the task's. The native factory refuses to resolve it for the
  // caller; that is a rule about the factory, not a reason to re-derive pi's
  // own directory layout in the daemon and hand a second opinion down.
  const agentDir = getAgentDir();

  // The BYOK branch, and the ONLY branch: under `keys-profile` this process's
  // agent directory IS the fresh per-launch projection directory the client
  // minted and the launcher wrote into, so the device's own Pi auth store is
  // structurally out of reach. Under `pi-auth-store` nothing below runs and the
  // built-in-provider lane is byte-for-byte what it has always been — a
  // declared entry, not a fallback.
  //
  // Both refusals happen here: before the model runtime exists, before any
  // session is created, and therefore before anything could be sent.
  let preparedProvider: PreparedProviderRegistration | undefined;
  if (config.credentialSource === 'keys-profile') {
    preparedProvider = admitPreparedProviderProjection(join(agentDir, 'models.json'), config.model);
    // Presence only. The value is never read into a message, a log line, a
    // configuration file or an argument — the fork resolves the `$` reference
    // from this environment when it builds the request.
    const delivered = process.env[PREPARED_PROVIDER_KEY_ENV];
    if (typeof delivered !== 'string' || delivered.length === 0) {
      fail(`prepared_provider_credential_unavailable: the credential-custody launcher delivered no ${PREPARED_PROVIDER_KEY_ENV}`);
    }
  }

  const settingsManager = SettingsManager.create(config.cwd, agentDir);
  const sessionManager = SessionManager.create(config.cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    // No catalog file and no catalog refresh: the model this session sends with
    // is the one the record pinned, handed in below. A network refresh here
    // would be an unrelated egress on a path whose whole point is that the
    // request was already decided.
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  // Registered in memory rather than by pointing `modelsPath` at the
  // projection, and the choice was made by probe, not by taste
  // (`tasks/notes/20260921-0016-prepared-byok-provider.notes.md`, K-3). Both
  // mechanisms resolve the key with zero egress and leave `auth.baseUrl`
  // undefined, so neither can make the native endpoint check misfire. They
  // differ on writes: with `modelsPath` set, the runtime's models store is a
  // FILE store next to the projection, and the first `refresh()` creates
  // `models-store.json` inside the launcher-owned directory — a file the
  // launcher did not write and does not clean up. With `modelsPath: null` the
  // store is in-memory, and `registerProvider`'s own floating
  // `refresh({allowNetwork:false})` writes nothing and reaches no network.
  if (preparedProvider !== undefined) {
    try {
      modelRuntime.registerProvider(preparedProvider.providerId, preparedProvider.config as never);
    } catch {
      // The caught value is deliberately unnamed and unread: see
      // `preparedProviderRegistrationRefusal`.
      fail(preparedProviderRegistrationRefusal('register'));
    }
    // The registration is only useful if it makes the COUNTED model resolvable:
    // `Models.getAuth` answers `undefined` for a provider id it does not hold,
    // before it reads any credential store, and that refusal would otherwise
    // surface as the fork's "no API key found" message after a session existed.
    let resolved: unknown;
    try {
      resolved = await modelRuntime.getAuth(config.model as never);
    } catch {
      fail(preparedProviderRegistrationRefusal('resolve'));
    }
    if (resolved === undefined) {
      fail(preparedProviderRegistrationRefusal('resolve'));
    }
  }
  // Constructed and never reloaded — see this file's own doc comment. Every
  // getter answers the constructor's empty state, so no extension, skill,
  // prompt template, theme or context file on this device reaches the session.
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    settingsManager,
  });

  const created = await createPreparedAgentSession({
    cwd: config.cwd,
    agentDir,
    model: config.model as never,
    // The frozen request carries its own reasoning configuration inside D, so
    // this affects nothing the provider is sent; it is required, and "off" is
    // the only value that claims nothing the artifact did not already decide.
    thinkingLevel: 'off',
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: surface.tools.map((entry) => ({
      name: entry.name,
      identity: entry.identity,
      tool: entry.tool as never,
    })),
  });

  // Established here rather than left to whatever this device's settings say.
  // The native session refuses a prepared request outright while either is on
  // (`prepared_session_ineligible`), because an auto-compaction or an
  // application-level retry would write to, or re-issue, the very request that
  // was frozen. A prepared host that inherited them would be a host whose
  // admission depends on a user's settings file.
  created.session.setAutoCompactionEnabled(false);
  created.session.setAutoRetryEnabled(false);

  // No session-shutdown hook is registered for the pool: `runRpcMode` never
  // returns, and the adapter that spawned this process owns its whole tree
  // (`../adapters/pi/rpc-client.ts`'s `adoptOwnedProcessTree`), so the server
  // children are reaped with it. Closing the pool from a signal handler here
  // would install a second, racing disposal authority over the same children.

  const services: AgentSessionServices = {
    cwd: config.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    diagnostics: [],
  };
  // The runtime host `runRpcMode` drives. Its session-replacement factory
  // refuses: `new_session`, `switch_session`, `fork` and `clone` are all
  // `PREPARED_RESERVED_COMMANDS` and are already refused by the RPC loop while a
  // reservation is held, but a prepared session must never be replaced at any
  // point in its life — the replacement would carry no authorized binding and
  // would silently become an ordinary session on the same transport.
  const runtime = new AgentSessionRuntime(
    created.session,
    services,
    async () => {
      throw new Error('a prepared pi session is never replaced; start a new prepared operation instead');
    },
  );

  await runRpcMode(runtime);
}
