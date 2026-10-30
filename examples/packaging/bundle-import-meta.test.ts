// #1104: the SDK packaging plugin on real esbuild builds. A CommonJS bundle of the
// embedded Host warns at exactly the reviewed third-party exemptions: a new SDK or
// dependency site fails the build, and an exemption a dependency update removed
// fails here. The run itself is the packaging consistency lane (embedded-host-smoke.mjs).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { afterEach, expect, it } from 'vitest';
import { byokSdkPackaging, sdkBundleImportMetaExemptions } from '@byok-sdk/client/packaging';

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function work(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pkg-'));
  dirs.push(dir);
  return dir;
}
function options(entry: string, format: 'esm' | 'cjs' | 'sea', outfile: string): BuildOptions {
  return { entryPoints: [entry], bundle: true, platform: 'node', format: format === 'esm' ? 'esm' : 'cjs', target: 'node24',
    outfile, logLevel: 'silent', write: false, plugins: [byokSdkPackaging({ format })] };
}
const exemptionKeys = sdkBundleImportMetaExemptions.map(site => `${site.package}/${site.file}`).sort();

it('a CommonJS bundle of the embedded Host warns at exactly the reviewed exemptions', async () => {
  const result = await build(options(path.join(here, 'embedded-host-fixture.ts'), 'cjs', path.join(await work(), 'host.cjs')));
  const sites = result.warnings.map(warning => {
    const file = warning.location?.file.replaceAll('\\', '/') ?? '';
    const site = sdkBundleImportMetaExemptions.find(entry => file.endsWith(`node_modules/${entry.package}/${entry.file}`));
    return `${warning.id} ${site === undefined ? file : `${site.package}/${site.file}`}`;
  });
  expect([...new Set(sites)].sort()).toEqual(exemptionKeys.map(key => `empty-import-meta ${key}`));
  expect(result.errors).toEqual([]);
});

it('fails the build on any other empty import.meta, in CommonJS and SEA', async () => {
  const dir = await work();
  const entry = path.join(dir, 'host.ts');
  await writeFile(entry, 'console.log(import.meta.dirname);\n');
  for (const format of ['cjs', 'sea'] as const) {
    await expect(build(options(entry, format, path.join(dir, `${format}.cjs`)))).rejects.toThrow(/byokSdkPackaging: "import\.meta" is not available/);
  }
});

it('defines import.meta.url as the bundle file in CommonJS, and gives ESM a module require', async () => {
  const dir = await work();
  const entry = path.join(dir, 'host.ts');
  await writeFile(entry, "import { fileURLToPath } from 'node:url';\nconsole.log(fileURLToPath(import.meta.url), typeof require);\n");
  const cjs = await build(options(entry, 'cjs', path.join(dir, 'host.cjs')));
  expect(cjs.warnings).toEqual([]);
  expect(cjs.outputFiles![0]!.text).toContain("require('node:url').pathToFileURL(__filename).href");
  const esm = await build(options(entry, 'esm', path.join(dir, 'host.mjs')));
  expect(esm.outputFiles![0]!.text).toMatch(/^import \{ createRequire as __byokSdkCreateRequire \} from 'node:module'; const require = __byokSdkCreateRequire\(import\.meta\.url\);/);
});

it('rejects top-level await in CommonJS, a Host import.meta.url define and a mismatched build', async () => {
  const dir = await work();
  const entry = path.join(dir, 'host.ts');
  await writeFile(entry, 'await Promise.resolve();\nexport {};\n');
  await expect(build(options(entry, 'cjs', path.join(dir, 'host.cjs')))).rejects.toThrow(/Top-level await is currently not supported/);
  await expect(build({ ...options(entry, 'cjs', path.join(dir, 'host.cjs')), define: { 'import.meta.url': '"file:///x"' } }))
    .rejects.toThrow('import.meta.url is defined by the SDK packaging plugin');
  await expect(build({ ...options(entry, 'esm', path.join(dir, 'host.mjs')), format: 'cjs' })).rejects.toThrow("requires bundle: true, platform: 'node' and format: 'esm'");
  expect(() => byokSdkPackaging({ format: 'iife' as never })).toThrow('unsupported format');
});
