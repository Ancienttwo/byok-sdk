// Packages the desktop app for this machine's platform and architecture:
// macOS DMG + ZIP, Windows NSIS, Linux AppImage + deb (electron-builder.config.mjs).
// The SEA Host is made from this machine's Node, so a package is built on its
// own platform and arch.
//
//   bun run package    (runs `bun run build` first; macOS and Windows also need
//                       the Agent memory helper, see bundle-host.mjs)
//
// Output: dist/package/out. dist/package/stage keeps what went in, for package-smoke.mjs.
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { build } from 'electron-builder';
import config from '../../electron-builder.config.mjs';
import manifest from '../../package.json' with { type: 'json' };
import { bundleHost } from './bundle-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const at = (...parts) => path.join(root, ...parts);
const stage = at('dist', 'package', 'stage');
rmSync(at('dist', 'package'), { recursive: true, force: true });

// app/ becomes the asar. Main is one ESM bundle, so the asar holds no node_modules;
// the preload and renderer come from the tsc build at the paths main resolves in dev.
const app = path.join(stage, 'app');
await bundle({ entryPoints: [at('src', 'main', 'index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24',
  outfile: path.join(app, 'dist', 'src', 'main', 'index.js'), external: ['electron'], logLevel: 'warning',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
for (const part of ['preload', 'renderer']) cpSync(at('dist', 'src', part), path.join(app, 'dist', 'src', part), { recursive: true });
// Main resolves its tray icons under assets/ at the app root, as in dev.
cpSync(at('assets'), path.join(app, 'assets'), { recursive: true });
writeFileSync(path.join(app, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version,
  description: manifest.description, license: manifest.license, type: 'module', main: 'dist/src/main/index.js' }, null, 2)}\n`);

// host/ ships outside the asar as resources/host/.
await bundleHost({ format: 'sea', outDir: path.join(stage, 'host') });

await build({ projectDir: app, config, publish: 'never' });
