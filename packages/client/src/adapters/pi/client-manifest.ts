import { byok } from '../../../package.json';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * `createRequire` needs only `import.meta.url`, so a CommonJS product bundle
 * that defines it resolves the same way (#724). The `./package.json` export has
 * no conditions, so the require resolver finds the same file as ESM.
 */
export function clientManifestPath(): string {
  return createRequire(import.meta.url).resolve('@byok-sdk/client/package.json');
}

export function clientPackageRoot(): string {
  return path.dirname(clientManifestPath());
}

/** Build-checked projection of the manifest dependency alias, never a new author. */
export function readClientPiRuntimePin(): string | undefined {
  return byok.piRuntimePin;
}
