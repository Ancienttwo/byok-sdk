import { existsSync, readFileSync } from 'node:fs';
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
 * This constant is the *resolution specifier* only. The *installed identity*
 * behind it is a separate fact: `packages/client/package.json` pins this
 * specifier to an exact npm alias (`npm:<name>@<x.y.z>`), because the SDK ships
 * a fork of the upstream runtime. The specifier and the on-disk path stay
 * `@earendil-works/pi-coding-agent`, so every import site and every extension
 * path is unchanged; only the manifest inside that directory carries the fork's
 * own name and version. `resolvePiRuntimeIdentity()` derives that identity from
 * the same manifest entry, so there is exactly one authority for both.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/**
 * `npm:<package name>@<exact x.y.z>`. Ranges, dist-tags and bare versions are
 * all rejected: a runtime whose identity is not exactly known cannot be checked
 * against what was actually installed.
 */
const PI_ALIAS_SPEC =
  /^npm:(@[^/@\s]+\/[^/@\s]+|[^@/\s][^/@\s]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export interface ResolvedBin {
  command: string;
  source: 'package' | 'env';
}

/** The exact package `PI_PACKAGE_NAME` must resolve to on disk. */
export interface PiRuntimeIdentity {
  /** Manifest `name` of the installed runtime (the fork's own scope). */
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
      `@byok-sdk/client does not declare a ${PI_PACKAGE_NAME} dependency; reinstall @byok-sdk/client or set BYOK_PI_BIN to a Node 22.22+ pi sidecar`,
    );
  }
  const match = PI_ALIAS_SPEC.exec(spec);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(
      `@byok-sdk/client pins ${PI_PACKAGE_NAME} to ${spec}, which is not an exact npm:<name>@<x.y.z> alias; the Pi runtime identity must be exact`,
    );
  }
  return { name: match[1], version: match[2] };
}

function findPackageRoot(
  startDir: string,
): { dir: string; manifest: MinimalPackageJson } | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const manifest = readPackageJson(dir);
    if (manifest?.name !== undefined) return { dir, manifest };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the pi CLI executable from the required package installed alongside
 * `@byok-sdk/client`. There is intentionally no automatic PATH fallback: a
 * global `pi` would create a second, unversioned authority for this contract.
 *
 * `BYOK_PI_BIN` explicitly overrides the package when set: `PiAdapterOptions.resolveBin`
 * is the injectable seam for in-process tests, but the `byok-agent` CLI bin
 * only ever constructs `new PiAdapter()` with no options (see `createDaemon`),
 * so an out-of-process substitution (e.g. examples/basic's e2e run swapping
 * in the fake-pi fixture, or a single-file product injecting its required
 * Node 22.22+ pi sidecar) has no other seam to use.
 *
 * Deliberately does NOT use `createRequire(...).resolve()`: this package is
 * pure ESM with no `require` export condition (`exports["."]` only offers
 * `import`), so CJS-style resolution fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. It also does NOT resolve the
 * `./package.json` subpath directly (also not exported); instead it resolves
 * the package's main entry via `import.meta.resolve` and walks upward to the
 * enclosing package root.
 *
 * That root's manifest name is NOT `PI_PACKAGE_NAME`: the specifier is an npm
 * alias for the SDK's fork, so the installed manifest carries the fork's own
 * name and version. Both are compared against the pin, and a mismatch fails
 * closed instead of launching an unverified runtime.
 */
export function resolvePiBin(): ResolvedBin {
  const override = process.env.BYOK_PI_BIN;
  if (override) {
    return { command: override, source: 'env' };
  }
  const expected = resolvePiRuntimeIdentity();
  let mainEntry: string;
  try {
    mainEntry = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
  } catch (cause) {
    throw new Error(
      `Required ${PI_PACKAGE_NAME} could not be resolved; install @byok-sdk/client dependencies or set BYOK_PI_BIN to a Node 22.22+ pi sidecar`,
      { cause },
    );
  }
  const root = findPackageRoot(path.dirname(mainEntry));
  if (root === undefined) {
    throw new Error(
      `Required ${PI_PACKAGE_NAME} resolved to ${mainEntry}, which has no enclosing package manifest; reinstall @byok-sdk/client dependencies or set BYOK_PI_BIN to a Node 22.22+ pi sidecar`,
    );
  }
  if (root.manifest.name !== expected.name || root.manifest.version !== expected.version) {
    throw new Error(
      `${PI_PACKAGE_NAME} resolved to ${String(root.manifest.name)}@${String(root.manifest.version)}, but @byok-sdk/client pins ${expected.name}@${expected.version}; reinstall the pinned dependency or set BYOK_PI_BIN to a Node 22.22+ pi sidecar`,
    );
  }
  const binRel = typeof root.manifest.bin === 'string' ? root.manifest.bin : root.manifest.bin?.pi;
  if (binRel === undefined) {
    throw new Error(
      `Required ${expected.name}@${expected.version} does not expose the pi CLI; reinstall the pinned dependency or set BYOK_PI_BIN to a Node 22.22+ pi sidecar`,
    );
  }
  return { command: path.join(root.dir, binRel), source: 'package' };
}
