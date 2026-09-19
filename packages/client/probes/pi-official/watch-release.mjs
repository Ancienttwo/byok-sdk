#!/usr/bin/env node
/**
 * Release watch for the official-Pi migration.
 *
 * The migration is gated on official releases: OP1 measured the pinned candidate
 * (`0.85.1`) and upstream `main` has already rebuilt one of the subsystems the
 * measurement depends on. This script answers one question cheaply and without
 * touching the repository:
 *
 *   "has a newer official release appeared, and if so, what exactly do I re-run?"
 *
 * It never installs or modifies anything. It reads the pinned candidate out of
 * the OP0 baseline, asks the registry for the current tags, and prints the
 * re-baseline command when the answer changed.
 *
 * Usage: node packages/client/probes/pi-official/watch-release.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const baselinePath = path.join(repoRoot, 'docs', 'researches', '2026-09-19-official-pi-baseline.json');
const asJson = process.argv.includes('--json');

function registryTags(packageName) {
  const raw = execFileSync('npm', ['view', packageName, 'dist-tags', '--json'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const packages = baseline.officialCandidate.packages.map((entry) => ({
  name: entry.name,
  pinned: entry.version,
}));

const results = packages.map((entry) => {
  let latest;
  let error;
  try {
    latest = registryTags(entry.name).latest;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    name: entry.name,
    pinned: entry.pinned,
    latest: latest ?? null,
    changed: latest !== undefined && latest !== entry.pinned,
    error: error ?? null,
  };
});

const changed = results.filter((entry) => entry.changed);
const codingAgent = results.find((entry) => entry.name === '@earendil-works/pi-coding-agent');

const report = {
  kind: 'official-pi-release-watch',
  checkedAt: new Date().toISOString(),
  baseline: path.relative(repoRoot, baselinePath),
  packages: results,
  moved: changed.length > 0,
  nextActions: changed.length > 0
    ? [
        `node packages/client/probes/pi-official/run.mjs --official-version ${codingAgent?.latest ?? '<new-version>'}`,
        'Update the OP0 baseline candidate, then re-read OP1 G1 before touching OP2-U or OP3.',
        'Re-check upstream main for the G-A/G-B/G-C seams before writing the upstream patch.',
      ]
    : [
        'No newer official release. Keep the prepared production path disabled and keep the fork as the shipping runtime.',
        'The pending upstream work is the G-C patch (host-asserted assistant history) plus G-A/G-B; see docs/researches/2026-09-19-official-pi-op2u-upstream-request.md.',
      ],
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (changed.length > 0) {
  for (const entry of changed) {
    process.stdout.write(`MOVED  ${entry.name}: pinned ${entry.pinned} -> latest ${entry.latest}\n`);
  }
  for (const action of report.nextActions) process.stdout.write(`  next: ${action}\n`);
} else {
  process.stdout.write(`UNCHANGED  ${codingAgent?.name ?? 'pi-coding-agent'} is still ${codingAgent?.latest ?? 'unknown'}\n`);
  for (const entry of results.filter((row) => row.error)) {
    process.stdout.write(`  warn: ${entry.name}: ${entry.error}\n`);
  }
}

process.exit(changed.length > 0 ? 10 : 0);
