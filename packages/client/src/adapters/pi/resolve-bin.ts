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
 * agent was `@mariozechner/pi-coding-agent`, which is now itself deprecated
 * in favor of this package (same maintainers: badlogic, mitsuhiko), as of
 * literally the day before this was written. `package.json` pins the
 * `legacy-node20` dist-tag (0.74.2) rather than `latest` (0.80.7), because
 * `latest` requires Node >=22.19 while this SDK's baseline is Node >=20;
 * both versions were empirically confirmed to speak the identical RPC-mode
 * frame shapes this adapter depends on.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

export interface ResolvedBin {
  command: string;
  source: 'package' | 'path';
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
 * Resolve the pi CLI executable. Prefers the optionalDependency installed
 * alongside @byok/client (guarantees a known-good, version-matched build);
 * falls back to whatever `pi` is on PATH so users with a pre-existing global
 * pi install still work even when the optionalDependency didn't install.
 *
 * `BYOK_PI_BIN` overrides both of the above when set: `PiAdapterOptions.resolveBin`
 * is the injectable seam for in-process tests, but the `byok-agent` CLI bin
 * only ever constructs `new PiAdapter()` with no options (see `createDaemon`),
 * so an out-of-process substitution (e.g. examples/basic's e2e run swapping
 * in the fake-pi fixture ahead of a real pi install) has no other seam to use.
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
    return { command: override, source: 'path' };
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
  } catch {
    // optionalDependency not installed, or resolution failed — fall through to PATH.
  }
  return { command: 'pi', source: 'path' };
}
