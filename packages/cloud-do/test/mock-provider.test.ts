import { describe, expect, it, vi } from 'vitest';
import { createMockProvider } from './fixtures/mock-provider';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(label: string, gate: Promise<void> = Promise.resolve()) {
  const read = deferred();
  const source = {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      try {
        await gate;
        yield JSON.stringify({ messages: [{ role: 'user', content: label }] });
      } finally { read.resolve(); }
    },
  };
  return { source, read: read.promise };
}
const response = () => ({ writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() });

describe('test mock provider ownership', () => {
  it('keeps a late request and continuation in the old test fixture', async () => {
    const old = createMockProvider([['old_tool']]);
    const gate = deferred(); const held = request('old', gate.promise); const oldResponse = response();
    const pending = old.handle(held.source, oldResponse);
    const next = createMockProvider([['next_tool']]); const nextResponse = response();
    await next.handle(request('next').source, nextResponse);
    const expectedBodies = structuredClone(next.bodies);
    const expectedResponse = nextResponse.end.mock.calls[0];
    gate.resolve(); await pending;
    // A timed-out test body may resume and reset its own scenario afterward.
    old.reset([['late_tool']]);
    await old.handle(request('late continuation').source, response());
    expect(next.bodies).toEqual(expectedBodies);
    expect(nextResponse.end).toHaveBeenCalledExactlyOnceWith(...expectedResponse!);
    expect(oldResponse.end.mock.calls[0]?.[0]).toContain('old_tool');
    expect(nextResponse.end.mock.calls[0]?.[0]).toContain('next_tool');
    await old.close(); await next.close();
  });

  it('captures the scenario before reading a delayed request body', async () => {
    const provider = createMockProvider([['old_tool']]);
    const gate = deferred(); const oldResponse = response();
    const pending = provider.handle(request('old', gate.promise).source, oldResponse);
    provider.reset([['next_tool']]); const nextResponse = response();
    await provider.handle(request('next').source, nextResponse);
    gate.resolve(); await pending;
    expect(provider.bodies).toEqual([{ messages: [{ role: 'user', content: 'next' }] }]);
    expect(oldResponse.end.mock.calls[0]?.[0]).toContain('old_tool');
    expect(nextResponse.end.mock.calls[0]?.[0]).toContain('next_tool');
    await provider.close();
  });

  it.each(['resolve', 'reject'] as const)('drains cancelled handlers before a held body can %s', async outcome => {
    const provider = createMockProvider(); const gate = deferred();
    const held = request('late', gate.promise); const reply = response();
    const pending = provider.handle(held.source, reply);
    await provider.close(); await pending;
    expect(held.source.destroy).toHaveBeenCalledOnce();
    expect(reply.destroy).toHaveBeenCalledOnce();
    if (outcome === 'resolve') gate.resolve(); else gate.reject(new Error('closed request'));
    await held.read;
    expect(provider.bodies).toEqual([]);
    expect(reply.writeHead).not.toHaveBeenCalled();
    expect(reply.end).not.toHaveBeenCalled();
    const later = request('after close'); const laterResponse = response();
    await provider.handle(later.source, laterResponse);
    expect(later.source.destroy).toHaveBeenCalledOnce();
    expect(laterResponse.destroy).toHaveBeenCalledOnce();
    expect(laterResponse.end).not.toHaveBeenCalled();
    await provider.close();
  });

  it('retains the existing tool-call frames, body recording, and completion response', async () => {
    const provider = createMockProvider([['first', 'second']]); const tools = response(); const done = response();
    await provider.handle(request('tools').source, tools);
    await provider.handle(request('done').source, done);
    expect(provider.bodies.map(body => body.messages[0]?.content)).toEqual(['tools', 'done']);
    expect(tools.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'text/event-stream' });
    const event = JSON.parse(tools.end.mock.calls[0]![0].split('\n')[0]!.slice('data: '.length));
    expect(event.choices[0]).toEqual({ index: 0, delta: { tool_calls: [
      { index: 0, id: 'wire_0', type: 'function', function: { name: 'first', arguments: '{}' } },
      { index: 1, id: 'wire_1', type: 'function', function: { name: 'second', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' });
    expect(done.end.mock.calls[0]?.[0]).toContain('"content":"Completed."');
    expect(done.end.mock.calls[0]?.[0]).toContain('"finish_reason":"stop"');
    await provider.close();
  });
});
