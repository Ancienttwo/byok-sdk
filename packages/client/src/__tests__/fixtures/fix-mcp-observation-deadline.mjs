// Inert deadline fixture: protocol replies, a lifecycle log, and no external effects.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = JSON.parse(process.argv[2]);
const record = (entry) => appendFileSync(config.recordTo, `${JSON.stringify(entry)}\n`);
record({ event: 'start', pid: process.pid });
const keepAlive = setInterval(() => {}, 60_000);
if (config.ignoreTermination) process.on('SIGTERM', () => record({ event: 'sigterm' }));
else process.stdin.on('end', () => clearInterval(keepAlive));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  record({ event: 'request', method: request.method, cursor: request.params?.cursor });
  if (request.id === undefined) return;
  const reply = (result, delay) => setTimeout(() => {
    record({ event: 'reply', method: request.method, cursor: request.params?.cursor });
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }, delay ?? 0);
  if (request.method === 'initialize') reply({
    protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deadline-fixture', version: '1' },
  }, config.initializeMs);
  else if (request.method === 'tools/list') {
    const page = Number(request.params?.cursor ?? 0);
    reply({
      tools: [{ name: `echo_${page}`, inputSchema: { type: 'object' } }],
      ...(page + 1 < (config.pages ?? 1) ? { nextCursor: String(page + 1) } : {}),
    }, config.listMs);
  } else if (request.method === 'tools/call') reply({ content: [{ type: 'text', text: 'inert' }] }, config.callMs);
});
