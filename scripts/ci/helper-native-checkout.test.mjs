import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentMemoryHelperSourceDigest } from '../../packages/client/scripts/agent-memory-helper-source.mjs';
import { AGENT_MEMORY_HELPER_RELEASE } from '../../packages/client/src/util/agent-memory-helper-release-pin.ts';
import { selectImpact } from './select-impact.mjs';

const sourcePath = 'packages/client/native/agent-memory-fs';
const rules = `${sourcePath}/*.go text eol=lf\n${sourcePath}/go.mod text eol=lf\n`;
const attributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fixture(t, attrs) {
  const cwd = mkdtempSync(join(tmpdir(), 'helper-native-checkout-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const source = join(cwd, sourcePath);
  mkdirSync(source, { recursive: true });
  for (const name of readdirSync(new URL(`../../${sourcePath}/`, import.meta.url)).filter(name => name.endsWith('.go') || name === 'go.mod')) {
    writeFileSync(join(source, name), readFileSync(new URL(`../../${sourcePath}/${name}`, import.meta.url)));
  }
  writeFileSync(join(cwd, '.gitattributes'), attrs);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'core.autocrlf', 'true'); git('config', 'core.safecrlf', 'false');
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture');
  return { cwd, source, git, base: git('rev-parse', 'HEAD').trim() };
}

test('real autocrlf checkout preserves the committed native helper source digest', t => {
  const { source, git } = fixture(t, attributes);
  rmSync(source, { recursive: true });
  git('checkout-index', '--all', '--force');
  assert.equal(agentMemoryHelperSourceDigest(source), AGENT_MEMORY_HELPER_RELEASE.sourceDigest);
});

test('native input LF rules select release packing and reject unrelated attributes', t => {
  const before = attributes.replace(rules, '');
  const { cwd, base } = fixture(t, before);
  writeFileSync(join(cwd, '.gitattributes'), before + rules);
  assert.ok(selectImpact(['.gitattributes'], { cwd, base }).families.includes('npm-release-pack'));
  for (const extra of ['* text eol=lf\n', 'packages/client/vendor/** text\n']) {
    writeFileSync(join(cwd, '.gitattributes'), before + rules + extra);
    assert.throws(() => selectImpact(['.gitattributes'], { cwd, base }), /reviewed|release validation/i);
  }
});
