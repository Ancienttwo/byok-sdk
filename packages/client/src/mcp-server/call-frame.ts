import type { McpServerRequestId } from './dispatch.js';

// A helper can opt into a small tool error when its valid result cannot fit in
// the actual JSON-RPC envelope. The public handler and result shapes stay intact.
const oversizeResults = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

export function withOversizeToolResult(
  result: Record<string, unknown>,
  onOversize: Record<string, unknown>,
): Record<string, unknown> {
  oversizeResults.set(result, onOversize);
  return result;
}

export function encodeToolResultFrame(
  id: McpServerRequestId,
  result: Record<string, unknown>,
  maxBytes: number,
): string {
  const response = { jsonrpc: '2.0', id, result };
  const frame = `${JSON.stringify(response)}\n`;
  const onOversize = oversizeResults.get(result);
  if (onOversize === undefined || Buffer.byteLength(frame, 'utf8') <= maxBytes) return frame;
  response.result = onOversize;
  return `${JSON.stringify(response)}\n`;
}
