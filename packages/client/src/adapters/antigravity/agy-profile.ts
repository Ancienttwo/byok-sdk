import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../../util/atomic-write';
import type { AgyGeminiProxy } from './agy-gemini-proxy';

/** The native settings that select the Gemini provider. They name no auth method. */
const SETTINGS = `${JSON.stringify({ modelProvider: 'gemini', setupComplete: true, onboardingComplete: true })}\n`;
/** Host credentials and switches agy reads natively; only the SDK sets these. */
const NATIVE_NAMES = /^(?:GEMINI_|GOOGLE_|AGY_|ANTIGRAVITY_)/i;
// agy keeps `credential-user-scope` below the user config directory and looks for the session bus. Windows has no fallback for its two names, so they are set.
// An unset bus address makes D-Bus clients start `dbus-launch`, so it names a socket that does not exist, the same failure as a host with no session bus.
const OS_HOME_NAMES = /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|DBUS_SESSION_BUS_ADDRESS|XDG_(?:CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR)$/i;

export function assertAgyGeminiBaseUrl(value: unknown, label: string): void {
  let url: URL | undefined;
  try { url = typeof value === 'string' ? new URL(value) : undefined; } catch { url = undefined; }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new TypeError(`${label} must be an http(s) URL`);
  if (url.username !== '' || url.password !== '') throw new TypeError(`${label} must not carry credentials`);
  if (url.search !== '') throw new TypeError(`${label} must not carry a query string`);
}

/** agy's native data root: the Go CLI reads it below the OS home, `GEMINI_HOME` alone does not move it. */
export function agyNativeHome(home: string): string {
  return path.join(home, '.gemini');
}

/** agy's own state below `home`: settings, conversations and logs. */
export function agyStoreDir(home: string): string {
  return path.join(agyNativeHome(home), 'antigravity-cli');
}

/** The owned home's settings, rewritten only on a difference: concurrent agy processes read this file. */
export async function ensureAgyHome(home: string): Promise<void> {
  const settings = path.join(agyStoreDir(home), 'settings.json');
  await fs.mkdir(path.dirname(settings), { recursive: true, mode: 0o700 });
  if (await fs.readFile(settings, 'utf8').catch(() => undefined) !== SETTINGS) await atomicWriteFile(settings, SETTINGS, { mode: 0o600 });
}

/**
 * The agy process environment, which every tool it starts inherits, `HOME`
 * included. agy hands all of it to every tool and MCP child, with no name scrub
 * (measured on CLI 1.5.0), so the real key stays behind `proxy`.
 */
export function agyEnvironment(base: Readonly<Record<string, string | undefined>>, home: string, proxy?: Pick<AgyGeminiProxy, 'url' | 'token'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !NATIVE_NAMES.test(name) && !OS_HOME_NAMES.test(name)) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(home, 'no-session-bus')}`;
  env.GEMINI_HOME = agyNativeHome(home);
  env.AGY_CLI_DISABLE_AUTO_UPDATE = '1';
  if (proxy !== undefined) {
    env.GEMINI_API_KEY = proxy.token;
    env.GOOGLE_GEMINI_BASE_URL = proxy.url;
  }
  return env;
}
