import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDist } from '../scripts/check-dist.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloud-do-dist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  mkdirSync(dist);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(dist, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return dist;
}

test('accepts a local declaration closure and declared external types', t => {
  const dist = fixture(t, {
    'index.js': "import { DurableObject } from 'cloudflare:workers'; export { DurableObject };",
    'index.d.ts': "export * from './nested/types.js'; import 'cloudflare:workers';",
    'nested/types.d.ts': "export type Storage = import('@earendil-works/pi-durable').Storage;",
  });
  assert.equal(checkDist(dist), 3);
});

for (const [name, file, source, message] of [
  ['missing relative declaration', 'index.d.ts', "export * from './missing.js';", /missing relative declaration/],
  ['escaped declaration', 'index.d.ts', "import type { X } from '../../outside';", /leaves dist/],
  ['keys import', 'index.d.ts', "import type { SecretStore } from '@byok-sdk/keys';", /undeclared external type/],
  ['client dynamic type', 'index.d.ts', "export type X = import('@byok-sdk/client').X;", /undeclared external type/],
  ['unknown external subpath', 'index.d.ts', "export * from '@earendil-works/pi-ai-other';", /undeclared external type/],
  ['bare builtin', 'index.js', "import { readFile } from 'fs';", /Node builtin/],
  ['prefixed builtin', 'index.js', "import { readFile } from 'node:fs';", /Node builtin/],
  ['dynamic builtin', 'index.js', "export const fs = () => import('node:fs');", /Node builtin/],
  ['builtin re-export', 'index.js', "export { readFile } from 'fs';", /Node builtin/],
  ['builtin require', 'index.js', "export const fs = require('fs');", /Node builtin/],
]) {
  test('rejects ' + name, t => assert.throws(() => checkDist(fixture(t, { [file]: source })), message));
}

test('ignores import examples in comments and ordinary string values', t => {
  const dist = fixture(t, {
    'index.js': "// import 'node:fs';\nexport const example = \"import('fs')\";",
    'index.d.ts': "/* export * from '@byok-sdk/keys'; */\nexport declare const example: string;",
  });
  assert.equal(checkDist(dist), 2);
});
