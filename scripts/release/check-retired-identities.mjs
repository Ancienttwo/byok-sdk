import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The retired `@byok/` package identity must not come back in shipped code,
// workflows, deploy material or the docs that name packages. Node built-ins
// only: CI runs this on every PR without an install, and check:release-graph
// runs it again through check-package-graph.mjs.
const scanRoots = [
  'packages',
  '.github',
  'deploy',
  'examples',
  'templates',
  'docs/spec.md',
  'docs/architecture',
  'docs/protocol.md',
  'docs/security.md',
  'docs/security-review-m5-pilot-entry.md',
  'ARCHITECTURE-PROPOSAL-byok-platform.md',
  'package.json',
  'bun.lock',
  'README.md',
  'CHANGELOG.md',
];
const textExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);

export function checkRetiredIdentities(repoRoot) {
  const scanFiles = [];
  function collect(relativePath) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) return;
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      const normalizedPath = relativePath.split(path.sep).join('/');
      if (
        ['node_modules', 'dist'].includes(path.basename(relativePath)) ||
        normalizedPath === 'deploy/sql' ||
        normalizedPath === 'docs/architecture/snapshots' ||
        normalizedPath.endsWith('/src/__tests__/golden')
      ) return;
      for (const entry of readdirSync(absolutePath)) collect(path.join(relativePath, entry));
      return;
    }
    if (textExtensions.has(path.extname(relativePath)) || ['package.json', 'bun.lock'].includes(relativePath)) {
      scanFiles.push(relativePath);
    }
  }
  for (const root of scanRoots) collect(root);
  return scanFiles
    .filter(relativePath => readFileSync(path.join(repoRoot, relativePath), 'utf8').includes('@byok/'))
    .map(relativePath => `${relativePath}: contains retired @byok/ package identity`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkRetiredIdentities(fileURLToPath(new URL('../..', import.meta.url)));
  if (errors.length > 0) {
    for (const error of errors) console.error(`[retired-identities] ${error}`);
    process.exit(1);
  }
  console.log('[retired-identities] OK: no retired @byok/ package identity in the scanned files');
}
