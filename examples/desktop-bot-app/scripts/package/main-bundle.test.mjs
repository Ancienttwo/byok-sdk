import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('bundles Electron main without the client root, Pi or provider SDKs (#1925)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { metafile } = await build({
    absWorkingDir: root, entryPoints: ['src/main/index.ts'], outfile: 'main.js',
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    external: ['electron'], write: false, metafile: true, logLevel: 'silent',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  const inputs = Object.keys(metafile.inputs).map(input => path.resolve(root, input).replaceAll('\\', '/'));
  expect(inputs.some(input => input.endsWith('/packages/client/dist/host-layout.js'))).toBe(true);
  expect(inputs.filter(input => /\/packages\/client\/dist\//u.test(input)))
    .toEqual([expect.stringMatching(/\/packages\/client\/dist\/host-layout\.js$/u)]);
  expect(inputs.filter(input => /\/(?:@earendil-works|openai|@anthropic-ai|@google|@aws-sdk|@azure|@mistralai|@huggingface|@ai-sdk)\//u.test(input))).toEqual([]);
});
