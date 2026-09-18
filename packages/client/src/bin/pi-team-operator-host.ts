import path from 'node:path';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { extractPiConfigDigest, readPiHostConfig } from '../adapters/pi/runtime-host-binding';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import { parseTaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import teamInteractionExtension from '../adapters/pi/team-interaction-extension';
import { runPiSessionRuntime } from './pi-session-runtime';

function fail(message: string): never {
  process.stderr.write(`byok-pi-team-operator: ${message}\n`);
  process.exit(78);
}

/** Official CLI only: ambient env and explicit extensions; no attestation claim. */
export async function runPiTeamOperatorHost(argv: readonly string[]): Promise<void> {
  const owned = extractPiConfigDigest(argv, fail);
  if (owned.args.length !== 2 || owned.args[0] !== '--config' || !path.isAbsolute(owned.args[1]!)) fail('expected --config <absolute path>');
  const value = readPiHostConfig(owned.args[1]!, owned.digest);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'cwd', 'sessionDir', 'provider', 'model', 'systemPromptPath', 'extensionPaths', 'mcp'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) fail('invalid operator config keys');
  if (raw.format !== 'byok.pi.team-operator' || raw.version !== 1) fail('invalid operator config format/version');
  for (const key of ['cwd', 'sessionDir', 'systemPromptPath'] as const) {
    if (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key]) || path.resolve(raw[key]) !== raw[key]) fail(`${key} must be a normalized absolute path`);
  }
  for (const key of ['provider', 'model'] as const) if (typeof raw[key] !== 'string' || raw[key].length === 0) fail(`${key} must be non-empty`);
  if (!Array.isArray(raw.extensionPaths) || raw.extensionPaths.some(item => typeof item !== 'string' || !path.isAbsolute(item))) fail('extensionPaths must be absolute paths');
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  if (mcp.permissionMode !== 'auto' || Object.keys(mcp.observation).length !== 0) fail('operator MCP requires auto and empty host observation');
  if (VERSION !== resolvePiRuntimeIdentity().version) fail('native version differs from the static SDK pin');
  await runPiSessionRuntime({
    cwd: raw.cwd as string, sessionDir: raw.sessionDir as string,
    provider: raw.provider as string, model: raw.model as string, noTools: 'builtin',
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: raw.systemPromptPath as string,
      additionalExtensionPaths: raw.extensionPaths as string[],
      extensionFactories: [
        { name: 'byok-team-interaction', factory: teamInteractionExtension },
        { name: 'byok-team-mcp', factory: createByokMcpExtension(mcp) },
      ],
      // Native appends inline factories after path extensions. Restore the
      // operator contract's guard-first order through its public loader seam.
      extensionsOverride: loaded => {
        const ownedPaths = ['<inline:byok-team-interaction>', '<inline:byok-team-mcp>'];
        const owned = ownedPaths.map(name => {
          const matches = loaded.extensions.filter(extension => extension.path === name);
          if (matches.length !== 1) fail(`missing or duplicate operator extension ${name}`);
          return matches[0]!;
        });
        return { ...loaded, extensions: [...owned, ...loaded.extensions.filter(extension => !ownedPaths.includes(extension.path))] };
      },
    },
    initialModel: 'on-prompt', label: 'byok-pi-team-operator', reject: fail,
  });
}
