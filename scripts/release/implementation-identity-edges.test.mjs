import assert from 'node:assert/strict';
import test from 'node:test';
import { assertImplementationIdentityDependency } from './implementation-identity-edges.mjs';
import { topologicalOrder } from './publish.mjs';

const shared = '@byok-sdk/implementation-identity';
const train = '0.19.0';
const consumers = ['@byok-sdk/client', '@byok-sdk/keys'];

for (const name of consumers) {
  test(`${name}: workspace edge is accepted only by the source gate`, () => {
    const manifest = { name, dependencies: { [shared]: 'workspace:*' } };
    assertImplementationIdentityDependency(manifest, 'workspace:*');
    assert.throws(() => assertImplementationIdentityDependency(manifest, train), /expected 0.19.0/);
  });

  test(`${name}: frozen artifacts require the exact common version and a required edge`, () => {
    assertImplementationIdentityDependency({ name, dependencies: { [shared]: train } }, train);
    for (const version of ['0.18.0', '^0.19.0', '~0.19.0', '*', 'latest', undefined]) {
      const dependencies = version === undefined ? {} : { [shared]: version };
      assert.throws(() => assertImplementationIdentityDependency({ name, dependencies }, train), /expected 0.19.0/);
    }
    for (const field of ['optionalDependencies', 'peerDependencies']) {
      assert.throws(() => assertImplementationIdentityDependency({
        name, dependencies: { [shared]: train }, [field]: { [shared]: train },
      }, train), /must be a required dependency/);
    }
  });
}

test('different consumer versions cannot both pass the packed train gate', () => {
  const client = { name: consumers[0], dependencies: { [shared]: train } };
  const keys = { name: consumers[1], dependencies: { [shared]: '0.18.0' } };
  assertImplementationIdentityDependency(client, train);
  assert.throws(() => assertImplementationIdentityDependency(keys, train), /0.18.0, expected 0.19.0/);
});

test('publish topology puts shared measurement before both consumers, independent of input order', () => {
  const entries = consumers.map((name) => ({ name, manifest: { dependencies: { [shared]: train } } }));
  entries.push({ name: shared, manifest: {} });
  assert.equal(topologicalOrder(entries)[0].name, shared);
  assert.equal(topologicalOrder(entries.toReversed())[0].name, shared);
});
