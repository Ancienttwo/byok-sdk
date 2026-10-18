import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../native/agent-memory-fs/', import.meta.url));
const flags = ['-buildvcs=false', '-trimpath'];
const roots = [mkdtempSync(path.join(tmpdir(), 'byok-helper-build-a-')), mkdtempSync(path.join(tmpdir(), 'byok-helper-build-b-'))];
try {
  for (const root of roots) {
    for (const name of readdirSync(source).filter(name => name.endsWith('.go') || name === 'go.mod')) copyFileSync(path.join(source, name), path.join(root, name));
  }
  for (const [arch, goarch] of [['arm64', 'arm64'], ['x64', 'amd64']]) {
    const builds = roots.map(root => {
      const target = path.join(root, 'helper');
      execFileSync('go', ['build', ...flags, '-o', target, '.'], { cwd: root, env: { ...process.env, GOTOOLCHAIN: 'go1.26.5', GOOS: 'darwin', GOARCH: goarch, CGO_ENABLED: '0' } });
      return readFileSync(target);
    });
    assert.deepEqual(builds[0], builds[1], `${arch}: absolute build paths changed bytes`);
    assert.deepEqual(builds[0], readFileSync(new URL(`../dist/native/agent-memory-fs/darwin-${arch}`, import.meta.url)), `${arch}: release differs from clean build`);
    console.log(`${arch}: two independent source paths and the release artifact have identical bytes`);
  }
} finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
