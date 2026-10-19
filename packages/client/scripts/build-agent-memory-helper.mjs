import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentMemoryHelperSourceDigest } from './agent-memory-helper-source.mjs';
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
writeFileSync(new URL('manifest.json', output), `${JSON.stringify({
  version: 1, helperVersion: '2', protocol: 2, go: 'go1.26.5', flags,
  sourceDigest: agentMemoryHelperSourceDigest(source), signingPolicy: 'product-resigning-allowed',
  digestAlgorithm: 'mach-o-content-v1', entries,
}, null, 2)}\n`);
