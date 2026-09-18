import { byok } from '../../../package.json';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function clientManifestPath(): string {
  return fileURLToPath(import.meta.resolve('@byok-sdk/client/package.json'));
}

export function clientPackageRoot(): string {
  return path.dirname(clientManifestPath());
}

/** Build-checked projection of the manifest dependency alias, never a new author. */
export function readClientPiRuntimePin(): string | undefined {
  return byok.piRuntimePin;
}
