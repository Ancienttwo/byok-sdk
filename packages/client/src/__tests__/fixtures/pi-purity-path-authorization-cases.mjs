// Explicit node --test entry; deliberately outside Vitest's test-file glob.
// Pure helper/fake-descriptor cases only. No fs, subprocess, Pi or test fixtures.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { authorizationPath, liesWithinReadRoots, nativeAuthorizationPath, rememberAuthorizedFd } from './pi-purity-path-authorization.mjs';

const cwd = '/fixture/base';
const roots = ['/fixture/base/modules'];

test('URL, native string and Buffer authorize the same fake descriptor path', () => {
  const filename = `${roots[0]}/escaped space 雪 % #.mjs`;
  for (const value of [filename, Buffer.from(filename), pathToFileURL(filename)]) {
    const map = new Map();
    assert.equal(nativeAuthorizationPath(value, cwd), filename);
    rememberAuthorizedFd(map, 17, value, cwd);
    assert.equal(authorizationPath(map, 17, '/changed/cwd'), filename);
    assert.equal(liesWithinReadRoots(map.get(17), roots), true);
  }
});

test('relative descriptor paths bind to the successful open cwd and remain untruncated', () => {
  const map = new Map();
  const relative = `modules/${'a'.repeat(240)}/雪 space.mjs`;
  rememberAuthorizedFd(map, 21, relative, cwd);
  const expected = `${cwd}/${relative}`;
  assert.ok(expected.length > 200);
  assert.equal(authorizationPath(map, 21, '/later/cwd'), expected);
  assert.equal(liesWithinReadRoots(map.get(21), roots), true);
  assert.equal(nativeAuthorizationPath(relative, '/later/cwd'), `/later/cwd/${relative}`);
  for (const value of [expected, Buffer.from(expected), pathToFileURL(expected)]) {
    rememberAuthorizedFd(map, 22, value, cwd);
    assert.equal(authorizationPath(map, 22, '/later/cwd'), expected);
    assert.equal(liesWithinReadRoots(map.get(22), roots), true);
  }
});

test('root boundary rejects outside paths, sibling prefixes and traversal', () => {
  for (const value of ['/elsewhere/file', `${roots[0]}-sibling/file`, 'modules/../../private/file',
    pathToFileURL('/elsewhere/雪 space'), Buffer.from(`${roots[0]}-sibling/file`)]) {
    const map = new Map();
    rememberAuthorizedFd(map, 23, value, cwd);
    assert.equal(liesWithinReadRoots(authorizationPath(map, 23, cwd), roots), false);
  }
  assert.equal(liesWithinReadRoots(roots[0], roots), true);
  assert.equal(liesWithinReadRoots(`${roots[0]}/file`, roots), true);
});

test('unknown descriptors and non-file URL schemes remain unauthorized', () => {
  const map = new Map();
  assert.equal(authorizationPath(map, 99, cwd), undefined);
  assert.equal(liesWithinReadRoots(authorizationPath(map, 99, cwd), roots), false);
  for (const fd of [-1, 1.5, NaN]) {
    rememberAuthorizedFd(map, fd, `${roots[0]}/file`, cwd);
    assert.equal(authorizationPath(map, fd, cwd), undefined);
  }
  for (const value of [new URL('https://example.invalid/file'), new URL('data:text/plain,no')]) {
    assert.equal(nativeAuthorizationPath(value, cwd), undefined);
    rememberAuthorizedFd(map, 25, `${roots[0]}/old`, cwd);
    rememberAuthorizedFd(map, 25, value, cwd);
    assert.equal(authorizationPath(map, 25, cwd), undefined);
  }
});

test('literal file: strings are native filenames, never decoded URL objects', () => {
  const literal = 'file:///fixture/base/modules/escaped%20name';
  const map = new Map();
  assert.equal(nativeAuthorizationPath(literal, cwd), `${cwd}/file:/fixture/base/modules/escaped%20name`);
  assert.equal(liesWithinReadRoots(nativeAuthorizationPath(literal, cwd), roots), false);
  rememberAuthorizedFd(map, 27, literal, cwd);
  assert.equal(liesWithinReadRoots(authorizationPath(map, 27, cwd), roots), false);
  const nativeLiteral = `${roots[0]}/file:literal%20雪`;
  assert.equal(nativeAuthorizationPath(nativeLiteral, cwd), nativeLiteral);
  assert.equal(liesWithinReadRoots(nativeAuthorizationPath(nativeLiteral, cwd), roots), true);
});
