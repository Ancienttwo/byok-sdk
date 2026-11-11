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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import brand from './brand.config.ts';
import manifest from './package.json' with { type: 'json' };
import { flipAppFuses } from './src/main/fuses.ts';

// Absolute paths: scripts/package/build.mjs runs electron-builder with the staged
// app as its project, so electron-builder finds no node_modules to add to the asar.
const at = (...parts) => fileURLToPath(new URL(parts.join('/'), import.meta.url));
const entitlements = at('scripts/package/entitlements-mac.plist');

const env = process.env;
const macIdentity = env.CSC_LINK || env.CSC_NAME ? undefined : '-';
const notarize = Boolean(env.APPLE_API_KEY || env.APPLE_ID);
const feed = env.BYOK_UPDATE_FEED_URL;

/** Flips the app fuses (src/main/fuses.ts) right after packing, before electron-builder signs. */
async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  if (platform === 'darwin') return flipAppFuses(path.join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name));
  if (platform === 'win32') return flipAppFuses(path.join(context.appOutDir, `${name}.exe`));
  if (platform === 'linux') return flipAppFuses(path.join(context.appOutDir, context.packager.executableName));
  throw new Error(`No fuse target for ${platform}`);
}

export default {
  appId: `io.byok-sdk.${brand.productId}`,
  productName: brand.productName,
  electronVersion: manifest.devDependencies.electron,
  directories: { app: at('dist/package/stage/app'), output: at('dist/package/out'), buildResources: at('scripts/package') },
  asar: true,
  npmRebuild: false,
  extraResources: [{ from: at('dist/package/stage/host'), to: 'host' }],
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
};
