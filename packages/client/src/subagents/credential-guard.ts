import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PI_RPC_IPC_KEY_MARKER } from '../adapters/pi/launcher-credential';

/**
 * Refuse a Pi subagent child in the BYOK pi-rpc lane (#385).
 *
 * In that lane the provider key lives only in the parent rpc host's memory.
 * The vendored subagents extension starts each child itself, with a copy of
 * the parent's environment and its own stdio, so the SDK has no private
 * channel to hand the key across. The child would read the same projection
 * and send its IPC marker as the API key. It refuses before any session,
 * extension or request exists instead.
 *
 * The launcher-written projection is the authority: a provider whose `apiKey`
 * is the rpc IPC marker exists only under `credentialSource: keys-profile`.
 * No projection means the device's own Pi configuration, which this guard
 * leaves to Pi. A projection that cannot be parsed is refused.
 */
export function assertSubagentProviderCredential(agentDir: string): void {
  let bytes: string;
  try {
    bytes = readFileSync(join(agentDir, 'models.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('byok_subagent_projection_unreadable: the Pi provider projection could not be read');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes); } catch {
    throw new Error('byok_subagent_projection_unreadable: the Pi provider projection is not JSON');
  }
  const providers = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { providers?: unknown }).providers : undefined;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return;
  for (const entry of Object.values(providers)) {
    if (entry !== null && typeof entry === 'object' && (entry as { apiKey?: unknown }).apiKey === PI_RPC_IPC_KEY_MARKER) {
      throw new Error('byok_subagent_credential_unavailable: Pi subagents are unavailable in the BYOK pi-rpc lane; the provider key is held only in the parent host');
    }
  }
}
