import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { declaredCodes, generateGuide, validateCatalog } from './device-setup.mjs';
const catalog = JSON.parse(readFileSync(new URL('../../packages/client/src/daemon/setup-error-catalog.json', import.meta.url), 'utf8'));
const guide = readFileSync(new URL('../../docs/device-setup.md', import.meta.url), 'utf8');

test('new public code without a catalog entry fails admission', () => {
  assert.throws(() => validateCatalog(catalog, [...declaredCodes(), 'new_startup_error'].sort()), /coverage mismatch/);
});
test('deleted code or missing remedy does not leave stale catalog authority', () => {
  assert.throws(() => validateCatalog({ ...catalog, old_code: catalog.unpaired }), /coverage mismatch/);
  assert.throws(() => validateCatalog({ ...catalog, unpaired: { ...catalog.unpaired, nextStep: '' } }), /Invalid setup catalog entry/);
});
test('generation is deterministic and repairs stale tables', () => {
  assert.equal(generateGuide(guide), guide);
  assert.equal(generateGuide(guide.replace('| `productName` | required | string |', '| stale field | required | string |')), guide);
});
test('broken guide links and removed generation markers fail', () => {
  assert.throws(() => generateGuide(guide.replace('## Reset\n', '## Missing\n')), /Missing guide anchor/);
  assert.throws(() => generateGuide(guide.replace('<!-- generated:fields:start -->', '')), /Missing\/duplicate/);
});
