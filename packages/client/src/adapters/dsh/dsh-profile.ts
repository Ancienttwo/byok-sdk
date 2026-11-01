import path from 'node:path';
import type { DshModelSelection, DshSandboxMode } from './dsh-adapter';

const SANDBOX_MODES: readonly DshSandboxMode[] = ['danger-full-access', 'workspace-write', 'read-only'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** dsh's own subprocess scrub pattern (`@deepseek-ai/dsh-subprocess` `SENSITIVE_ENV_PATTERN`). */
const TOOL_SCRUBBED_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;
/** The route name dsh's DeepSeek API plugin registers. */
const DEEPSEEK_ROUTE = 'deepseek-official';
/** The hand-declared pi-ai route for an OpenAI-compatible `custom` endpoint. */
const CUSTOM_ROUTE = 'byok-custom';
/** Empty directory dsh scans for user skills instead of `~/.agents`. */
const AGENTS_HOME_DIR = 'byok-agents-home';

export function assertDshModelSelection(value: DshModelSelection, label: string): void {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
  for (const key of ['provider', 'model'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  if (!PROVIDER_ID.test(value.provider)) throw new TypeError(`${label}.provider must be a lowercase dsh provider id`);
  if (value.baseUrl !== undefined) {
    if (value.provider === 'deepseek') throw new TypeError(`${label}.baseUrl is not supported for the deepseek provider`);
    let url: URL | undefined;
    try { url = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : undefined; } catch { url = undefined; }
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new TypeError(`${label}.baseUrl must be an http(s) URL`);
    if (url.username !== '' || url.password !== '') throw new TypeError(`${label}.baseUrl must not carry credentials`);
    // The key belongs in `keyEnv`; a key in the query string would be written into the patch file.
    if (url.search !== '') throw new TypeError(`${label}.baseUrl must not carry a query string`);
  } else if (value.provider === 'custom') {
    throw new TypeError(`${label}.baseUrl is required for the custom provider`);
  }
  if (typeof value.keyEnv !== 'string' || !ENV_NAME.test(value.keyEnv)) throw new TypeError(`${label}.keyEnv must be an environment variable name`);
  if (!TOOL_SCRUBBED_NAME.test(value.keyEnv)) throw new TypeError(`${label}.keyEnv must contain KEY, TOKEN, SECRET or PASSWORD so dsh keeps it out of tool processes`);
  if (/^(BYOK|DSH)_/i.test(value.keyEnv)) throw new TypeError(`${label}.keyEnv must not start with BYOK_ or DSH_`);
  if (value.keyEnv.toUpperCase() === 'DEEPSEEK_API_KEY') throw new TypeError(`${label}.keyEnv must not be DEEPSEEK_API_KEY, which dsh web_search also reads`);
}

export function assertDshSandboxMode(value: unknown, label: string): asserts value is DshSandboxMode {
  if (!SANDBOX_MODES.includes(value as DshSandboxMode)) throw new TypeError(`${label} must be one of ${SANDBOX_MODES.join(', ')}`);
}

/** The dsh route a selection runs on, as `session/new` reports it in the `model` config option. */
export function dshRoute(model: DshModelSelection): string {
  if (model.provider === 'deepseek') return DEEPSEEK_ROUTE;
  return model.provider === 'custom' ? CUSTOM_ROUTE : model.provider;
}

/**
 * The `--patch` overlay of one execution: the provider route with its key
 * reference, and the route and model of every ACP session and of the agent
 * default (subagents). JSON is valid YAML, so no YAML writer is needed.
 */
export function dshPatch(model: DshModelSelection): string {
  const route = dshRoute(model);
  const entries: unknown[] = [];
  if (model.provider === 'deepseek') {
    entries.push({ id: 'llm-deepseek', config: { apiKeyEnv: model.keyEnv } });
  } else if (model.provider === 'custom') {
    entries.push({ id: 'llm-pi-ai', config: { providers: { [CUSTOM_ROUTE]: {
      apiKeyEnv: model.keyEnv, api: 'openai-completions', baseURL: model.baseUrl, models: [{ id: model.model }],
    } } } });
  } else {
    entries.push({ id: 'llm-pi-ai', config: { providers: { [route]: {
      apiKeyEnv: model.keyEnv, ...(model.baseUrl === undefined ? {} : { baseURL: model.baseUrl }),
    } } } });
  }
  entries.push(
    { id: 'acp', config: { provider: route, model: model.model } },
    { id: 'agent-default-model', config: { provider: route, model: model.model } },
  );
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function dshAgentsHome(root: string): string {
  return path.join(root, AGENTS_HOME_DIR);
}

/**
 * The dsh process environment. Ambient `DSH_*` names are dropped: they are
 * bootstrap switches (home, skills root, permission mode, telemetry) the SDK
 * sets itself, and dsh accepts them only from the inherited environment.
 */
export function dshEnvironment(base: Readonly<Record<string, string | undefined>>, root: string, sandbox: DshSandboxMode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !/^DSH_/i.test(name)) env[name] = value;
  }
  env.DSH_HOME = root;
  env.DSH_AGENTS_HOME = dshAgentsHome(root);
  env.DSH_PERMISSION_MODE = sandbox;
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  return env;
}
