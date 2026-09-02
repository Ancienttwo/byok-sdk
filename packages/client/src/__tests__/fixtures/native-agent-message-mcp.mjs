import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const receiptPath = process.env.BYOK_NATIVE_MESSAGE_RECEIPT;
if (!receiptPath) throw new Error('BYOK_NATIVE_MESSAGE_RECEIPT is required');

const reader = createInterface({ input: process.stdin, terminal: false });
reader.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'byok-native-message-permission-smoke', version: '0.0.1' },
      },
    })}\n`);
    return;
  }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: { tools: [{
        name: 'send_agent_message',
        description: 'Publish the exact required terminal Agent message.',
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['body'],
          properties: { body: { type: 'string' } },
        },
      }] },
    })}\n`);
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'send_agent_message') {
    writeFileSync(receiptPath, JSON.stringify(request.params.arguments));
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { content: [{ type: 'text', text: '{"state":"accepted"}' }] },
    })}\n`);
    return;
  }
  if (request.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown method' } })}\n`);
  }
});
