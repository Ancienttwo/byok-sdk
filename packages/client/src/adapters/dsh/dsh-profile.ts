import path from 'node:path';
import { isCursorAuthEnvironmentName } from '../provider-credential-environment.js';
import type { DshModelSelection, DshSandboxMode } from './dsh-adapter.js';

const SANDBOX_MODES: readonly DshSandboxMode[] = ['danger-full-access', 'workspace-write', 'read-only'];
/** dsh's subprocess scrub removes key-named variables from its tool environment. */
export const DSH_PROVIDER_KEY_ENV = 'BYOK_DSH_PROVIDER_API_KEY';
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;
/** The route name dsh's DeepSeek API plugin registers. */
const DEEPSEEK_ROUTE = 'deepseek-official';
/** The hand-declared pi-ai route for an OpenAI-compatible `custom` endpoint. */
const CUSTOM_ROUTE = 'byok-custom';
/** Empty directory dsh scans for user skills instead of `~/.agents`. */
const AGENTS_HOME_DIR = 'byok-agents-home';

export function assertDshModelSelection(value: DshModelSelection, label: string): void {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.trim().length === 0)) throw new TypeError(`${label}.model must be a non-empty string`);
  if (typeof value.provider !== 'string' || !PROVIDER_ID.test(value.provider)) throw new TypeError(`${label}.provider must be a lowercase dsh provider id`);
  if (value.baseUrl !== undefined) {
    if (value.provider === 'deepseek') throw new TypeError(`${label}.baseUrl is not supported for the deepseek provider`);
    let url: URL | undefined;
    try { url = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : undefined; } catch { url = undefined; }
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new TypeError(`${label}.baseUrl must be an http(s) URL`);
    if (url.username !== '' || url.password !== '') throw new TypeError(`${label}.baseUrl must not carry credentials`);
    // A key in the query string would be written into the patch file.
    if (url.search !== '') throw new TypeError(`${label}.baseUrl must not carry a query string`);
  } else if (value.provider === 'custom') {
    throw new TypeError(`${label}.baseUrl is required for the custom provider`);
  }
  if ('keyEnv' in value) throw new TypeError(`${label}.keyEnv was removed; supply resolveKey on the adapter`);
}

export function assertDshSandboxMode(value: unknown, label: string): asserts value is DshSandboxMode {
  if (!SANDBOX_MODES.includes(value as DshSandboxMode)) throw new TypeError(`${label} must be one of ${SANDBOX_MODES.join(', ')}`);
}

/** The dsh route a selection runs on. */
export function dshRoute(model: DshModelSelection): string {
  if (model.provider === 'deepseek') return DEEPSEEK_ROUTE;
  return model.provider === 'custom' ? CUSTOM_ROUTE : model.provider;
}

/**
 * The `--patch` overlay of one execution: the provider route with its key
 * variable and endpoint, never the key. The model travels as the session's
 * selection. JSON is valid YAML, so no YAML writer is needed.
 */
export function dshPatch(model: DshModelSelection): string {
  const entry = model.provider === 'deepseek'
    ? { id: 'llm-deepseek', config: { apiKeyEnv: DSH_PROVIDER_KEY_ENV } }
    : { id: 'llm-pi-ai', config: { providers: { [dshRoute(model)]: model.provider === 'custom'
      ? { apiKeyEnv: DSH_PROVIDER_KEY_ENV, api: 'openai-completions', baseURL: model.baseUrl,
        ...(model.model === undefined ? {} : { models: [{ id: model.model }] }) }
      : { apiKeyEnv: DSH_PROVIDER_KEY_ENV, ...(model.baseUrl === undefined ? {} : { baseURL: model.baseUrl }) } } } };
  return `${JSON.stringify([entry], null, 2)}\n`;
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
    if (value !== undefined && !isCursorAuthEnvironmentName(name) && !/^DSH_/i.test(name) && name.toUpperCase() !== DSH_PROVIDER_KEY_ENV) env[name] = value;
  }
  env.DSH_HOME = root;
  env.DSH_AGENTS_HOME = dshAgentsHome(root);
  env.DSH_PERMISSION_MODE = sandbox;
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  return env;
}
