import { readFileSync } from 'node:fs';
import type { Plugin } from 'esbuild';

/** Preserve the workspace manifests' side-effect authority on external edges. */
export function workspaceExternals(): Plugin {
  return {
    name: 'byok-workspace-externals',
    setup(build) {
      build.onResolve({ filter: /^@byok-sdk\// }, ({ path }) => {
        const name = path.split('/')[1];
        const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'));
        if (manifest.name !== `@byok-sdk/${name}` || manifest.sideEffects !== false) {
          throw new Error(`${path}: workspace external must declare sideEffects: false`);
        }
        return { path, external: true, sideEffects: manifest.sideEffects };
      });
    },
  };
}
