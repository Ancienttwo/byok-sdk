// Run from any directory: bun examples/hosted-bot-collaboration-worker/build-member.mjs
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const output = new URL('../../_ops/p9/member-assets/', import.meta.url);
await mkdir(output, { recursive: true });
const result = spawnSync('bun', ['build', fileURLToPath(new URL('./src/browser-member-page.ts', import.meta.url)),
  '--target=browser', '--minify', '--outfile', fileURLToPath(new URL('member.js', output))], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('browser member bundle failed');
await copyFile(new URL('./src/fixtures/sealed-canary/member.html', import.meta.url), new URL('index.html', output));
