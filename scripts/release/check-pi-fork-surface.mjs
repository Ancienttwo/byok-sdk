#!/usr/bin/env node
/**
 * Guard the shrinking edge between BYOK and its self-maintained Pi fork.
 *
 * OP0 classified every place BYOK consumes the fork-only Pi surface
 * (`docs/researches/2026-09-19-official-pi-fork-delta-map.md`). OP3's job is to
 * remove those entries; nothing currently stops new ones from creeping in while
 * that happens.
 *
 * This check fails when a fork-only import appears somewhere that is not in the
 * recorded inventory. Removals are reported but do not fail: shrinking the
 * surface is the point of the migration, and an entry that disappears should
 * show up in review as a smaller number, not as a red check.
 *
 * Usage: node scripts/release/check-pi-fork-surface.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Subpaths that exist only in `@byok-sdk/pi-*`, never in the official release. */
export const FORK_ONLY_SUBPATHS = [
  '@earendil-works/pi-coding-agent/prepared-session-input',
  '@earendil-works/pi-coding-agent/input-preparation',
  '@earendil-works/pi-coding-agent/rpc-types',
];

/**
 * Every first-party file allowed to import a fork-only subpath, with the
 * approximate number of imports it holds. Shrink this list as OP3 lands.
 */
export const RECORDED_INVENTORY = {
  'api-surface/client.d.ts': 1,
  'packages/client/scripts/check-adapters-entry.mjs': 1,
  'packages/client/src/__tests__/dist-subpath-closure.test.ts': 1,
  'packages/client/src/__tests__/input-preparation-message-support-set.test.ts': 1,
  'packages/client/src/__tests__/input-preparation.test.ts': 1,
  'packages/client/src/__tests__/mcp-projection.test.ts': 1,
  'packages/client/src/__tests__/pi-prepared-launcher.test.ts': 1,
  'packages/client/src/__tests__/prepared-prompt-frame.test.ts': 1,
  'packages/client/src/adapters/pi/input-preparation.ts': 8,
  'packages/client/src/daemon/input-preparation-service.ts': 1,
  'packages/client/src/types.ts': 1,
};

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '_ops', '_ref', 'vendor']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js']);

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(full);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** Collect every fork-only import site, as `relativePath -> [{ line, specifier }]`. */
export function collectForkSurface(root = repoRoot) {
  const inventory = {};
  for (const directory of ['packages', 'scripts', 'api-surface', 'tests']) {
    const base = path.join(root, directory);
    let entries;
    try {
      entries = statSync(base);
    } catch {
      continue;
    }
    if (!entries.isDirectory()) continue;
    for (const file of walk(base)) {
      const relative = path.relative(root, file);
      if (relative.includes('/vendor/') || relative.startsWith('packages/client/vendor/')) continue;
      // The guard and its test name the specifiers in order to search for them.
      if (path.basename(relative).startsWith('check-pi-fork-surface')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      const hits = [];
      lines.forEach((line, index) => {
        for (const specifier of FORK_ONLY_SUBPATHS) {
          if (line.includes(specifier)) {
            hits.push({ line: index + 1, specifier });
            break;
          }
        }
      });
      if (hits.length > 0) inventory[relative] = hits;
    }
  }
  return inventory;
}

function main() {
  const inventory = collectForkSurface();
  const recorded = new Set(Object.keys(RECORDED_INVENTORY));
  const found = new Set(Object.keys(inventory));

  const added = [...found].filter((file) => !recorded.has(file)).sort();
  const removed = [...recorded].filter((file) => !found.has(file)).sort();
  const grown = Object.entries(inventory)
    .filter(([file, hits]) => recorded.has(file) && hits.length > RECORDED_INVENTORY[file])
    .map(([file, hits]) => ({ file, was: RECORDED_INVENTORY[file], now: hits.length }));
  const remaining = Object.values(inventory).reduce((total, hits) => total + hits.length, 0);

  // The migration's own scope: production source is what OP3/OP5 must remove.
  // Tests and build gates follow it; the generated API golden is downstream.
  const kinds = { source: [], test: [], script: [], golden: [] };
  for (const file of Object.keys(inventory)) {
    if (file.startsWith('api-surface/')) kinds.golden.push(file);
    else if (/\.(test|spec)\.[cm]?[jt]s$/.test(file) || file.includes('/__tests__/')) kinds.test.push(file);
    else if (file.endsWith('.mjs') || file.endsWith('.js')) kinds.script.push(file);
    else kinds.source.push(file);
  }
  const sourceImports = kinds.source.reduce((total, file) => total + inventory[file].length, 0);

  const report = {
    kind: 'pi-fork-surface',
    recordedFiles: recorded.size,
    remainingForkOnlyImports: remaining,
    productionSourceFiles: kinds.source.sort(),
    productionSourceImports: sourceImports,
    breakdown: {
      source: kinds.source.length,
      test: kinds.test.length,
      script: kinds.script.length,
      golden: kinds.golden.length,
    },
    added,
    grown,
    removed,
    inventory,
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[PiForkSurface] files=${found.size} fork-only-imports=${remaining} (production source: ${kinds.source.length} files / ${sourceImports} imports) added=${added.length} grown=${grown.length} removed=${removed.length}\n`,
    );
    for (const file of kinds.source.sort()) {
      process.stdout.write(`  source: ${file} (${inventory[file].length})\n`);
    }
    for (const file of added) {
      process.stdout.write(`  + new fork-only import site: ${file}\n`);
    }
    for (const entry of grown) {
      process.stdout.write(`  + ${entry.file}: ${entry.was} -> ${entry.now} imports\n`);
    }
    for (const file of removed) {
      process.stdout.write(`  - no longer importing the fork surface: ${file}\n`);
    }
  }

  if (added.length > 0 || grown.length > 0) {
    process.stderr.write(
      '[PiForkSurface] the migration only shrinks this surface. Remove the new import, or record it deliberately in RECORDED_INVENTORY with a reason.\n',
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
