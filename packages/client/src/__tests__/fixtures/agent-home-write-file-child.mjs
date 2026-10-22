// Child process of agent-home-write-file.test.ts. It applies one projection
// through the built client, and the hook writes three files with
// writeHomeFile. At the requested checkpoint it prints the checkpoint and
// waits, so the parent can kill it there. Every file operation is real: the
// patches below only pause before or after one call, or write half of one
// temp file first.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { AgentHomeLeaseManager, AgentHomeManager, createAgentHomeProjectionConsumer } = await import(input.clientEntry);
const [kind, file] = (input.checkpoint ?? ':').split(':');

const content = (name, revision) => `${name} revision ${revision}\n`.repeat(4096);

function pause() {
  process.stdout.write(`checkpoint ${input.checkpoint}\n`);
  setInterval(() => {}, 60_000);
  return new Promise(() => {});
}

const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  const name = path.basename(String(args[0]));
  if (kind === 'temp-partial' && name.startsWith(`${file}.`) && name.endsWith('.tmp')) {
    handle.writeFile = async data => {
      const bytes = Buffer.from(data);
      await handle.write(bytes, 0, bytes.length >> 1);
      await handle.sync();
      await pause();
    };
  }
  return handle;
};
const rename = fs.rename;
fs.rename = async (from, to) => {
  const name = path.basename(String(to));
  if (kind === 'before-rename' && name === file) await pause();
  await rename(from, to);
  if (kind === 'after-rename' && name === file) await pause();
};

const manager = new AgentHomeManager({
  hostStorageRoot: input.root,
  leaseManager: new AgentHomeLeaseManager({ ownerId: input.ownerId }),
  projection: createAgentHomeProjectionConsumer(async ({ agentRef, writeHomeFile }) => {
    for (const name of input.files) {
      const body = content(name, agentRef.profileRevision);
      await writeHomeFile(name, name.endsWith('.json') ? new TextEncoder().encode(body) : body);
    }
  }),
});
process.stdout.write(`outcome ${await manager.project(input.payload)}\n`);
