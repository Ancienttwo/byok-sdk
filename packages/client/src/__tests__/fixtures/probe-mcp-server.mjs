#!/usr/bin/env node
/**
 * A deliberately misbehaving stdio MCP server, used to pin the daemon-facing
 * half of `daemon/mcp-tools-probe.ts`: what the spawned child is allowed to
 * see of the daemon's environment and working directory, that it is always
 * gone once the observation settles, and that an answer the server itself gave
 * is classified as permanent rather than retryable.
 *
 * The protocol-level contract (framing, byte bounds, drift) lives in
 * `../mcp-core.test.ts` against `mcp-fixture-server.mjs`; this one stays
 * focused on the child process.
 *
 * Usage: node probe-mcp-server.mjs '<json config>'
 *   tools       raw value placed in `result.tools` (may contain non-objects).
 *               Any object entry without an `inputSchema` gets a trivial one:
 *               these cases are about NAMES and streams, not schemas.
 *   silent      answer nothing at all, ever (drives the timeout path)
 *   floodBytes  emit at least this many bytes of unrelated stdout first
 *   dumpEnvTo   write the child's own process.env there as JSON
 *   dumpCwdTo   write the child's own process.cwd() there
 *   dumpPidTo   write the child's own pid there, before answering anything
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const config = JSON.parse(process.argv[2] ?? '{}');

if (config.dumpEnvTo) writeFileSync(config.dumpEnvTo, JSON.stringify(process.env), 'utf8');
if (config.dumpCwdTo) writeFileSync(config.dumpCwdTo, process.cwd(), 'utf8');
if (config.dumpPidTo) writeFileSync(config.dumpPidTo, String(process.pid), 'utf8');

// Keep the process alive even when nothing is expected of it, so a timeout is
// a timeout rather than an early exit.
const keepAlive = setInterval(() => {}, 60_000);
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Tool entries pass through untouched except for a default schema. */
function answeredTools() {
  const tools = config.tools ?? [];
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => (tool !== null && typeof tool === 'object' && !Array.isArray(tool)
    ? { description: '', inputSchema: { type: 'object' }, ...tool }
    : tool));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (config.silent) return;
  const text = line.trim();
  if (text.length === 0) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = request;

  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') initialized = true;
    return;
  }

  if (method === 'initialize') {
    if (
      typeof params?.protocolVersion !== 'string'
      || params?.capabilities === null
      || typeof params?.capabilities !== 'object'
      || typeof params?.clientInfo?.name !== 'string'
      || typeof params?.clientInfo?.version !== 'string'
    ) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid initialize params' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'byok-probe-fixture', version: '0.0.0' },
      },
    });
    return;
  }

  if (method !== 'tools/list') return;
  if (!initialized) {
    send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'server not initialized' } });
    clearInterval(keepAlive);
    return;
  }
  if (typeof config.floodBytes === 'number') {
    // Unrelated, well-formed newline-delimited JSON the client must skip. The
    // answer never arrives; the byte cap is what ends this.
    const filler = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'x'.repeat(4000) } })}\n`;
    let written = 0;
    while (written < config.floodBytes) {
      process.stdout.write(filler);
      written += Buffer.byteLength(filler, 'utf8');
    }
    return;
  }
  send({ jsonrpc: '2.0', id, result: { tools: answeredTools() } });
  clearInterval(keepAlive);
});
