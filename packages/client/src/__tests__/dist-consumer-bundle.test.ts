import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const clientRoot = fileURLToPath(new URL('../..', import.meta.url));
const requireFromClient = createRequire(path.join(clientRoot, 'package.json'));
// esbuild is the bundler downstream hosts use; take tsup's copy instead of a new dependency.
const esbuild = createRequire(requireFromClient.resolve('tsup'))('esbuild') as {
  build(options: Record<string, unknown>): Promise<unknown>;
};

/**
 * A consumer that bundles the root entry into one file shares one
 * `import.meta` across every inlined module, so `import.meta.main` is true for
 * all of them. Importing the root entry must still run nothing at load time.
 */
describe('dist/index.js inside a consumer single-file bundle', () => {
  it('loads under node without running any inlined CLI entry', async () => {
    // The scratch dir sits inside the package so externals resolve from its node_modules.
    const scratch = mkdtempSync(path.join(clientRoot, 'node_modules', '.consumer-bundle-'));
    try {
      const entry = path.join(scratch, 'entry.mjs');
      const outfile = path.join(scratch, 'bundle.mjs');
      writeFileSync(entry, `import { BYOK_SDK_HELPER_SUBCOMMAND } from ${JSON.stringify(path.join(clientRoot, 'dist/index.js'))};\nconsole.log('loaded', BYOK_SDK_HELPER_SUBCOMMAND);\n`);
      await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      });
      const { stdout, stderr } = await execFileAsync(process.execPath, [outfile], { cwd: scratch, timeout: 60_000 });
      expect(stderr).toBe('');
      expect(stdout).toBe('loaded __byok_sdk_helper\n');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
