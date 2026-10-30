// A real stdio MCP server built on `src/mcp-server`, for the official-client
// interop suite. It is a separate process on purpose: the thing under test is
// what the pinned `@modelcontextprotocol/client` observes across a real pipe when it
// spawns a server, negotiates a version, lists, calls, cancels, pings and
// closes.
//
// Run with `node --import ./ts-source-resolve-hook.mjs`, which is what lets a
// plain Node process import the `.ts` source instead of a `dist/` build that
// may not exist when the suite runs.
//
// Env knobs (all optional):
//   MCP_FIXTURE_SLOW_MS   how long the `slow` tool waits before resolving
//   MCP_FIXTURE_LOG       append one JSON line per observed lifecycle event
import { appendFileSync, readFileSync } from 'node:fs';

import { McpServerToolError, serveMcpOverStdio } from '../../mcp-server/index.ts';

const logPath = process.env.MCP_FIXTURE_LOG;
const note = (tag, data) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ tag, data })}\n`);
};

const slowMs = Number(process.env.MCP_FIXTURE_SLOW_MS ?? '0');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the message back.',
    title: 'Echo', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' } },
    },
  },
  {
    name: 'slow',
    description: 'Resolve after MCP_FIXTURE_SLOW_MS, or as soon as the call is cancelled.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'boom',
    description: 'Always fails with a server-authored JSON-RPC error.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

async function callTool(call) {
  if (call.name === 'echo') {
    const message = call.arguments?.message;
    for (const [progress, message] of [[0, 'starting'], [1, 'done']]) {
      call.progress(progress, 1, message);
      // The official client's deferred notification callbacks can race its
      // synchronous result retirement. The test acknowledges each stage so
      // the fixture models work that remains active while progress is read.
      if (process.env.MCP_FIXTURE_PROGRESS_ACK) {
        const deadline = Date.now() + 5000;
        while (readFileSync(process.env.MCP_FIXTURE_PROGRESS_ACK, 'utf8') !== String(progress)) {
          if (Date.now() >= deadline) throw new Error('progress acknowledgement missing');
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
    }
    return { content: [{ type: 'text', text: `echo: ${typeof message === 'string' ? message : ''}` }], structuredContent: { message: typeof message === 'string' ? message : '' } };
  }
  if (call.name === 'slow') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, slowMs);
      call.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          note('aborted', { name: call.name });
          resolve(undefined);
        },
        { once: true },
      );
    });
    note('slow-settled', { aborted: call.signal.aborted });
    return { content: [{ type: 'text', text: 'slow done' }] };
  }
  if (call.name === 'boom') {
    throw new McpServerToolError(-32010, 'the fixture tool refused');
  }
  // R12: an undefined tool name is the SERVER's verdict, not the core's.
  throw new McpServerToolError(-32602, `unknown tool "${call.name}"`);
}

serveMcpOverStdio({
  serverInfo: { name: 'mcp-server-core-fixture', version: '0.0.1' },
  tools: TOOLS,
  callTool,
  onClose: (reason) => {
    note('close', reason.kind);
    // The core never exits the process; the bin decides. This fixture decides
    // to exit, so the client's transport sees a real child exit on EOF.
    process.exit(0);
  },
});
