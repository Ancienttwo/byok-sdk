import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';

const [receipt, entry, delay, context] = process.argv.slice(2);
const child = spawn(process.execPath, [entry, context], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
const record = (method, fields = {}) => appendFileSync(receipt, `${JSON.stringify({ method, pid: child.pid, ms: Date.now(), ...fields })}\n`);
record('start');
child.stdin.on('error', () => {});
child.on('error', error => record('spawn-error', { code: error.code }));
child.on('close', (code, signal) => { record('close', { code, signal }); process.exit(code ?? 1); });
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));

const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  const frame = JSON.parse(line);
  if (frame.id !== undefined) pending.set(frame.id, frame.method);
  record(frame.method, { id: frame.id, params: frame.method === 'tools/call' ? frame.params : undefined });
  if (frame.method === 'initialize' && Number(delay) > 0) await setTimeout(Number(delay));
  if (!child.stdin.destroyed) child.stdin.write(`${line}\n`);
});
input.once('close', () => child.stdin.end());

createInterface({ input: child.stdout }).on('line', line => {
  const frame = JSON.parse(line);
  const request = pending.get(frame.id);
  pending.delete(frame.id);
  record('reply', { id: frame.id, request, result: request === 'tools/call' ? frame.result : undefined, error: frame.error });
  process.stdout.write(`${line}\n`);
});
