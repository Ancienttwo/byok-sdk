import { byok } from '../../../package.json';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Replaced from packages/client/package.json by tsup/vitest configuration; never read at runtime. */
declare const __BYOK_CLIENT_PACKAGE_VERSION__: string;

/**
 * `createRequire` needs only `import.meta.url`, so a CommonJS product bundle
 * that defines it resolves the same way (#724). The `./package.json` export has
 * no conditions, so the require resolver finds the same file as ESM. It also
 * searches `NODE_PATH` and the global folders, which ESM does not, so the found
 * manifest must be this client's own name and version.
 */
export function clientManifestPath(): string {
  const file = createRequire(import.meta.url).resolve('@byok-sdk/client/package.json');
  const { name, version } = JSON.parse(readFileSync(file, 'utf8'));
  if (`${name}@${version}` !== `@byok-sdk/client@${__BYOK_CLIENT_PACKAGE_VERSION__}`) throw new Error(`${file} is another client; reinstall @byok-sdk/client`);
  return file;
}

export function clientPackageRoot(): string {
  return path.dirname(clientManifestPath());
}

/** Build-checked projection of the manifest dependency alias, never a new author. */
export function readClientPiRuntimePin(): string | undefined {
  return byok.piRuntimePin;
}
