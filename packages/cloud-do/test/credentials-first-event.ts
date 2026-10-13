/**
 * These tests cancel after model output, not after the first transport chunk.
 * AgentDO emits comment keepalives before data and streams may split a frame.
 * Read the first complete data event from that real stream; fail on an error
 * or EOF before text_delta instead of reporting a successful cancellation.
 */
export async function readFirstTextDelta(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder = new TextDecoder(),
): Promise<string> {
  let received = '';
  let pending = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error('SSE ended before text_delta');
    const text = decoder.decode(next.value, { stream: true });
    received += text;
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (frame.startsWith(':')) continue;
      if (!frame.startsWith('data: ')) throw new Error('Unexpected AgentDO SSE frame');
      const event: unknown = JSON.parse(frame.slice(6));
      if (event === null || typeof event !== 'object' || !('type' in event) || event.type !== 'text_delta') {
        throw new Error('Expected text_delta as the first AgentDO SSE data event');
      }
      return received;
    }
  }
}
