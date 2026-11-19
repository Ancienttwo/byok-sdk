import { observeMcpServer } from '../observation.js';
import type { McpServerObservation } from '../observation.js';
import { HUB_CATALOG_MAX_BYTES, type McpHubCatalogBinding } from './catalog.js';

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_CONCURRENCY = 8;

export async function discoverMcpHubServers(
  binding: McpHubCatalogBinding,
  signal: AbortSignal,
): Promise<readonly McpServerObservation[]> {
  const deadline = performance.now() + DISCOVERY_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const failed = new AbortController();
  const discovery = AbortSignal.any([signal, timeout, failed.signal]);
  const entries = Object.entries(binding.mcpServers);
  const pending = entries.values();
  const servers: McpServerObservation[] = [];
  let bytes = 0;

  async function worker(): Promise<void> {
    for (const [name, spec] of pending) {
      discovery.throwIfAborted();
      let observation: McpServerObservation;
      try {
        observation = await observeMcpServer(name, spec, {
          env: binding.mcpEnv, cwd: binding.launchCwd, signal: discovery, timeoutMs: DISCOVERY_TIMEOUT_MS,
        }, deadline);
      } catch (error) {
        discovery.throwIfAborted();
        // The transport error can quote child stderr. Only the configured name crosses stdio.
        throw new Error(`Could not discover MCP tools for server "${name}".`, { cause: error });
      }
      bytes += Buffer.byteLength(JSON.stringify(observation), 'utf8');
      if (bytes > HUB_CATALOG_MAX_BYTES) throw new Error('MCP hub catalog exceeds its byte limit.');
      servers.push(observation);
    }
  }

  await Promise.allSettled(Array.from({ length: Math.min(entries.length, DISCOVERY_CONCURRENCY) }, async () => {
    try {
      await worker();
    } catch (error) {
      failed.abort(error);
    }
  }));
  signal.throwIfAborted();
  if (timeout.aborted || performance.now() >= deadline) throw new Error('MCP hub discovery exceeded its 10-second budget.');
  failed.signal.throwIfAborted();
  return servers;
}
