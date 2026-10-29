import { promises as fs } from 'node:fs';
import path from 'node:path';
import { copyPiRuntimeAssets } from './pi/runtime-assets';
import { copySdkNativeAssets, sdkPackagingAssetLayout, sdkPackagingFormats, type SdkPackagingFormat } from '../sdk-native-assets';

export type { SdkPackagingFormat } from '../sdk-native-assets';

/** The part of an esbuild build that this plugin reads and sets. Declared here so esbuild is not an SDK dependency. */
export interface SdkPackagingBuild {
  readonly initialOptions: {
    bundle?: boolean;
    platform?: string;
    format?: string;
    define?: Record<string, string>;
    banner?: Record<string, string>;
    logOverride?: Record<string, string>;
  };
  onEnd(callback: (result: { readonly warnings: readonly SdkPackagingMessage[] }) => { errors: SdkPackagingMessage[] } | undefined): void;
}
/** The part of an esbuild message that this plugin reads and reports. */
export interface SdkPackagingMessage {
  readonly id?: string;
  readonly text: string;
  readonly location?: { readonly file: string; readonly line?: number; readonly column?: number; readonly lineText?: string } | null;
}
export interface SdkBundleImportMetaExemption {
  /** npm package name, as installed under `node_modules`. */
  readonly package: string;
  /** File within the package, `/`-separated. */
  readonly file: string;
  /** Why the empty `import.meta` is not reached, or what a bundle loses. */
  readonly reason: string;
}

/**
 * The reviewed third-party files whose `import.meta` esbuild empties in a CommonJS bundle of the SDK. Every other
 * empty `import.meta`, in any file, fails the build. The SDK's own files are never exempt. A test bundles the embedded
 * Host and requires exactly these files to warn, so an entry a dependency update made stale fails too.
 */
export const sdkBundleImportMetaExemptions: readonly SdkBundleImportMetaExemption[] = Object.freeze([
  Object.freeze({ package: '@earendil-works/pi-coding-agent', file: 'dist/core/extensions/loader.js',
    reason: "Pi's extension loader (import.meta.resolve) is not reached: runSdkReservedHelperCommand sets PI_BUNDLED_NODE, so Pi gives extensions its bundled packages." }),
  Object.freeze({ package: 'koffi', file: 'src/koffi/index.js',
    reason: "koffi's own native loader (import.meta.dirname) is not reached: with DaemonConfig.nativeAssetRoot the SDK loads the koffi addon itself." }),
  Object.freeze({ package: 'unpdf', file: 'dist/index.mjs',
    reason: 'unpdf resolves its standard font and CMap data with import.meta.resolve inside try/catch. In a CommonJS or SEA bundle that fails, so PDF reads lose the standard font and CMap defaults.' }),
]);

/** The installed package and file of a bundled module path; undefined outside `node_modules`. */
function bundleModuleSite(file: string): { readonly package: string; readonly file: string } | undefined {
  const normalized = file.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('node_modules/');
  if (at < 0) return undefined;
  const parts = normalized.slice(at + 'node_modules/'.length).split('/');
  const size = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length <= size) return undefined;
  return Object.freeze({ package: parts.slice(0, size).join('/'), file: parts.slice(size).join('/') });
}

function exempt(message: SdkPackagingMessage): boolean {
  const site = message.location ? bundleModuleSite(message.location.file) : undefined;
  return site !== undefined && sdkBundleImportMetaExemptions.some(entry => entry.package === site.package && entry.file === site.file);
}
/** Structurally an esbuild `Plugin`: pass it in `plugins`. */
export interface SdkPackagingPlugin {
  readonly name: string;
  setup(build: SdkPackagingBuild): void;
}
export interface ByokSdkPackagingOptions {
  readonly format: SdkPackagingFormat;
}

const IMPORT_META_URL = '__byok_sdk_import_meta_url';

/**
 * The esbuild plugin for a single-file Host bundle (`sdkPackagingFormats`). `sea` is the CommonJS bundle a Node SEA
 * embeds. The build must be a `platform: 'node'` bundle in the format's esbuild output format.
 *
 * - ESM: a module-scoped `require`, which the CommonJS dependencies of the bundled Pi host need for Node built-ins.
 * - CommonJS: `import.meta.url` is the bundle's own file URL (`__filename`; the executable inside a SEA). It is the only
 *   `import.meta` property SDK code reads, so a Host must not define it too.
 * - Every format: an empty `import.meta` is a build error in any file, SDK included, except the reviewed third-party
 *   sites in `sdkBundleImportMetaExemptions`, which stay visible as warnings. esbuild already rejects top-level `await`
 *   in CommonJS output. Neither is ever left for the bundle to hit at run time.
 */
export function byokSdkPackaging(options: ByokSdkPackagingOptions): SdkPackagingPlugin {
  const format = sdkPackagingFormats[options?.format];
  if (format === undefined) throw new Error(`byokSdkPackaging: unsupported format ${JSON.stringify(options?.format)}`);
  return Object.freeze({
    name: 'byok-sdk-packaging',
    setup(build: SdkPackagingBuild): void {
      const initial = build.initialOptions;
      if (initial.bundle !== true || initial.platform !== 'node' || initial.format !== format.esbuildFormat) {
        throw new Error(`byokSdkPackaging(${options.format}) requires bundle: true, platform: 'node' and format: '${format.esbuildFormat}'`);
      }
      const banner = initial.banner?.js;
      if (format.esbuildFormat === 'esm') {
        initial.banner = { ...initial.banner,
          js: `import { createRequire as __byokSdkCreateRequire } from 'node:module'; const require = __byokSdkCreateRequire(import.meta.url);${banner === undefined ? '' : `\n${banner}`}` };
      } else {
        if (initial.define !== undefined && Object.hasOwn(initial.define, 'import.meta.url')) {
          throw new Error('byokSdkPackaging: import.meta.url is defined by the SDK packaging plugin; remove the Host define');
        }
        initial.define = { ...initial.define, 'import.meta.url': IMPORT_META_URL };
        initial.banner = { ...initial.banner,
          js: `const ${IMPORT_META_URL} = require('node:url').pathToFileURL(__filename).href;${banner === undefined ? '' : `\n${banner}`}` };
      }
      // esbuild hides this warning in node_modules by default; the override reports it for every file.
      initial.logOverride = { ...initial.logOverride, 'empty-import-meta': 'warning' };
      build.onEnd(result => {
        const errors = result.warnings.filter(message => message.id === 'empty-import-meta' && !exempt(message))
          .map(message => ({ text: `byokSdkPackaging: ${message.text}; this bundle would run with an empty import.meta`, location: message.location ?? null }));
        return errors.length ? { errors } : undefined;
      });
    },
  });
}

export interface CopySdkPackagingAssetsOptions {
  /** A new or empty directory that ships beside the product bundle or executable. */
  readonly outDir: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'x64' | 'arm64';
}
/** Directories relative to `outDir`, for the product's daemon configuration and environment. */
export interface SdkPackagingAssets {
  /** Every written file, relative to `outDir`, sorted. */
  readonly files: readonly string[];
  /** `PI_PACKAGE_DIR` for the Pi host. */
  readonly piPackageDir: string;
  /** `DaemonConfig.nativeAssetRoot`; Windows x64 only. */
  readonly nativeAssetRoot?: string;
  /** `DaemonConfig.agentMemoryHelperAssetRoot`; macOS and Windows x64. Linux memory needs no helper. */
  readonly agentMemoryHelperAssetRoot?: string;
}

/**
 * Build-time copy of every SDK file a single-file Host ships for one target, in `sdkPackagingAssetLayout`: the Pi
 * runtime assets, and the native assets of the platforms that have them (`sdkNativeAssetTargets`). It composes
 * `copyPiRuntimeAssets` and `copySdkNativeAssets`, with their integrity checks; the Windows target downloads the
 * integrity-pinned koffi archive.
 */
export async function copySdkPackagingAssets(options: CopySdkPackagingAssetsOptions): Promise<SdkPackagingAssets> {
  const { outDir, platform, arch } = options;
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir) || /[\0\r\n]/u.test(outDir)) throw new Error('SDK packaging assets require an absolute output directory');
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
    throw new Error('SDK packaging assets: unsupported target');
  }
  const present = await fs.readdir(outDir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return []; });
  if (present.length) throw new Error('SDK packaging assets require a new or empty output directory');
  const layout = sdkPackagingAssetLayout;
  const pi = await copyPiRuntimeAssets({ outDir: path.join(outDir, layout.pi), form: sdkPackagingFormats.esm.piRuntimeForm });
  const files = pi.map(file => `${layout.pi}/${file}`);
  if (platform === 'linux') return Object.freeze({ files: Object.freeze(files.sort()), piPackageDir: layout.pi });
  const native = await copySdkNativeAssets({ outDir: path.join(outDir, layout.native), platform, arch });
  files.push(...native.map(file => `${layout.native}/${file}`));
  return Object.freeze({ files: Object.freeze(files.sort()), piPackageDir: layout.pi,
    ...(platform === 'win32' ? { nativeAssetRoot: layout.native } : {}), agentMemoryHelperAssetRoot: layout.agentMemoryHelper });
}
