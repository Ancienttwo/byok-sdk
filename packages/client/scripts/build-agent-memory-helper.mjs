import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentMemoryHelperSourceDigest, agentMemoryHelperTargets } from './agent-memory-helper-source.mjs';
import { agentMemoryHelperTargetDigest } from '../src/util/agent-memory-helper-digest.ts';

const source = fileURLToPath(new URL('../native/agent-memory-fs/', import.meta.url));
const output = new URL('../dist/native/agent-memory-fs/', import.meta.url);
mkdirSync(output, { recursive: true });
const flags = ['-buildvcs=false', '-trimpath'];
const entries = {};
for (const { name, goos, goarch, file, digestAlgorithm } of agentMemoryHelperTargets) {
  const target = fileURLToPath(new URL(file, output));
  execFileSync('go', ['build', ...flags, '-o', target, '.'], {
    cwd: source,
    env: { ...process.env, GOTOOLCHAIN: 'go1.26.5', GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  entries[name] = { file, digestAlgorithm, digest: agentMemoryHelperTargetDigest(name, readFileSync(target)) };
}
writeFileSync(new URL('manifest.json', output), `${JSON.stringify({
  version: 2, helperVersion: '2', protocol: 2, go: 'go1.26.5', flags,
  sourceDigest: agentMemoryHelperSourceDigest(source), signingPolicy: 'product-resigning-allowed', entries,
}, null, 2)}\n`);
