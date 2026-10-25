/**
 * Returns `response` with a body that calls `release` once, after the body ends, errors or is cancelled. A streamed
 * response (the board SSE stream) keeps querying after `fetch` returns its headers, so the invocation's pools must stay
 * open until then. A response with no body releases at once.
 */
export function releaseAfterBody(response: Response, release: () => void): Response {
  let released = false;
  const once = () => { if (!released) { released = true; release(); } };
  if (response.body === null) { once(); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); once(); } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        once();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { once(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
