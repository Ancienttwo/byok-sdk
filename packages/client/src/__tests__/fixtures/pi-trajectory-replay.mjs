// Synthetic RPC transcript transport only. This child never imports Pi,
// reads credentials, opens a socket, or requests a model response.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [record, ending] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
lines.once('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'replay_synthetic') throw new Error('unexpected replay command');
  process.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, success: true })}\n`);
  const transcript = readFileSync(record, 'utf8');
  // Flush the selected prefix before a real process-level kill. A partial
  // last line deliberately has no LF; it cannot be a complete RPC frame.
  process.stdout.write(transcript, () => {
    if (ending === 'killed') process.kill(process.pid, 'SIGKILL');
    else process.exit(0);
  });
});
