// electron-builder configuration of the packaged app. scripts/package/build.mjs
// fills dist/package/stage first: app/ is the bundled main, preload and renderer
// (the asar), host/ is the SEA Host with the SDK assets, shipped outside the asar
// as resources/host/.
//
// Signing reads the environment only (#1499 D10); no file in this repository
// holds signing material. Unset, macOS signs ad hoc (a fused Electron binary
// does not start unsigned on arm64), Windows and Linux stay unsigned.
//   macOS:   CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME (Developer ID Application);
//            notarization with APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER,
//            or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
//   Windows: CSC_LINK + CSC_KEY_PASSWORD (or WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD).
// The update feed is BYOK_UPDATE_FEED_URL (a generic provider); unset, the app
// ships without app-update.yml and its updater stays off.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch } from 'electron-builder';
import brand from './brand.config.ts';
import manifest from './package.json' with { type: 'json' };
import { codecFreeFfmpeg, packagedFfmpeg } from './scripts/package/ffmpeg.mjs';
import { NOTICES_FILE } from './scripts/package/notices.mjs';
import { flipAppFuses } from './src/main/fuses.ts';

// Absolute paths: scripts/package/build.mjs runs electron-builder with the staged
// app as its project, so electron-builder finds no node_modules to add to the asar.
const at = (...parts) => fileURLToPath(new URL(parts.join('/'), import.meta.url));
const entitlements = at('scripts/package/entitlements-mac.plist');

const env = process.env;
const macIdentity = env.CSC_LINK || env.CSC_NAME ? undefined : '-';
const notarize = Boolean(env.APPLE_API_KEY || env.APPLE_ID);
const feed = env.BYOK_UPDATE_FEED_URL;

/**
 * Right after packing, before electron-builder signs: swaps in the codec-free
 * ffmpeg (scripts/package/ffmpeg.mjs), then flips the app fuses (src/main/fuses.ts).
 */
async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  const app = platform === 'darwin' ? path.join(context.appOutDir, `${name}.app`) : context.appOutDir;
  const ffmpeg = packagedFfmpeg(app, platform);
  if (!existsSync(ffmpeg)) throw new Error(`Electron's ffmpeg is not at ${ffmpeg}`);
  writeFileSync(ffmpeg, await codecFreeFfmpeg({ version: manifest.devDependencies.electron, platform, arch: Arch[context.arch] }));
  console.log(`[afterPack] codec-free ffmpeg ${JSON.stringify({
    artifact: `ffmpeg-v${manifest.devDependencies.electron}-${platform}-${Arch[context.arch]}.zip`, destination: ffmpeg,
    rawSha256: createHash('sha256').update(readFileSync(ffmpeg)).digest('hex'),
  })}`);
  if (platform === 'darwin') return flipAppFuses(path.join(app, 'Contents', 'MacOS', name));
  if (platform === 'win32') return flipAppFuses(path.join(app, `${name}.exe`));
  if (platform === 'linux') return flipAppFuses(path.join(app, context.packager.executableName));
  throw new Error(`No fuse target for ${platform}`);
}

export default {
  appId: `io.byok-sdk.${brand.productId}`,
  productName: brand.productName,
  electronVersion: manifest.devDependencies.electron,
  // The deb takes its package name from `name` (a scoped workspace name is not a
  // valid one) and requires a homepage. A fork sets its own homepage here.
  extraMetadata: { name: brand.productId, homepage: 'https://github.com/Ancienttwo/byok-sdk' },
  directories: { app: at('dist/package/stage/app'), output: at('dist/package/out'), buildResources: at('scripts/package') },
  asar: true,
  npmRebuild: false,
  extraResources: [{ from: at('dist/package/stage/host'), to: 'host' }, { from: at('dist/package/stage', NOTICES_FILE), to: NOTICES_FILE }],
  afterPack,
  publish: feed ? [{ provider: 'generic', url: feed }] : null,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    identity: macIdentity,
    hardenedRuntime: true,
    // The SEA Host under resources/host inherits these; V8 needs allow-jit under the hardened runtime.
    entitlements,
    entitlementsInherit: entitlements,
    notarize,
  },
  win: {
    target: ['nsis'],
    // koffi.node ships unsigned and the SDK refuses a modified addon, so no signing pass may reach a .node file.
    signExts: ['!.node'],
  },
  nsis: { oneClick: true, perMachine: false },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    executableName: brand.productId,
    maintainer: brand.productName,
  },
  deb: {
    // Replaces electron-builder's default list, so it repeats that list (app-builder-lib
    // FpmTarget getDefaultDepends) and adds secret-tool, which the keys store and the
    // device credential use on Linux (#1499 3.2); without it key entry fails closed.
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libsecret-tools'],
  },
};
