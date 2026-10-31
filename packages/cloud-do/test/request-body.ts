/**
 * Read an HTTP request body as one UTF-8 string.
 *
 * A body arrives in transport-sized chunks whose boundaries can fall inside a
 * multi-byte code point. Decoding each chunk on its own (`chunk.toString()`)
 * then turns the two halves into U+FFFD replacement characters. Accumulate the
 * bytes and decode exactly once so every code point survives.
 */
export async function readUtf8Body(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // Fatal decoding keeps a genuinely non-UTF-8 body loud instead of silent U+FFFD.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new Error(`Request body is not valid UTF-8 (${size} bytes)`);
  }
}
