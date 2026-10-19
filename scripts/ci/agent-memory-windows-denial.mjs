// Platform-refusal checks with the real helper, under both Node and Bun.
// openSession returns unsupported_platform before it reads any path. Junction
// fixtures do not exercise traversal, containment or an admitted storage backend.
// These checks prove neither model S recovery nor successful flush operations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32', 'this matrix requires real Windows');
const helperBin = process.argv[2];
assert.ok(helperBin && path.isAbsolute(helperBin), 'use an explicit helper path');
const version = spawnSync(helperBin, ['--version'], { env: {}, encoding: 'utf8', timeout: 10_000, windowsHide: true });
assert.ifError(version.error);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout, '2\n');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'wo09-windows-'));
const results = [];
try {
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'outside sentinel');
  for (const placement of ['ordinary', 'root-junction', 'ancestor-junction', 'notes-junction', 'state-junction']) {
    const parent = path.join(scratch, placement);
    await mkdir(parent);
    const realHome = path.join(parent, 'home');
    await mkdir(realHome);
    const identity = await stat(realHome, { bigint: true });
    let root = realHome;
    let junction;
    if (placement === 'root-junction') {
      junction = path.join(parent, 'linked-home');
      root = junction;
    } else if (placement === 'ancestor-junction') {
      junction = path.join(parent, 'linked-parent');
      root = path.join(junction, 'home');
    } else if (placement === 'notes-junction') junction = path.join(realHome, 'notes');
    else if (placement === 'state-junction') junction = path.join(realHome, '.byok');
    if (junction) await symlink(outside, junction, 'junction');
    try {
      const requests = [
        { id: 'open', protocol: 2, op: 'open', root, expectedIdentity: { kind: 'windows', volumeSerial: identity.dev.toString(10), fileIndex: identity.ino.toString(10) } },
        { id: 'write', protocol: 2, op: 'replace', path: 'notes/sentinel.txt', expectedRevision: `sha256:${'0'.repeat(64)}`, contentBase64: 'eA', maxBytes: 1024 },
      ];
      const child = spawnSync(helperBin, ['serve'], {
        env: {}, input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
      });
      assert.ifError(child.error);
      // EOF without an admitted open is a protocol failure, so main exits 1.
      assert.equal(child.status, 1, child.stderr);
      const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(responses.length, 2);
      assert.deepEqual(responses.map((reply) => [reply.id, reply.protocol, reply.ok, reply.error?.code]), [
        ['open', 2, false, 'unsupported_platform'], ['write', 2, false, 'protocol_sequence'],
      ]);
      assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
      assert.deepEqual(await readdir(outside), ['sentinel.txt']);
      const children = (await readdir(realHome)).filter((name) => !['notes', '.byok'].includes(name));
      assert.deepEqual(children, []);
      results.push({ placement, open: 'unsupported_platform', write: 'protocol_sequence', sentinel: 'unchanged' });
    } finally {
      if (junction) await unlink(junction);
    }
  }
  console.log(JSON.stringify({
    acceptance: 'PLATFORM REFUSAL ONLY; NO CONTAINMENT OR S PROOF; B=false', runtime: process.versions,
    osRelease: os.release(), helperSha256: createHash('sha256').update(await readFile(helperBin)).digest('hex'),
    childEnvironment: {}, results,
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
