#!/usr/bin/env node
/**
 * A configurable stdio MCP server for the shared MCP core's tests
 * (`../mcp-core.test.ts`, `../mcp-projection.test.ts`).
 *
 * Hand-rolled JSON-RPC over newline-delimited JSON on purpose, for the reason
 * `toolset-echo-mcp.mjs` gives: the SDK depends on an MCP CLIENT, not a server,
 * and pulling a server implementation in for fixtures alone would be a hidden
 * dependency this package does not otherwise carry. It also lets the fixture
 * produce answers no correct server would — which is most of what these tests
 * are for.
 *
 * Usage: node mcp-fixture-server.mjs '<json config>'
 *   tools          raw value placed in `result.tools` (may be malformed on purpose)
 *   serverInfo     raw `serverInfo` in the initialize result
 *   protocolVersion  version to answer initialize with
 *   silent         never answer anything (drives the timeout path)
 *   floodBytes     emit at least this many bytes of well-formed unrelated stdout
 *                  before answering `tools/list`
 *   oversizedFrame emit a single frame of at least this many bytes
 *   callDelayMs    delay every `tools/call` answer by this long
 *   callError      answer every `tools/call` with this JSON-RPC error instead of a
 *                  result: `{ code, message }` — for the client's error classification
 *   callResult     answer every `tools/call` with this raw `result` object instead of
 *                  the default echo — for exercising content block kinds
 *                  (resource links, audio, `structuredContent`, empty content)
 *                  that no correct echo server would ever return
 *   recordTo       append every received method (and cancellation) as JSONL here,
 *                  preceded by one `{ event: 'start', pid, byokEnv }` entry so a test
 *                  can prove the child is gone and see which BYOK_* variables reached it
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const config = JSON.parse(process.argv[2] ?? '{}');

const DEFAULT_TOOLS = [
  {
    name: 'find_leads',
    description: 'Find leads matching a query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'echo',
    description: 'Echo the supplied text back verbatim.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function record(entry) {
  if (config.recordTo) appendFileSync(config.recordTo, `${JSON.stringify(entry)}\n`);
}

// The very first line: the child's own pid, so a test can prove the pool
// actually reaped it, and the BYOK_* variables it was spawned with, so a test
// can prove the SDK's own control variables were stripped before the spawn.
record({
  event: 'start',
  pid: process.pid,
  byokEnv: Object.keys(process.env).filter((name) => name.startsWith('BYOK_')).sort(),
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Keep the process alive even when nothing is expected of it, so a timeout is
// a timeout rather than an early exit.
const keepAlive = setInterval(() => {}, 60_000);
let initialized = false;

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
  record({ method, id: id ?? null });

  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') initialized = true;
    return;
  }

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: config.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: config.serverInfo ?? { name: 'byok-mcp-fixture', version: '1.0.0' },
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list': {
      if (!initialized) {
        send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'server not initialized' } });
        return;
      }
      if (typeof config.oversizedFrame === 'number') {
        // One frame, no newline until the very end: the read buffer must
        // refuse it rather than accumulate without limit.
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { tools: [], padding: 'x'.repeat(config.oversizedFrame) },
        })}\n`);
        return;
      }
      if (typeof config.floodBytes === 'number') {
        // Well-formed, newline-delimited, and entirely unrelated. Every frame
        // is individually small, so only a TOTAL byte cap stops this.
        const filler = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x'.repeat(4000) } })}\n`;
        let written = 0;
        while (written < config.floodBytes) {
          process.stdout.write(filler);
          written += Buffer.byteLength(filler, 'utf8');
        }
        return;
      }
      send({ jsonrpc: '2.0', id, result: { tools: config.tools ?? DEFAULT_TOOLS } });
      return;
    }
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const answer = () => (config.callError
        ? send({ jsonrpc: '2.0', id, error: { code: config.callError.code, message: config.callError.message } })
        : config.callResult
        ? send({ jsonrpc: '2.0', id, result: config.callResult })
        : send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `byok-fixture:${name}:${JSON.stringify(args)}` }],
            isError: false,
          },
        }));
      if (typeof config.callDelayMs === 'number') {
        const timer = setTimeout(answer, config.callDelayMs);
        timer.unref?.();
        return;
      }
      answer();
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${JSON.stringify(method)}` } });
  }
});

process.stdin.on('close', () => clearInterval(keepAlive));
