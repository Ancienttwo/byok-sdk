import { describe, expect, test } from 'vitest';

import { fitsRpcFrame, RPC_MAX_FRAME_BYTES, rpcFrameByteLength } from '../rpc-frame';

describe('rpc-frame', () => {
  test('the limit is the 8 MiB bound the retired fork host enforced', () => {
    expect(RPC_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  test('measures UTF-8 bytes of JSON plus the LF terminator', () => {
    expect(rpcFrameByteLength({ a: 1 })).toBe('{"a":1}\n'.length);
    // U+4E2D is 3 UTF-8 bytes; the string length would say 1.
    expect(rpcFrameByteLength('中')).toBe(Buffer.byteLength('"中"\n', 'utf8'));
    expect(rpcFrameByteLength('中')).toBe(6);
    // An escaped control character is serialized as six ASCII bytes.
    expect(rpcFrameByteLength('\u0001')).toBe('"\\u0001"\n'.length);
  });

  test('a frame of exactly the limit fits; one byte more does not', () => {
    const overhead = rpcFrameByteLength({ p: '' });
    const exact = { p: 'x'.repeat(RPC_MAX_FRAME_BYTES - overhead) };
    const over = { p: 'x'.repeat(RPC_MAX_FRAME_BYTES - overhead + 1) };
    expect(rpcFrameByteLength(exact)).toBe(RPC_MAX_FRAME_BYTES);
    expect(fitsRpcFrame(exact)).toBe(true);
    expect(rpcFrameByteLength(over)).toBe(RPC_MAX_FRAME_BYTES + 1);
    expect(fitsRpcFrame(over)).toBe(false);
  });

  test('multi-byte payloads are bounded by bytes, not characters', () => {
    const overhead = rpcFrameByteLength({ p: '' });
    const chars = Math.floor((RPC_MAX_FRAME_BYTES - overhead) / 3) + 1;
    const cjk = { p: '中'.repeat(chars) };
    expect(cjk.p.length).toBeLessThan(RPC_MAX_FRAME_BYTES);
    expect(fitsRpcFrame(cjk)).toBe(false);
  });
});
