import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolvedPiExtensions {
  readonly webAccess: string;
  readonly mcpAdapter: string;
}

/**
 * Resolve the two Pi extensions shipped as required `@byok-sdk/client`
 * dependencies. Pi receives explicit extension paths so runtime behavior is
 * pinned to this package graph rather than a user's mutable global Pi package
 * settings.
 */
export function resolvePiExtensions(): ResolvedPiExtensions {
  const clientManifest = fileURLToPath(import.meta.resolve('@byok-sdk/client/package.json'));
  return {
    webAccess: fileURLToPath(import.meta.resolve('pi-web-access/index.ts')),
    mcpAdapter: path.join(path.dirname(clientManifest), 'dist', 'adapters', 'pi', 'mcp-extension.js'),
  };
}
