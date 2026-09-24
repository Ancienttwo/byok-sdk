/**
 * Single-frame bound for the JSONL RPC frames the SDK SENDS to a Pi host.
 *
 * The SDK owns this bound. Official `@earendil-works/pi-coding-agent@0.87.1`
 * reads stdin with no upper bound (`modes/rpc/jsonl.ts`), so the host no
 * longer refuses an oversized frame; the SDK keeps refusing to send one,
 * because the limit protects the peer's memory, not the SDK's. The value is
 * the one the retired fork enforced on its reader (8 MiB), so every frame the
 * SDK admitted before still fits and nothing admitted now would have been
 * refused then.
 *
 * A frame is the UTF-8 bytes of `JSON.stringify(message) + "\n"`: bytes, not
 * string length, because CJK or escaped control characters take several
 * bytes per character.
 */
export const RPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** UTF-8 byte length of the complete wire frame for one message, LF included. */
export function rpcFrameByteLength(message: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(message)}\n`, 'utf8');
}

/** Whether one message fits in a single frame under {@link RPC_MAX_FRAME_BYTES}. */
export function fitsRpcFrame(message: unknown): boolean {
  return rpcFrameByteLength(message) <= RPC_MAX_FRAME_BYTES;
}
