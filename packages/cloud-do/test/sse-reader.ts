/** Read through a complete data frame, retaining preceding keepalive comments. */
export async function readThroughFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder = new TextDecoder(),
): Promise<string> {
  let text = '';
  let frameStart = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE body ended before its first complete data event');
    text += decoder.decode(chunk.value, { stream: true });
    let frameEnd: number;
    while ((frameEnd = text.indexOf('\n\n', frameStart)) !== -1) {
      const frame = text.slice(frameStart, frameEnd);
      frameStart = frameEnd + 2;
      if (frame.split('\n').some(line => line.startsWith('data: '))) return text;
    }
  }
}
