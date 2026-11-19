import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { compareCodeUnits } from '../../util/compare-code-units.js';
import type { McpStdioServerSpec } from '../client.js';
import { GRANTABLE_MCP_SERVER_NAME, parseMcpToolDescriptors, type McpServerObservation } from '../observation.js';
import { assertUniqueQualifiedNames } from '../projection.js';
import { isJsonObject } from './protocol.js';

const CATALOG_VERSION = 1;
export const HUB_CATALOG_MAX_BYTES = 16 * 1_048_576;

/** Daemon-owned fields sealed for one Attempt. Env is already filtered by the caller. */
export interface McpHubCatalogBinding {
  readonly catalogPath: string;
  readonly attemptId: string;
  readonly launchCwd: string;
  readonly mcpEnv: Readonly<Record<string, string>>;
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
}

export type McpHubCatalog = ReadonlyMap<string, McpServerObservation>;

export function snapshotHubBinding(binding: McpHubCatalogBinding): McpHubCatalogBinding {
  if (!isAbsolute(binding.catalogPath) || !isAbsolute(binding.launchCwd) || binding.attemptId.length === 0) {
    throw new Error('MCP hub requires an Attempt id and absolute catalog and launch paths');
  }
  const entries = Object.entries(binding.mcpServers);
  if (entries.some(([name]) => !GRANTABLE_MCP_SERVER_NAME.test(name))) {
    throw new Error('MCP hub has an invalid configured server name');
  }
  return structuredClone(binding);
}

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => compareCodeUnits(a, b));
}

function fingerprint(binding: McpHubCatalogBinding): string {
  const servers = sortedEntries(binding.mcpServers).map(([name, spec]) => [
    name, spec.command, spec.args ?? [], sortedEntries(spec.env ?? {}),
  ]);
  return createHash('sha256').update(JSON.stringify([
    CATALOG_VERSION, binding.attemptId, binding.launchCwd, sortedEntries(binding.mcpEnv), servers,
  ])).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

async function readCatalogFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || stat.size > HUB_CATALOG_MAX_BYTES) {
      throw new Error('MCP hub catalog is not a bounded private file');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('MCP hub catalog size changed during read');
    return JSON.parse(buffer.toString('utf8', 0, offset), (_key: string, value: unknown) => {
      return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
    });
  } finally {
    await file.close();
  }
}

/** Read the same published authority from helper, gate or event projection. */
export async function readMcpHubCatalog(binding: McpHubCatalogBinding): Promise<McpHubCatalog | undefined> {
  let document: unknown;
  try {
    document = await readCatalogFile(binding.catalogPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (!isJsonObject(document) || document.version !== CATALOG_VERSION || document.binding !== fingerprint(binding)
    || !Array.isArray(document.servers) || document.servers.length !== Object.keys(binding.mcpServers).length) {
    throw new Error('MCP hub catalog does not match this Attempt and search configuration');
  }
  const catalog = new Map<string, McpServerObservation>();
  for (const entry of document.servers as unknown[]) {
    if (!isJsonObject(entry)) throw new Error('MCP hub catalog contains an invalid server');
    const { serverName, serverInfo, protocolVersion, tools } = entry;
    if (typeof serverName !== 'string' || !Object.hasOwn(binding.mcpServers, serverName) || catalog.has(serverName)
      || !isJsonObject(serverInfo) || typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string'
      || typeof protocolVersion !== 'string' || protocolVersion.length === 0 || !Array.isArray(tools)) {
      throw new Error('MCP hub catalog contains an invalid server observation');
    }
    catalog.set(serverName, Object.freeze({
      serverName,
      serverInfo: Object.freeze({ name: serverInfo.name, version: serverInfo.version }),
      protocolVersion,
      tools: parseMcpToolDescriptors(`MCP server "${serverName}"`, tools),
    }));
  }
  assertUniqueQualifiedNames(catalog);
  return catalog;
}

/** Publish the complete snapshot in one step. A racing publisher reads the winner. */
export async function publishMcpHubCatalog(
  binding: McpHubCatalogBinding,
  servers: readonly McpServerObservation[],
  signal: AbortSignal,
): Promise<McpHubCatalog> {
  assertUniqueQualifiedNames(servers.map((server) => [server.serverName, server]));
  const document = JSON.stringify({ version: CATALOG_VERSION, binding: fingerprint(binding), servers });
  if (Buffer.byteLength(document, 'utf8') > HUB_CATALOG_MAX_BYTES) throw new Error('MCP hub catalog exceeds its byte limit');
  const temp = `${binding.catalogPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, document, { mode: 0o600, flag: 'wx', signal });
    signal.throwIfAborted();
    await link(temp, binding.catalogPath).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
  const catalog = await readMcpHubCatalog(binding);
  if (catalog === undefined) throw new Error('Published MCP hub catalog disappeared');
  return catalog;
}
