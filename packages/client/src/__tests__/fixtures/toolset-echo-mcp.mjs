#!/usr/bin/env node
/**
 * A one-tool stdio MCP server standing in for a host-configured toolset
 * server, used by the two live permission smokes
 * (`scripts/claude-toolset-permission-smoke.mjs`,
 * `scripts/codex-toolset-permission-smoke.mjs`).
 *
 * It writes an audit line for every request it receives, so a smoke can prove
 * the distinction that matters: an ungranted runtime reaches `tools/list` and
 * never `tools/call`. Adapted from the downstream Gate 0 probe that first
 * demonstrated the defect (salesko
 * `apps/local-agent/scripts/gate0-probe-mcp-server.mjs`).
 *
 * Hand-rolled JSON-RPC over newline-delimited JSON on purpose: an MCP SDK
 * dependency for one test fixture would be a hidden dependency this package
 * does not otherwise carry.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const auditPath = process.argv[2];
if (!auditPath) {
  process.stderr.write('toolset echo MCP server requires an audit file path as its first argument\n');
  process.exit(2);
}

function record(entry) {
  appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

record({ kind: 'spawn', cwd: process.cwd(), argv: process.argv });

const TOOL = {
  name: 'echo',
  description: 'Echo the supplied text back verbatim. This is the only tool this server exposes.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo back.' } },
    required: ['text'],
    additionalProperties: false,
  },
};
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = request;
  // A notification carries no id and gets no reply.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      initialized = true;
      record({ kind: 'notifications/initialized' });
    }
    return;
  }

  switch (method) {
    case 'initialize':
      record({ kind: 'initialize', clientProtocolVersion: params?.protocolVersion ?? null });
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'byok-toolset-echo', version: '0.0.0' },
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      if (!initialized) {
        send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'server not initialized' } });
        return;
      }
      record({ kind: 'tools/list' });
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
      return;
    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    case 'resources/templates/list':
      send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
      return;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      record({ kind: 'tools/call', name: name ?? null, arguments: args });
      if (name !== TOOL.name) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `byok-echo:${String(args.text ?? '')}` }], isError: false },
      });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${JSON.stringify(method)}` } });
  }
});
