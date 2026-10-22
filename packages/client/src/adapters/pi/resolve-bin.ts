import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClientPiRuntimePin } from './client-manifest';

/**
 * The module specifier every Pi import and resolution in this package uses.
 *
 * IMPORTANT (empirically verified 2026-07-16, see the M0-3 report): the name
 * `@mariozechner/pi` — the identifier this task was originally briefed with —
 * is NOT the coding agent. On npm it resolves to an unrelated "CLI tool for
 * managing vLLM deployments on GPU pods" (bin: `pi-pods`). The real coding
 * agent was `@mariozechner/pi-coding-agent`, which is now deprecated in
 * favor of this package. pi is a core BYOK capability, not an optional
 * enhancement or an unversioned global executable.
 *
 * This constant is both the resolution specifier and the installed identity's
 * name: `packages/client/package.json` pins it to one exact official version
 * (`byok.piRuntimePin` projects that dependency), and the manifest on disk must
 * be the official package at exactly that version.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/**
 * One exact `x.y.z` version. Ranges, dist-tags and npm aliases are all
 * rejected: a runtime whose identity is not exactly known cannot be checked
 * against what was actually installed.
 */
const PI_EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export interface ResolvedBin {
  command: string;
  source: 'package' | 'env';
}

/** The exact package `PI_PACKAGE_NAME` must resolve to on disk. */
export interface PiRuntimeIdentity {
  /** Manifest `name` of the installed runtime: always {@link PI_PACKAGE_NAME}. */
  readonly name: string;
  /** Manifest `version` of the installed runtime. */
  readonly version: string;
}

interface MinimalPackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

function readPackageJson(dir: string): MinimalPackageJson | undefined {
  const candidate = path.join(dir, 'package.json');
  if (!existsSync(candidate)) return undefined;
  try {
    return JSON.parse(readFileSync(candidate, 'utf8')) as MinimalPackageJson;
  } catch {
    return undefined;
  }
}

/**
 * Read the exact Pi runtime identity this build of `@byok-sdk/client` pins,
 * from the one place that declares it: the client's own manifest dependency on
 * `PI_PACKAGE_NAME`.
 */
export function resolvePiRuntimeIdentity(): PiRuntimeIdentity {
  const spec = readClientPiRuntimePin();
  if (spec === undefined) {
    throw new Error(
      `@byok-sdk/client does not declare a ${PI_PACKAGE_NAME} dependency; ${PI_BIN_REMEDY}`,
    );
  }
  if (!PI_EXACT_VERSION.test(spec)) {
    throw new Error(
      `@byok-sdk/client pins ${PI_PACKAGE_NAME} to ${spec}, which is not one exact x.y.z version; the Pi runtime identity must be exact`,
    );
  }
  return { name: PI_PACKAGE_NAME, version: spec };
}

/**
 * The installed directory of `name`, found the way Node's ESM resolver finds a
 * bare specifier: the first `node_modules/<name>` directory in this module's
 * ancestor chain, through symlinks. It reads no package `exports`, so it also
 * finds an import-only package. It needs only `import.meta.url`, so a CommonJS
 * product bundle that defines it resolves the same way (#724).
 */
function locateInstalledPackageDir(name: string): string | undefined {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(candidate)) return realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * The installed root of the pinned official Pi package. Its manifest name and
 * version must both equal the client pin; a mismatch fails closed instead of
 * returning an unverified runtime. `remedy` ends every refusal.
 *
 * Deliberately does NOT use `createRequire(...).resolve()`: this package is
 * pure ESM with no `require` export condition (`exports["."]` only offers
 * `import`), so CJS-style resolution fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. It does not use `import.meta.resolve`
 * either, which a CommonJS bundle does not have. It locates the package
 * directory itself; the root is the same one ESM resolution reaches.
 */
export function resolvePinnedPiPackage(remedy: string): {
  readonly dir: string;
  readonly identity: PiRuntimeIdentity;
  readonly bin: string | Record<string, string> | undefined;
} {
  const expected = resolvePiRuntimeIdentity();
  const dir = locateInstalledPackageDir(PI_PACKAGE_NAME);
  const manifest = dir === undefined ? undefined : readPackageJson(dir);
  if (dir === undefined || manifest === undefined) {
    throw new Error(`Required ${PI_PACKAGE_NAME} could not be resolved; ${remedy}`);
  }
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    throw new Error(
      `${PI_PACKAGE_NAME} resolved to ${String(manifest.name)}@${String(manifest.version)}, but @byok-sdk/client pins ${expected.name}@${expected.version}; ${remedy}`,
    );
  }
  return { dir, identity: expected, bin: manifest.bin };
}

const PI_BIN_REMEDY = 'reinstall @byok-sdk/client dependencies, or ship pi through sdkHelperHost and copyPiRuntimeAssets';

/**
 * Resolve the pi CLI executable from the required package installed alongside
 * `@byok-sdk/client`. There is intentionally no automatic PATH fallback: a
 * global `pi` would create a second, unversioned authority for this contract.
 *
 * `BYOK_PI_BIN` overrides the package for tests and e2e runs only.
 * `PiAdapterOptions.resolveBin` is the seam for in-process tests.
 * The `byok-agent` CLI constructs `new PiAdapter()` with no options, so e2e
 * runs use the env override to select a fake-pi fixture.
 */
export function resolvePiBin(): ResolvedBin {
  const override = process.env.BYOK_PI_BIN;
  if (override) {
    return { command: override, source: 'env' };
  }
  const root = resolvePinnedPiPackage(PI_BIN_REMEDY);
  const binRel = typeof root.bin === 'string' ? root.bin : root.bin?.pi;
  if (binRel === undefined) {
    throw new Error(
      `Required ${root.identity.name}@${root.identity.version} does not expose the pi CLI; ${PI_BIN_REMEDY}`,
    );
  }
  return { command: path.join(root.dir, binRel), source: 'package' };
}
