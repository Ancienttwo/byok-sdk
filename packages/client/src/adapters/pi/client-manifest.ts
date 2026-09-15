import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed `@byok-sdk/client` manifest is the single runtime authority for
 * this package's own pinned dependency graph: `resolve-extensions.ts` locates
 * the shipped `dist/` extension entries relative to it, and `resolve-bin.ts`
 * reads the exact Pi runtime identity it declares. Both go through this module
 * so the package root is resolved exactly one way.
 *
 * `./package.json` is an explicit export of this package, so
 * `import.meta.resolve` works from the bundled `dist/` output as well as from
 * source during tests.
 */
export interface ClientManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
}

export function clientManifestPath(): string {
  return fileURLToPath(import.meta.resolve('@byok-sdk/client/package.json'));
}

export function clientPackageRoot(): string {
  return path.dirname(clientManifestPath());
}

export function readClientManifest(): ClientManifest {
  const manifestPath = clientManifestPath();
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientManifest;
  } catch (cause) {
    throw new Error(`@byok-sdk/client manifest at ${manifestPath} could not be read`, { cause });
  }
}
