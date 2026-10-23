// Open checks with the real helper and junction fixtures, under both Node and
// Bun. The runtime supplies the root identity, as the TS caller does. A
// junction home is refused, and a junction inside the home refuses the write.
// The TS gate admits Windows x64 without B. These checks prove neither model S
// recovery nor successful flush operations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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
  const revision = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const outsideIdentity = await stat(outside, { bigint: true });
  for (const placement of ['ordinary', 'root-junction', 'ancestor-junction', 'notes-junction', 'state-junction']) {
    const parent = path.join(scratch, placement);
    await mkdir(parent);
    const realHome = path.join(parent, 'home');
    await mkdir(realHome);
    let identity = await stat(realHome, { bigint: true });
    let root = realHome;
    let junction;
    let target = outside;
    // A write that reaches the outside sentinel carries its revision, so a
    // followed junction would pass the CAS.
    let write = { path: 'MEMORY.md', expectedRevision: revision(''), code: undefined };
    if (placement === 'root-junction') {
      // A followed junction would match its target's identity.
      junction = path.join(parent, 'linked-home');
      root = junction;
      identity = outsideIdentity;
    } else if (placement === 'ancestor-junction') {
      junction = path.join(scratch, 'linked-parent');
      target = parent;
      root = path.join(junction, 'home');
    } else if (placement === 'notes-junction') {
      junction = path.join(realHome, 'notes');
      write = { path: 'notes/sentinel.txt', expectedRevision: revision('outside sentinel'), code: 'unsafe_path' };
    } else if (placement === 'state-junction') {
      junction = path.join(realHome, '.byok');
      write = { path: '.byok/sentinel.txt', expectedRevision: revision('outside sentinel'), code: 'unsafe_path' };
    }
    if (junction) await symlink(target, junction, 'junction');
    try {
      const requests = [
        { id: 'open', protocol: 2, op: 'open', root, expectedIdentity: { kind: 'windows', volumeSerial: identity.dev.toString(10), fileIndex: identity.ino.toString(10) } },
        { id: 'write', protocol: 2, op: 'replace', path: write.path, expectedRevision: write.expectedRevision, contentBase64: 'eA', maxBytes: 1024 },
        { id: 'close', protocol: 2, op: 'close' },
      ];
      const child = spawnSync(helperBin, ['serve'], {
        env: {}, input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
      });
      assert.ifError(child.error);
      const opened = placement !== 'root-junction';
      // Close ends an admitted session with exit 0. Without an admitted open,
      // EOF is a protocol failure, so main exits 1.
      assert.equal(child.status, opened ? 0 : 1, child.stderr);
      const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(responses.map((reply) => [reply.id, reply.protocol, reply.ok, reply.error?.code]), opened
        ? [['open', 2, true, undefined], ['write', 2, write.code === undefined, write.code], ['close', 2, true, undefined]]
        : [['open', 2, false, 'unsafe_root'], ['write', 2, false, 'protocol_sequence'], ['close', 2, false, 'protocol_sequence']]);
      assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel');
      assert.deepEqual(await readdir(outside), ['sentinel.txt']);
      const children = (await readdir(realHome)).filter((name) => !['notes', '.byok'].includes(name));
      assert.deepEqual(children, opened && write.code === undefined ? ['MEMORY.md'] : []);
      results.push({ placement, open: responses[0].error?.code ?? 'ok', write: responses[1].error?.code ?? 'ok', sentinel: 'unchanged' });
    } finally {
      if (junction) await unlink(junction);
    }
  }
  // Observation only (#522): this runtime's directory fsync on NTFS. A path
  // that treats its refusal as success has no directory barrier at all.
  const directory = await open(scratch, 'r');
  let directoryFsync = 'ok';
  try {
    await directory.sync();
  } catch (error) {
    directoryFsync = error.code ?? String(error);
  } finally {
    await directory.close();
  }
  console.log(JSON.stringify({
    acceptance: 'HELPER OPEN WITH JUNCTION FIXTURES; TS GATE CLOSED; NO S PROOF; B=false', runtime: process.versions, directoryFsync,
    osRelease: os.release(), helperSha256: createHash('sha256').update(await readFile(helperBin)).digest('hex'),
    childEnvironment: {}, results,
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
