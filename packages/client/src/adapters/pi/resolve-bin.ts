import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The pi coding-agent CLI's real npm package name.
 *
 * IMPORTANT (empirically verified 2026-07-16, see the M0-3 report): the name
 * `@mariozechner/pi` — the identifier this task was originally briefed with —
 * is NOT the coding agent. On npm it resolves to an unrelated "CLI tool for
 * managing vLLM deployments on GPU pods" (bin: `pi-pods`). The real coding
 * agent was `@mariozechner/pi-coding-agent`, which is now deprecated in
 * favor of this package. `package.json` carries the exact supported version
 * as a required dependency; pi is a core BYOK capability, not an optional
 * enhancement or an unversioned global executable.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

export interface ResolvedBin {
  command: string;
  source: 'package' | 'env';
}

interface MinimalPackageJson {
  name?: string;
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
 * Resolve the pi CLI executable from the required package installed alongside
 * `@byok/client`. There is intentionally no automatic PATH fallback: a global
 * `pi` would create a second, unversioned authority for this core contract.
 *
 * `BYOK_PI_BIN` explicitly overrides the package when set: `PiAdapterOptions.resolveBin`
 * is the injectable seam for in-process tests, but the `byok-agent` CLI bin
 * only ever constructs `new PiAdapter()` with no options (see `createDaemon`),
 * so an out-of-process substitution (e.g. examples/basic's e2e run swapping
 * in the fake-pi fixture, or a single-file product injecting its required
 * Node 22.19+ pi sidecar) has no other seam to use.
 *
 * Deliberately does NOT use `createRequire(...).resolve()`: this package is
 * pure ESM with no `require` export condition (`exports["."]` only offers
 * `import`), so CJS-style resolution fails outright with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — empirically confirmed, not a hypothetical.
 * It also does NOT resolve the `./package.json` subpath directly (also not
 * exported by this package); instead it resolves the package's main entry
 * via `import.meta.resolve` and walks up parent directories to find the
 * package root (identified by a `package.json` whose `name` matches), which
 * is robust to `dist/` layout changes and to whether `./package.json` is
 * ever exported.
 */
export function resolvePiBin(): ResolvedBin {
  const override = process.env.BYOK_PI_BIN;
  if (override) {
    return { command: override, source: 'env' };
  }
  try {
    const mainEntryUrl = import.meta.resolve(PI_PACKAGE_NAME);
    let dir = path.dirname(fileURLToPath(mainEntryUrl));
    for (let depth = 0; depth < 6; depth++) {
      const pkg = readPackageJson(dir);
      if (pkg?.name === PI_PACKAGE_NAME) {
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        if (binRel) {
          return { command: path.join(dir, binRel), source: 'package' };
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (cause) {
    throw new Error(
      `Required ${PI_PACKAGE_NAME} could not be resolved; install @byok/client dependencies or set BYOK_PI_BIN to a Node 22.19+ pi sidecar`,
      { cause },
    );
  }
  throw new Error(
    `Required ${PI_PACKAGE_NAME} does not expose the pi CLI; reinstall the pinned dependency or set BYOK_PI_BIN to a Node 22.19+ pi sidecar`,
  );
}
