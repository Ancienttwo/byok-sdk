import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { agentMemoryHelperDigest } from '../src/daemon/agent-memory-helper-digest.ts';

const source = fileURLToPath(new URL('../native/agent-memory-fs/', import.meta.url));
const output = new URL('../dist/native/agent-memory-fs/', import.meta.url);
mkdirSync(output, { recursive: true });
const flags = ['-buildvcs=false', '-trimpath'];
const entries = {};
for (const [arch, goarch] of [['arm64', 'arm64'], ['x64', 'amd64']]) {
  const name = `darwin-${arch}`;
  const target = fileURLToPath(new URL(name, output));
  execFileSync('go', ['build', ...flags, '-o', target, '.'], {
    cwd: source,
    env: { ...process.env, GOTOOLCHAIN: 'go1.26.5', GOOS: 'darwin', GOARCH: goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  entries[name] = { file: name, digest: agentMemoryHelperDigest(readFileSync(target), arch) };
}
const sourceHash = createHash('sha256');
for (const name of readdirSync(source).filter(name => (name.endsWith('.go') && !name.endsWith('_test.go')) || name === 'go.mod').sort()) {
  sourceHash.update(name).update('\0').update(readFileSync(`${source}/${name}`)).update('\0');
}
writeFileSync(new URL('manifest.json', output), `${JSON.stringify({
  version: 1, helperVersion: '2', protocol: 2, go: 'go1.26.5', flags,
  sourceDigest: sourceHash.digest('hex'), signingPolicy: 'product-resigning-allowed',
  digestAlgorithm: 'mach-o-content-v1', entries,
}, null, 2)}\n`);
