#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-salesko', version: '1.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'find_leads',
            description: 'Returns deterministic fake Salesko leads.',
            inputSchema: { type: 'object', properties: { company: { type: 'string' }, limit: { type: 'number' } } },
          },
        ],
      },
    });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'find_leads') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              source: 'salesko-fake',
              company: request.params.arguments?.company,
              leads: [
                { name: 'Ada Lead', channel: 'email' },
                { name: 'Lin Social', channel: 'linkedin' },
              ],
            }),
          },
        ],
      },
    });
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown method' } });
  }
});

process.on('SIGTERM', () => process.exit(0));
