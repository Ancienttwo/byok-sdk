// Run from any directory: bun examples/hosted-bot-collaboration-worker/src/build-member.mjs [output-directory]
import { mkdir, writeFile } from 'node:fs/promises';
import { memberPage } from './fixtures/sealed-canary/member-page.ts';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const output = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../_ops/p9/member-assets/', import.meta.url)));
await mkdir(output, { recursive: true });
const result = spawnSync('bun', ['build', fileURLToPath(new URL('./browser-member-page.ts', import.meta.url)),
  '--target=browser', '--minify', '--outfile', join(output, 'member.js')], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('browser member bundle failed');
await writeFile(join(output, 'index.html'), memberPage);
