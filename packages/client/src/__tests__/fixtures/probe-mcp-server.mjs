#!/usr/bin/env node
/**
 * A deliberately misbehaving stdio MCP server, used to pin
 * `daemon/mcp-tools-probe.ts`'s contract: which `tools/list` answers are
 * accepted, which are rejected, what the probed child's environment and cwd
 * actually are, and that the child is gone once the probe settles.
 *
 * The well-behaved counterpart is `toolset-echo-mcp.mjs`, which the live
 * permission smokes use; this one exists to produce answers a real server
 * should never produce.
 *
 * Usage: node probe-mcp-server.mjs '<json config>'
 *   tools       raw value placed in `result.tools` (may contain non-strings)
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
  if (request.id === 1 && request.method === 'initialize') {
    if (
      request.params?.protocolVersion !== '2024-11-05'
      || request.params?.capabilities === null
      || typeof request.params?.capabilities !== 'object'
      || typeof request.params?.clientInfo?.name !== 'string'
      || typeof request.params?.clientInfo?.version !== 'string'
    ) {
      send({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid initialize params' } });
      return;
    }
    send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
    return;
  }
  if (request.method === 'notifications/initialized' && request.id === undefined) {
    initialized = true;
    return;
  }
  if (request.id !== 2) return;
  if (!initialized) {
    send({ jsonrpc: '2.0', id: 2, error: { code: -32002, message: 'server not initialized' } });
    clearInterval(keepAlive);
    return;
  }
  if (typeof config.floodBytes === 'number') {
    // Unrelated, well-formed newline-delimited JSON the probe must skip. The
    // answer never arrives; the byte cap is what ends this.
    const filler = `${JSON.stringify({ jsonrpc: '2.0', method: 'log', params: { text: 'x'.repeat(4000) } })}\n`;
    let written = 0;
    while (written < config.floodBytes) {
      process.stdout.write(filler);
      written += Buffer.byteLength(filler, 'utf8');
    }
    return;
  }
  send({ jsonrpc: '2.0', id: 2, result: { tools: config.tools ?? [] } });
  clearInterval(keepAlive);
});
