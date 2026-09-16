import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * S2 release containment for the Pi launch path.
 *
 * Under S2 the SDK ships as one bundle next to its release, and every path the
 * Pi launch needs must come out of that release. Today the three producers all
 * resolve bare specifiers at RUNTIME, from whatever package graph the process
 * happens to sit in:
 *
 *   - `clientPackageRoot()`   — `adapters/pi/client-manifest.ts:23`
 *                               (`import.meta.resolve('@byok-sdk/client/package.json')`)
 *   - `resolvePiExtensions()` — `adapters/pi/resolve-extensions.ts:22,25,28`
 *                               (`pi-web-access`, `pi-subagents`, `@juicesharp/rpiv-todo`)
 *   - the prepared launch entry — `pi-adapter.ts:837`, a pure projection of
 *                               `clientPackageRoot()`, reproduced below because
 *                               it is module-private.
 *
 * Run from a directory with no `node_modules`, that resolution escapes into
 * bun's global install cache — or, with an empty cache, tries to auto-install.
 * Both are the same defect: the launch path is not contained by the release,
 * so a sealed entry and a trusted interpreter are attestable but not
 * meaningful.
 *
 * RED until the C07 P2/P3 release-derived launch description lands
 * (`tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`,
 * taste constraint "no bare-specifier resolution on the launch path").
 * Pre-fix evidence: `guards/pre-fix-claim-b.log` (root-cause-prover
 * scratchpad), which observed all six paths under `~/.bun/install/cache/`.
 */

/**
 * bun, if this machine has one. Resolved once, synchronously, so the case
 * below is either RUN or visibly SKIPPED — never a body that returns early and
 * reports as a pass. Mirrors `pi-mcp-launch-cwd.test.ts`.
 */
const BUN_BIN = ((): string | undefined => {
  const candidates = [
    process.env.BYOK_TEST_BUN_BIN,
    path.join(os.homedir(), '.local/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
})();

const CLIENT_MANIFEST_SRC = fileURLToPath(new URL('../adapters/pi/client-manifest.ts', import.meta.url));
const RESOLVE_EXTENSIONS_SRC = fileURLToPath(new URL('../adapters/pi/resolve-extensions.ts', import.meta.url));

/** Everything the Pi launch path must find inside its own release. */
const BUNDLE_ENTRY_SOURCE = [
  "import path from 'node:path';",
  `import { clientPackageRoot } from ${JSON.stringify(CLIENT_MANIFEST_SRC)};`,
  `import { resolvePiExtensions } from ${JSON.stringify(RESOLVE_EXTENSIONS_SRC)};`,
  '',
  'try {',
  '  const clientRoot = clientPackageRoot();',
  '  const extensions = resolvePiExtensions();',
  '  console.log(JSON.stringify({ ok: true, paths: {',
  '    clientPackageRoot: clientRoot,',
  "    // pi-adapter.ts:837 `preparedPiLaunchBin()` verbatim; it is module-private.",
  "    preparedPiLaunchBin: path.join(clientRoot, 'dist', 'bin', 'byok-pi-prepared.js'),",
  '    ...extensions,',
  '  } }));',
  '} catch (error) {',
  '  console.log(JSON.stringify({ ok: false, error: String(error) }));',
  '}',
  '',
].join('\n');

interface BundleResult {
  readonly ok: boolean;
  readonly paths?: Record<string, string>;
  readonly error?: string;
}

describe('Pi launch path — S2 release containment', () => {
  it.skipIf(BUN_BIN === undefined)(
    'resolves every Pi launch path inside the release, with no escape into the bun install cache and no auto-install',
    async () => {
      const bun = BUN_BIN!;
      const release = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-release-')));
      // No node_modules here, and nothing above it that belongs to this repo.
      const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-run-')));
      // An EMPTY cache: a contained launch path never writes into it.
      const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-cache-')));

      await fs.writeFile(path.join(release, 'sdk-entry.ts'), BUNDLE_ENTRY_SOURCE);
      await execFileAsync(bun, [
        'build', './sdk-entry.ts',
        '--target', 'bun',
        '--format', 'esm',
        '--outfile', './sdk-entry.js',
      ], { cwd: release });

      const bundle = path.join(release, 'sdk-entry.js');
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        BUN_INSTALL_CACHE_DIR: cacheDir,
      };

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(bun, [bundle], { cwd: runDir, env }));
      } catch (cause) {
        // With no network, the same defect surfaces as a failed auto-install
        // instead of an escaped path. Both mean "not contained by the
        // release", so this fails closed rather than skipping.
        throw new Error(
          'the S2 bundle could not resolve its Pi launch paths from the release at all '
          + `(no node_modules, empty BUN_INSTALL_CACHE_DIR): ${String(cause)}`,
        );
      }

      const line = stdout.trim().split('\n').at(-1) ?? '';
      let result: BundleResult;
      try {
        result = JSON.parse(line) as BundleResult;
      } catch {
        throw new Error(`the S2 bundle produced no containment report; stdout was: ${stdout.trim()}`);
      }
      if (result.ok !== true || result.paths === undefined) {
        throw new Error(
          `the S2 bundle's Pi launch paths are not contained by the release: resolution failed with ${result.error ?? 'no reason'}`,
        );
      }

      const escaped = Object.entries(result.paths)
        .filter(([, resolved]) =>
          !resolved.startsWith(release + path.sep) || resolved.includes(`${path.sep}install${path.sep}cache${path.sep}`))
        .map(([name, resolved]) => `${name} -> ${resolved}`);
      expect(escaped, `Pi launch paths resolved outside the release ${release}`).toEqual([]);

      expect(await fs.readdir(cacheDir), 'the S2 launch path auto-installed into the bun cache').toEqual([]);
    },
    120_000,
  );
});
