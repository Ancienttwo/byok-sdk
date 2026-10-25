// Inert JSONL worker: no Pi runtime, provider, tools, credentials, or network.
// A resumed generation reads the local checkpoint instead of calling the model again.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const [root, generationText] = process.argv.slice(2);
const generation = Number(generationText);
const plan = JSON.parse(readFileSync(path.join(root, 'plan.json'), 'utf8'))[generation];
if (!plan) throw new Error('unexpected worker generation');
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  // Opt-in: the worker ends on its own while the parent's tool acknowledgement awaits its reply.
  if (command.type === 'tool_ack' && plan.exitOnToolAck) process.exit(75);
  if (command.type !== 'start') throw new Error('unexpected command');
  appendFileSync(path.join(root, 'starts.jsonl'), `${JSON.stringify(command)}\n`);
  // Opt-in: the worker ends on its own before its start receipt, or refuses the start.
  if (plan.exitBeforeReceipt) process.exit(74);
  if (plan.refuseStart) { send({ type: 'response', id: command.id, success: false }); return; }
  if (!command.resume) appendFileSync(path.join(root, 'model-calls'), 'synthetic-model-call\n');
  send({ type: 'response', id: command.id, success: true, workerPid: process.pid,
    projectionDigest: plan.projectionDigest ?? 'a'.repeat(64) });
  // The retired wire v2 frame: a durable worker no longer carries a result document.
  if (plan.retiredResultFrame) send({ type: 'durable_result', document: { text: 'finished' } });
  if (plan.exitOnToolAck) send({ type: 'tool_intent', toolCallId: 'tool-1' });
  if (plan.complete) send({ type: 'durable_complete' });
  if (plan.crash) process.stdout.write('', () => process.exit(73));
});
