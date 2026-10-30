import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HermesModelSelection } from './hermes-adapter';
import { ensureSecureDir } from '../../util/secure-dir';
import { identifyHermesGateway } from './gateway-identity';

/**
 * Hermes home layout owned by the SDK.
 *
 * Hermes keeps its Python environment under the default home root
 * (`<root>/installs/`), and building it for a new root takes minutes. A
 * profile home `<root>/profiles/<name>` shares that environment. So the SDK
 * owns one root, given by the Host, and gives each execution a fresh profile
 * home under it. The profile is deleted when the execution ends. Every
 * `hermes` command the adapter runs has `HERMES_HOME` set to the root or to a
 * profile, so nothing reads or writes the user's own `~/.hermes`.
 *
 * Hermes runs one gateway per root that serves every profile. A profile with
 * `gateway.standalone: true` gets a gateway of its own (`gateway run --force`),
 * which the SDK starts and owns for the execution. Hermes calls `standalone` a
 * temporary compatibility setting; the qualified version is in
 * `hermes-version.ts`.
 */

/** Model metadata caches Hermes fetches over the network on first use. Not credentials. */
const CARRIED_CACHE_FILES = ['models_dev_cache.json', 'models_dev_cache.etag', 'provider_models_cache.json', 'context_length_cache.yaml'] as const;
const CACHE_DIR = 'byok-cache';
const PROFILE_PREFIX = 'byok-';
/** A profile this old with no gateway answering for it belongs to a Host that died. */
const STALE_PROFILE_MS = 15 * 60_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Hermes otherwise checks GitHub for updates on `--version` and at gateway start (`hermes_cli/source_check.py`). */
const NO_UPDATE_CHECK = ['updates:', '  check: false'];
const ROOT_RENAME_ATTEMPTS = 5;
const ROOT_CONFIG = `${['# Written by @byok-sdk/client. Root of the SDK-owned Hermes profiles.', ...NO_UPDATE_CHECK].join('\n')}\n`;

export function assertHermesModelSelection(value: HermesModelSelection, label: string): void {
  for (const key of ['provider', 'model'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  if (value.baseUrl !== undefined) {
    let url: URL | undefined;
    try { url = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : undefined; } catch { url = undefined; }
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new TypeError(`${label}.baseUrl must be an http(s) URL`);
    // The URL is written to the profile file; a credential must stay in the environment (`keyEnv`).
    if (url.username !== '' || url.password !== '') throw new TypeError(`${label}.baseUrl must not carry credentials`);
  }
  if (value.keyEnv !== undefined && (typeof value.keyEnv !== 'string' || !ENV_NAME.test(value.keyEnv))) throw new TypeError(`${label}.keyEnv must be an environment variable name`);
  // The runtime environment drops BYOK_* (`buildRuntimeEnvironment`) and the adapter drops HERMES_*: such a key never reaches Hermes.
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
    ...NO_UPDATE_CHECK,
  ];
  if (model !== undefined) {
    lines.push('model:', `  provider: ${JSON.stringify(model.provider)}`, `  default: ${JSON.stringify(model.model)}`);
    if (model.baseUrl !== undefined) lines.push(`  base_url: ${JSON.stringify(model.baseUrl)}`);
    if (model.keyEnv !== undefined) lines.push(`  key_env: ${JSON.stringify(model.keyEnv)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Creates the root and its `config.yaml` (update check off) when they are missing or differ. */
export async function ensureHermesRoot(root: string): Promise<void> {
  // A new root gets a Windows DACL (a mode restricts nothing there). An existing root keeps the Host's ACL:
  // a change on it would propagate through the whole Python environment below it.
  if (await fs.mkdir(root, { recursive: true, mode: 0o700 }) !== undefined) await ensureSecureDir(root);
  const file = path.join(root, 'config.yaml');
  for (let attempt = 1; ; attempt += 1) {
    if (await fs.readFile(file, 'utf8').catch(() => undefined) === ROOT_CONFIG) return;
    // Write then rename: a concurrent `hermes --version` never reads a truncated config with the update check on.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, ROOT_CONFIG, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      await fs.rm(temporary, { force: true });
      // Windows refuses a rename onto a file that a concurrent writer is replacing. That writer writes the same text: read again.
      if (process.platform !== 'win32' || attempt === ROOT_RENAME_ATTEMPTS || (error as { code?: unknown }).code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/** Creates `<root>/profiles/byok-<id>` with the SDK config and the carried model caches. */
export async function createHermesProfile(root: string, id: string, model: HermesModelSelection | undefined): Promise<string> {
  const profiles = path.join(root, 'profiles');
  // A mode does not restrict a Windows directory; this sets a DACL there. A profile holds the session and names the control pipe.
  await ensureSecureDir(profiles);
  const home = path.join(profiles, `${PROFILE_PREFIX}${id}`);
  await fs.mkdir(home, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(home, 'config.yaml'), hermesProfileConfig(model), { mode: 0o600 });
    for (const file of CARRIED_CACHE_FILES) {
      await fs.copyFile(path.join(root, CACHE_DIR, file), path.join(home, file)).catch(() => {});
    }
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true });
    throw error;
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

/**
 * Deletes SDK profiles that a dead Host left behind. The daemon's owned
 * process ledger already reaps such a Host's gateway process group at the next
 * start. A profile is kept while it is in `live`, while it is younger than
 * {@link STALE_PROFILE_MS}, while any gateway answers for it, or while the
 * Windows pipe client fails, which proves no gateway gone. `live` knows
 * only this process's sessions, so one root serves one Host process.
 */
export async function sweepStaleHermesProfiles(root: string, live: ReadonlySet<string>, now = Date.now(), nativeAssetRoot?: string): Promise<void> {
  const profiles = path.join(root, 'profiles');
  const names = await fs.readdir(profiles).catch(() => [] as string[]);
  for (const name of names) {
    const home = path.join(profiles, name);
    if (!name.startsWith(PROFILE_PREFIX) || live.has(home)) continue;
    const stat = await fs.lstat(home).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory() || now - stat.mtimeMs < STALE_PROFILE_MS) continue;
    if (await identifyHermesGateway(home, { nativeAssetRoot }).catch(() => true) !== undefined) continue;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}
