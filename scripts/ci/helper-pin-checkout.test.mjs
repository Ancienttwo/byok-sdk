import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

const pin = 'packages/client/src/util/agent-memory-helper-release-pin.ts';
const rule = `${pin} text eol=lf\n`;
const attributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fixture(t, attrs) {
  const cwd = mkdtempSync(join(tmpdir(), 'helper-pin-checkout-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'core.autocrlf', 'true');
  git('config', 'core.safecrlf', 'false');
  writeFileSync(join(cwd, '.gitattributes'), attrs);
  mkdirSync(dirname(join(cwd, pin)), { recursive: true });
  const content = readFileSync(new URL(`../../${pin}`, import.meta.url), 'utf8');
  writeFileSync(join(cwd, pin), content);
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture');
  return { cwd, git, content, base: git('rev-parse', 'HEAD').trim() };
}

test('real autocrlf checkout preserves the exact generated helper pin bytes', t => {
  const { cwd, git, content } = fixture(t, attributes);
  rmSync(join(cwd, pin));
  git('checkout-index', '--force', '--', pin);
  assert.equal(readFileSync(join(cwd, pin), 'utf8'), content);
});

test('only the exact helper pin LF attribute addition selects client and release packaging', t => {
  const before = attributes.replace(rule, '');
  const { cwd, base } = fixture(t, before);
  const context = { cwd, base };
  writeFileSync(join(cwd, '.gitattributes'), before + rule);
  const plan = selectImpact(['.gitattributes'], context);
  assert.ok(plan.dirs.includes('packages/client'));
  for (const id of ['agent-memory-helper', 'agent-memory-helper-non-darwin', 'npm-release-pack']) {
    assert.ok(plan.families.includes(id), id);
  }
  for (const after of [before + '* text eol=lf\n', before + rule + '*.ts -text\n',
    before + rule.replace('eol=lf', 'eol=crlf'), before.replace('vendor/** -text', 'vendor/** text') + rule]) {
    writeFileSync(join(cwd, '.gitattributes'), after);
    assert.throws(() => selectImpact(['.gitattributes'], context), /reviewed|release validation/i);
  }
});
