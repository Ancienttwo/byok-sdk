import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Hermes home layout owned by the SDK.
 *
 * Hermes keeps its Python environment under the default home root
 * (`<root>/installs/`), and building it for a new root takes minutes. A
 * profile home `<root>/profiles/<name>` shares that environment. So the SDK
 * owns one root, given by the Host, and gives each execution a fresh profile
 * home under it. The profile is deleted when the execution ends. Nothing is
 * read from or written to the user's own `~/.hermes`.
 *
 * Hermes runs one gateway per root that serves every profile. A profile with
 * `gateway.standalone: true` gets a gateway of its own (`gateway run --force`),
 * which the SDK starts and owns for the execution. Hermes calls `standalone` a
 * temporary compatibility setting; the qualified version is in
 * `hermes-version.ts`.
 */

/** Provider choice written into each execution profile. Credentials stay in the environment. */
export interface HermesModelSelection {
  /** Hermes provider id, for example `openrouter`, `anthropic` or `custom`. */
  readonly provider: string;
  readonly model: string;
  /** Endpoint for an OpenAI-compatible `custom` provider. */
  readonly baseUrl?: string;
  /** Name of the environment variable that holds the provider key. The value never enters the file. */
  readonly keyEnv?: string;
}

/** Model metadata caches Hermes fetches over the network on first use. Not credentials. */
const CARRIED_CACHE_FILES = ['models_dev_cache.json', 'models_dev_cache.etag', 'provider_models_cache.json', 'context_length_cache.yaml'] as const;
const CACHE_DIR = 'byok-cache';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertHermesModelSelection(value: HermesModelSelection, label: string): void {
  for (const key of ['provider', 'model'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  if (value.baseUrl !== undefined && (typeof value.baseUrl !== 'string' || !/^https?:\/\//.test(value.baseUrl))) throw new TypeError(`${label}.baseUrl must be an http(s) URL`);
  if (value.keyEnv !== undefined && (typeof value.keyEnv !== 'string' || !ENV_NAME.test(value.keyEnv))) throw new TypeError(`${label}.keyEnv must be an environment variable name`);
  // The runtime environment drops BYOK_* (`buildRuntimeEnv`) and the adapter drops HERMES_*: such a key never reaches Hermes.
  if (value.keyEnv !== undefined && /^(BYOK|HERMES)_/i.test(value.keyEnv)) throw new TypeError(`${label}.keyEnv must not start with BYOK_ or HERMES_`);
}

/** The whole profile `config.yaml`. JSON string literals are valid YAML double-quoted scalars. */
export function hermesProfileConfig(model: HermesModelSelection | undefined): string {
  const lines = [
    '# Written by @byok-sdk/client for one execution. Deleted when the execution ends.',
    'gateway:',
    '  standalone: true',
    'memory:',
    '  memory_enabled: false',
    '  user_profile_enabled: false',
    'kanban:',
    '  dispatch_in_gateway: false',
  ];
  if (model !== undefined) {
    lines.push('model:', `  provider: ${JSON.stringify(model.provider)}`, `  default: ${JSON.stringify(model.model)}`);
    if (model.baseUrl !== undefined) lines.push(`  base_url: ${JSON.stringify(model.baseUrl)}`);
    if (model.keyEnv !== undefined) lines.push(`  key_env: ${JSON.stringify(model.keyEnv)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Creates `<root>/profiles/<name>` with the SDK config and the carried model caches. */
export async function createHermesProfile(root: string, name: string, model: HermesModelSelection | undefined): Promise<string> {
  const profiles = path.join(root, 'profiles');
  await fs.mkdir(profiles, { recursive: true, mode: 0o700 });
  const home = path.join(profiles, name);
  await fs.mkdir(home, { mode: 0o700 });
  await fs.writeFile(path.join(home, 'config.yaml'), hermesProfileConfig(model), { mode: 0o600 });
  for (const file of CARRIED_CACHE_FILES) {
    await fs.copyFile(path.join(root, CACHE_DIR, file), path.join(home, file)).catch(() => {});
  }
  return home;
}

/** Keeps the profile's model caches for the next execution, then deletes the profile. */
export async function removeHermesProfile(root: string, home: string): Promise<void> {
  const cache = path.join(root, CACHE_DIR);
  await fs.mkdir(cache, { recursive: true, mode: 0o700 }).catch(() => {});
  for (const file of CARRIED_CACHE_FILES) {
    const temporary = path.join(cache, `${file}.${path.basename(home)}.tmp`);
    await fs.copyFile(path.join(home, file), temporary)
      .then(() => fs.rename(temporary, path.join(cache, file)))
      .catch(() => fs.rm(temporary, { force: true }).catch(() => {}));
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
