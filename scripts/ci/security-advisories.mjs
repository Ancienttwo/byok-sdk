import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Official release asset digest: https://github.com/google/osv-scanner/releases/tag/v2.7.0
export const scanner = Object.freeze({
  version: '2.7.0',
  url: 'https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64',
  sha256: '160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b',
});
const json = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const npmAttestation = 'https://registry.npmjs.org/-/npm/v1/attestations/';

// A commit-pinned fork can name the authoritative release it was cut from.
// The declaration only counts when the published package, version, tarball
// integrity and provenance commit all agree with the recorded vendor identity.
// The commit stays in the inventory as provenance; the advisory query uses the
// package version, which OSV can actually cover.
function authoritativeRelease(manifest, item, source) {
  if (manifest.release === undefined) return null;
  const release = manifest.release;
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error(`Malformed release evidence: ${source}`);
  const expectedProvenance = `${npmAttestation}${item.name.replace('/', '%2f')}@${item.version}`;
  const valid = release.ecosystem === 'npm'
    && release.name === item.name
    && release.version === item.version
    && exactVersion.test(item.version ?? '')
    && release.gitCommit === item.commit
    && /^[a-f0-9]{40}$/.test(release.gitCommit ?? '')
    && typeof release.integrity === 'string'
    && sha512Integrity.test(release.integrity)
    && release.provenance === expectedProvenance;
  if (!valid) throw new Error(`Release evidence disagrees with vendor identity or commit: ${source}`);
  return { ecosystem: release.ecosystem, name: release.name, version: release.version, integrity: release.integrity, commit: release.gitCommit, provenance: release.provenance };
}

export function vendorInventory(root) {
  const inventory = [];
  const gaps = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'source-manifest.json' || entry.name === 'third-party-manifest.json') {
        const source = relative(root, path);
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        if (manifest.version !== 1) throw new Error(`Unsupported vendor manifest version: ${source}`);
        let packages;
        if (entry.name === 'source-manifest.json' && manifest.format === 'byok.vendor-source') {
          packages = [{ name: manifest.package, version: manifest.packageVersion, commit: manifest.commit, repository: manifest.repository }];
        } else if (entry.name === 'third-party-manifest.json' && manifest.format === 'byok.todo-build-inputs' && Array.isArray(manifest.packages)) {
          packages = manifest.packages;
        } else throw new Error(`Unsupported vendor manifest: ${source}`);
        for (const pkg of packages) {
          if (typeof pkg.name !== 'string' || !pkg.name.trim()) throw new Error(`Missing vendor package identity: ${source}`);
          const item = { source, name: pkg.name, version: pkg.version ?? null, commit: pkg.commit ?? null, repository: pkg.repository ?? null };
          const release = authoritativeRelease(manifest, item, source);
          if (release) item.release = release;
          inventory.push(item);
          if (item.commit !== null) {
            // Commit provenance alone is not an assertion that the fork equals an
            // npm release; without release evidence the version stays uncovered.
            if (!release) gaps.push({ ...item, reason: 'Commit-pinned source/fork: OSV commit data is incomplete; a zero-result query does not establish package-version coverage.' });
            if (!/^[a-f0-9]{40}$/.test(item.commit) || typeof item.repository !== 'string' || !item.repository.startsWith('https://github.com/')) {
              throw new Error(`Malformed commit provenance: ${source}`);
            }
          } else if (typeof item.version !== 'string' || !exactVersion.test(item.version)) {
            gaps.push({ ...item, reason: 'No authoritative exact package version available for npm advisory query.' });
          }
        }
      }
    }
  };
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const vendorRoot = join(root, 'packages', entry.name, 'vendor');
    if (entry.isDirectory() && existsSync(vendorRoot)) walk(vendorRoot);
  }
  if (!inventory.length) throw new Error('No canonical vendor manifests found');
  const packages = inventory.flatMap(item => {
    if (item.release) return [{ package: { name: item.release.name, version: item.release.version, ecosystem: item.release.ecosystem } }];
    if (item.commit !== null) return [{ package: { name: item.repository, commit: item.commit } }];
    return exactVersion.test(item.version ?? '') ? [{ package: { name: item.name, version: item.version, ecosystem: 'npm' } }] : [];
  });
  const coverage = inventory.filter(item => item.release).map(item => ({
    source: item.source, name: item.release.name, version: item.release.version, ecosystem: item.release.ecosystem,
    commit: item.release.commit, integrity: item.release.integrity, provenance: item.release.provenance,
  }));
  return { inventory, gaps, coverage, input: { results: [{ packages }] } };
}

// v2.7.0 JSON schema and exit codes: google/osv-scanner docs/output.md.
// --all-packages makes an empty/malformed result a scan error rather than clean.
export function parseResult(run) {
  const result = JSON.parse(run.stdout);
  if (!Array.isArray(result.results) || !result.results.length) throw new Error('OSV returned no package sources');
  let count = 0;
  const findings = [];
  for (const source of result.results) {
    if (!Array.isArray(source.packages)) throw new Error('Malformed OSV package list');
    for (const pkg of source.packages) {
      if (!pkg.package || typeof pkg.package.name !== 'string') throw new Error('Malformed OSV package identity');
      count++;
      if (pkg.vulnerabilities != null && !Array.isArray(pkg.vulnerabilities)) throw new Error('Malformed OSV advisory list');
      for (const advisory of pkg.vulnerabilities ?? []) {
        if (typeof advisory.id !== 'string' || !advisory.id) throw new Error('Malformed OSV advisory');
        findings.push({ source: source.source, package: pkg.package, advisory });
      }
    }
  }
  if (!count) throw new Error('OSV returned no packages');
  if (run.error || run.signal || ![0, 1].includes(run.status)) throw Object.assign(new Error(`OSV scan failed (exit ${run.status}, signal ${run.signal ?? 'none'})`), { findings });
  if (run.status === 0 && findings.length) throw Object.assign(new Error('OSV success exit disagrees with advisory results'), { findings });
  return { packages: count, findings, otherFindings: run.status === 1 && !findings.length };
}

export function audit({ root, output, scannerPath, execute = spawnSync }) {
  mkdirSync(output, { recursive: true });
  const report = { scanner, status: 'SCAN ERROR', inventory: [], coverage: [], coverageGaps: [], scans: [], findings: [], errors: [] };
  try {
    const vendors = vendorInventory(root);
    report.inputs = { lockfileSha256: createHash('sha256').update(readFileSync(join(root, 'bun.lock'))).digest('hex'),
      vendorInventorySha256: createHash('sha256').update(JSON.stringify(vendors.inventory)).digest('hex') };
    report.inventory = vendors.inventory;
    report.coverage = vendors.coverage;
    report.coverageGaps = vendors.gaps;
    json(join(output, 'vendor-osv-scanner.json'), vendors.input);
    // Explicit empty config overrides every repository-local ignore or package override.
    writeFileSync(join(output, 'empty-config.toml'), '');
    for (const [name, input] of [['lockfile', join(root, 'bun.lock')], ['vendor', `osv-scanner:${join(output, 'vendor-osv-scanner.json')}`]]) {
      const args = ['scan', 'source', '--format=json', '--all-packages', '--all-vulns', '--no-call-analysis=go', '--no-resolve', `--config=${join(output, 'empty-config.toml')}`, `--lockfile=${input}`];
      const run = execute(scannerPath, args, { cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      writeFileSync(join(output, `${name}.json`), run.stdout ?? '');
      writeFileSync(join(output, `${name}.stderr.log`), run.stderr ?? '');
      try {
        const parsed = parseResult(run);
        report.scans.push({ name, exitCode: run.status, packages: parsed.packages, otherFindings: parsed.otherFindings });
        report.findings.push(...parsed.findings);
      } catch (error) {
        report.findings.push(...(error.findings ?? []));
        report.errors.push(`${name}: ${error.message}`);
      }
    }
  } catch (error) {
    report.errors.push(error.message);
  }
  report.status = report.errors.length ? 'SCAN ERROR' : report.findings.length || report.scans.some(scan => scan.otherFindings) ? 'ADVISORIES FOUND' : report.coverageGaps.length ? 'COVERAGE GAP' : 'NO KNOWN ADVISORIES';
  writeReport(output, report);
  return report;
}

export function writeReport(output, report) {
  json(join(output, 'report.json'), report);
  const lines = [`# Security advisories: ${report.status}`, '', `Scanner: OSV ${scanner.version}. Known-advisory queries do not establish absence of vulnerabilities.`, '', `Advisories: ${report.findings.length}; coverage gaps: ${report.coverageGaps.length}; scan errors: ${report.errors.length}.`, ''];
  for (const finding of report.findings) lines.push(`- ${finding.advisory.id}: ${finding.package.name}@${finding.package.version ?? finding.package.commit} — https://osv.dev/vulnerability/${encodeURIComponent(finding.advisory.id)}`);
  for (const coverage of report.coverage ?? []) lines.push(`- AUTHORITATIVE COVERAGE: ${coverage.source}: ${coverage.name}@${coverage.version} from ${coverage.ecosystem} release (provenance commit ${coverage.commit}).`);
  for (const gap of report.coverageGaps) lines.push(`- COVERAGE GAP: ${gap.source}: ${gap.name}@${gap.version ?? gap.commit ?? 'unknown'}: ${gap.reason}`);
  for (const error of report.errors) lines.push(`- SCAN ERROR: ${error}`);
  lines.push('', 'Full advisory records, exact vendor inventory, scanner output and stderr are retained in the report artifact.');
  writeFileSync(join(output, 'summary.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const root = process.cwd();
  const output = resolve(root, 'security-advisories-report');
  mkdirSync(output, { recursive: true });
  try {
    const response = await fetch(scanner.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OSV binary download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== scanner.sha256) throw new Error('OSV binary SHA256 mismatch');
    const scannerPath = join(output, 'osv-scanner');
    writeFileSync(scannerPath, bytes);
    chmodSync(scannerPath, 0o755);
    const report = audit({ root, output, scannerPath });
    process.exitCode = report.status === 'NO KNOWN ADVISORIES' ? 0 : 1;
  } catch (error) {
    writeReport(output, { scanner, status: 'SCAN ERROR', inventory: [], coverageGaps: [], scans: [], findings: [], errors: [error.message] });
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
