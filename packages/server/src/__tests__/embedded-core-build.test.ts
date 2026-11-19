import { build } from 'esbuild';
import type { Options } from 'tsup';
import { expect, it } from 'vitest';
import config from '../../tsup.config.js';

it('rejects an unclassified core module in the embedded bundle', async () => {
  const plugin = (config as Options).esbuildPlugins!.find(item => item.name === 'embedded-core-public-dependencies')!;
  await expect(build({
    stdin: { contents: "import '../../core/src/stores.js';", resolveDir: process.cwd() + '/src', loader: 'ts' },
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [plugin],
  })).rejects.toThrow('Unclassified core module in embedded blob storage: stores.js');
});
