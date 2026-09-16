import clientManifest from '../../../package.json';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package manifest is the single pin authority, embedded by the bundler. */
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
  return clientManifest as ClientManifest;
}
