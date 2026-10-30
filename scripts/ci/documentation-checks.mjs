import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** A generator/check pair and its registered drift test are one manifest-owned
 * documentation check. The selector never imports generator code to discover it.
 */
export function documentationChecks(cwd = process.cwd(), manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))) {
  const scripts = manifest.scripts ?? {};
  const tests = (scripts['test:scripts'] ?? '').split(' ');
  const checks = [];
  for (const [command, value] of Object.entries(scripts)) {
    const match = /^docs:([a-z0-9-]+)$/.exec(command);
    if (!match) continue;
    const name = match[1], source = `scripts/docs/${name}.mjs`, test = `scripts/docs/${name}.test.mjs`;
    if (value !== `node ${source} --write` || scripts[`check:${name}`] !== `node ${source}`
      || !tests.includes(test) || !existsSync(resolve(cwd, source)) || !existsSync(resolve(cwd, test))) {
      throw new Error(`Documentation check ${name} requires an exact generator/check pair and existing registered drift test`);
    }
    checks.push({ command, check: `check:${name}`, source, test });
  }
  return checks;
}

export function admitDocumentationScripts(before, after, cwd) {
  const checks = documentationChecks(cwd, after);
  for (const { command, check } of checks) {
    if (before.scripts?.[command] === undefined && before.scripts?.[check] === undefined) {
      delete after.scripts[command]; delete after.scripts[check];
    }
  }
  return new Set(checks.map(({ test }) => test));
}

/** Documentation projections can read SDK source, manifests and markdown.
 * Qualify their small registered drift suites for any such input; no guessed
 * import graph or generator-specific path table becomes a second authority.
 */
export function documentationTestsForPaths(paths, cwd = process.cwd()) {
  if (!paths.some(path => path === 'package.json' || /^docs\/.+\.md$/.test(path)
    || /^packages\/[^/]+\/(?:src\/|package\.json$)/.test(path) || /^scripts\/docs\//.test(path))) return [];
  return documentationChecks(cwd).map(({ test }) => test);
}
