type ProviderBody = { messages: { role: string; content: string }[] };
type BodyRequest = AsyncIterable<{ toString(): string }> & { destroy(): unknown };
type ProviderResponse = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
  destroy(): unknown;
};

const frame = (delta: unknown, reason: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
const scenario = (tools: string[][]) => ({ tools: tools.map(names => [...names]), bodies: [] as ProviderBody[], nextRequest: 0 });

/** Test-owned provider state; every request keeps the scenario it entered with. */
export function createMockProvider(tools: string[][] = [['render_widget']]) {
  let current = scenario(tools);
  let closed = false;
  const pending = new Map<Promise<void>, () => void>();

  return {
    get bodies() { return current.bodies; },
    reset(tools: string[][]) { current = scenario(tools); },
    handle(request: BodyRequest, response: ProviderResponse): Promise<void> {
      if (closed) {
        request.destroy(); response.destroy();
        return Promise.resolve();
      }
      const owner = current;
      const names = owner.tools[owner.nextRequest++];
      let cancel!: () => void;
      const cancelled = new Promise<undefined>(resolve => {
        cancel = () => { resolve(undefined); request.destroy(); response.destroy(); };
      });
      const body = (async () => {
        let text = '';
        for await (const chunk of request) text += chunk.toString();
        return text;
      })();
      const handled = (async () => {
        const text = await Promise.race([body, cancelled]);
        if (text === undefined || closed) return;
        owner.bodies.push(JSON.parse(text));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(names
          ? frame({ tool_calls: names.map((name, i) => ({ index: i, id: `wire_${i}`, type: 'function', function: { name, arguments: '{}' } })) }, 'tool_calls')
          : frame({ content: 'Completed.' }, 'stop'));
      })();
      pending.set(handled, cancel);
      void handled.then(() => pending.delete(handled), () => pending.delete(handled));
      return handled;
    },
    async close() {
      closed = true;
      for (const cancel of pending.values()) cancel();
      // Cancellation settles the handlers even if a broken request source never
      // finishes reading. Its late body can no longer record or send a response.
      await Promise.allSettled(pending.keys());
    },
  };
}
