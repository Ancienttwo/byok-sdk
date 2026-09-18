import { CONTROLLED_PI_DIRECTORY_ENV_NAMES, PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '@byok-sdk/implementation-identity';

const PRIVATE_PI_NAMES = new Set<string>([...CONTROLLED_PI_DIRECTORY_ENV_NAMES, ...PROVIDER_CREDENTIAL_ENV_DENY_NAMES]);
function privateName(name: string): boolean {
  return PRIVATE_PI_NAMES.has(name.toUpperCase()) || name.toUpperCase().startsWith('BYOK_PI_');
}

/** One daemon projection, before MCP measurement/probe; Pi itself keeps its separate env. */
export function projectPiMcpEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !privateName(entry[0]),
  )));
}

/** Configuration must already be projected; this parser never strips or invents fields. */
export function parsePiMcpEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi MCP mcpEnv is required');
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!name || /[=\u0000]/u.test(name) || typeof entry !== 'string' || entry.includes('\0')) throw new Error('Pi MCP mcpEnv contains an invalid entry');
    if (privateName(name)) throw new Error(`Pi MCP mcpEnv contains a private Pi or credential name: ${name}`);
    result[name] = entry;
  }
  return Object.freeze(result);
}
