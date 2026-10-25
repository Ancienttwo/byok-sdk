import { expect, it } from 'vitest';
import { releaseAfterBody } from './body-lifetime';

/** A streamed body that the test feeds chunk by chunk, as the board SSE stream does after `fetch` returned. */
function streamed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return { response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), controller };
}

it('keeps the pools until a streamed body ends, then releases once', async () => {
  const { response, controller } = streamed();
  let releases = 0;
  const wrapped = releaseAfterBody(response, () => { releases++; });
  expect([wrapped.status, wrapped.headers.get('content-type')]).toEqual([200, 'text/event-stream']);
  const reader = wrapped.body!.getReader();
  controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
  expect(releases).toBe(0);
  controller.enqueue(new TextEncoder().encode('data: 2\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n\n');
  expect(releases).toBe(0);
  controller.close();
  expect((await reader.read()).done).toBe(true);
  expect(releases).toBe(1);
});

it('releases once when the client cancels the stream', async () => {
  const { response } = streamed();
  let releases = 0;
  const wrapped = releaseAfterBody(response, () => { releases++; });
  await wrapped.body!.cancel('client gone');
  expect(releases).toBe(1);
});

it('releases once when the body errors', async () => {
  const { response, controller } = streamed();
  let releases = 0;
  const reader = releaseAfterBody(response, () => { releases++; }).body!.getReader();
  controller.error(new Error('query failed'));
  await expect(reader.read()).rejects.toThrow('query failed');
  expect(releases).toBe(1);
});

it('releases at once for a response with no body', () => {
  let releases = 0;
  releaseAfterBody(new Response(null, { status: 204 }), () => { releases++; });
  expect(releases).toBe(1);
});
