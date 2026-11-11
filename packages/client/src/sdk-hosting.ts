import { statSync } from 'node:fs';
import path from 'node:path';
import { sdkPackagingTarget } from './sdk-native-assets.js';
import type { SdkHelperHostConfig } from './sdk-reserved-helper-host.js';

export interface SdkHostingOptions {
  /** Absolute path of the directory `copySdkPackagingAssets` wrote for this platform and architecture. */
  readonly assetRoot: string;
  /** Passed through unchanged; `DaemonConfig` validates it. */
  readonly helperHost: SdkHelperHostConfig;
}
/** The SDK hosting values of a packaged Host, all derived from one asset root. */
export interface SdkHosting {
  /** Spread into `DaemonConfig`; `nativeAssetRoot` is also the `readDeviceEnrollmentStatus` option. */
  readonly daemon: { readonly sdkHelperHost: SdkHelperHostConfig; readonly nativeAssetRoot?: string; readonly agentMemoryHelperAssetRoot?: string };
  /** Spread into `RuntimeAdaptersConfig`; merge `runtimes.pi` into the Host's own `runtimes`. */
  readonly adapters: { readonly sdkHelperHost: SdkHelperHostConfig; readonly nativeAssetRoot?: string; readonly runtimes: { readonly pi: { readonly packageDir: string } } };
}

/** The asset root lacks files that `copySdkPackagingAssets` always writes for the running platform and architecture. */
export class SdkHostingAssetsMissingError extends Error {
  readonly code = 'sdk_hosting_assets_missing' as const;
  /** Relative to the asset root, `/`-separated, sorted. */
  readonly missing: readonly string[];
  constructor(assetRoot: string, missing: readonly string[]) {
    super(`SDK hosting assets missing under ${assetRoot}: ${missing.join(', ')}`);
    this.name = 'SdkHostingAssetsMissingError';
    this.missing = Object.freeze([...missing]);
  }
}

/**
 * The runtime counterpart of `copySdkPackagingAssets`: resolves every SDK hosting value from the shipped asset root, for
 * `process.platform` and `process.arch`, the target the asset consumers load for. Checks that each file the build always
 * writes for that target exists (digests stay with the consumers) and throws `SdkHostingAssetsMissingError` with every
 * missing path, so a Host fails at startup rather than at the first native or Pi use.
 */
export function resolveSdkHosting(options: SdkHostingOptions): SdkHosting {
  const assetRoot = options?.assetRoot;
  if (typeof assetRoot !== 'string' || !path.isAbsolute(assetRoot) || /[\0\r\n]/u.test(assetRoot)) {
    throw new Error('resolveSdkHosting: assetRoot must be an absolute directory');
  }
  const target = sdkPackagingTarget(process.platform, process.arch);
  const missing = target.requiredFiles.filter(file => statSync(path.join(assetRoot, file), { throwIfNoEntry: false })?.isFile() !== true);
  if (missing.length) throw new SdkHostingAssetsMissingError(assetRoot, missing);
  const absolute = (relative: string | undefined) => (relative === undefined ? undefined : path.join(assetRoot, relative));
  const sdkHelperHost = options.helperHost;
  const nativeAssetRoot = absolute(target.nativeAssetRoot);
  const agentMemoryHelperAssetRoot = absolute(target.agentMemoryHelperAssetRoot);
  const native = nativeAssetRoot === undefined ? {} : { nativeAssetRoot };
  return Object.freeze({
    daemon: Object.freeze({ sdkHelperHost, ...native, ...(agentMemoryHelperAssetRoot === undefined ? {} : { agentMemoryHelperAssetRoot }) }),
    adapters: Object.freeze({ sdkHelperHost, ...native, runtimes: Object.freeze({ pi: Object.freeze({ packageDir: path.join(assetRoot, target.piPackageDir) }) }) }),
  });
}
