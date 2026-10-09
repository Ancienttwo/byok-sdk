import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use the bundler from the workspace's existing tsup toolchain.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
const result = await build({
  stdin: {
    contents: "import {ClaudeAdapter,CodexAdapter,PiAdapter} from '@byok-sdk/client/adapters'; console.log(ClaudeAdapter,CodexAdapter,PiAdapter);",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  write: false,
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll('\\', '/'));
assert.equal(inputs.some((input) => input.includes('/zod/')), false,
  'adapters must not retain Zod through a protocol constant import');
assert.equal(inputs.some((input) => input.endsWith('/protocol/dist/index.js')), false,
  'adapters must use the schema-free preparation version entry');
assert.ok(result.outputFiles[0].contents.length > 0, 'bundle must contain the adapters');
console.log(`adapter bundle: ${result.outputFiles[0].contents.length} bytes; no protocol schemas or Zod`);
