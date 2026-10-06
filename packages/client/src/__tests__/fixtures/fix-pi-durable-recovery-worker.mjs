// Inert JSONL worker: no Pi runtime, provider, tools, credentials, or network.
// A tiny local checkpoint makes redelivery read saved data without new work.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const [root, generationText] = process.argv.slice(2);
const generation = Number(generationText);
const plan = JSON.parse(readFileSync(path.join(root, 'plan.json'), 'utf8'))[generation];
if (!plan) throw new Error('unexpected worker generation');
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type !== 'start') throw new Error('unexpected command');
  appendFileSync(path.join(root, 'starts.jsonl'), `${JSON.stringify(command)}\n`);
  if (!command.resume) {
    appendFileSync(path.join(root, 'model-calls'), 'synthetic-model-call\n');
    writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify({ text: 'finished', detail: { count: 1, labels: ['a', 'b'] } }));
  }
  send({ type: 'response', id: command.id, success: true, workerPid: process.pid,
    projectionDigest: plan.projectionDigest ?? 'a'.repeat(64) });
  const saved = JSON.parse(readFileSync(path.join(root, 'checkpoint.json'), 'utf8'));
  const document = plan.result === 'conflict' ? { ...saved, text: 'changed' }
    : plan.result === 'nested-conflict' ? { ...saved, detail: { ...saved.detail, count: 2 } }
    : plan.result === 'reordered' ? { detail: { labels: saved.detail.labels, count: saved.detail.count }, text: saved.text }
    : plan.result === 'invalid' ? null : saved;
  if (plan.result !== 'none') send({ type: 'durable_result', document });
  if (plan.duplicate) send({ type: 'durable_result', document });
  if (plan.complete) send({ type: 'durable_complete' });
  if (plan.crash) process.stdout.write('', () => process.exit(73));
});
