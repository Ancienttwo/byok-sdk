import { CloudDoError, safeCloudError } from './errors';
import type { CloudState } from './cloud-state';

/** A doorbell is advisory. Every delivery reads the durable SQL cursor again. */
export class CloudEventDoorbell {
  private generation = 0;
  private listeners = new Set<() => void>();
  ring(): void { this.generation++; for (const listener of [...this.listeners]) listener(); }
  get version(): number { return this.generation; }
  wait(version: number, signal: AbortSignal, duration = 15_000): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
      timer = setTimeout(finish, duration);
      this.listeners.add(finish); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || version !== this.generation) finish();
    });
  }
}

export class CloudEventStreams {
  private readers = 0;
  constructor(private readonly bell: CloudEventDoorbell) {}
  open(state: CloudState, after: number | undefined, waitUntil: (work: Promise<unknown>) => void): Response {
    if (this.readers >= 8) throw new CloudDoError('CLOUD_EVENTS_BUSY');
    const meta = state.eventMeta();
    const cursor = after === undefined ? meta.highWater : after === 0 ? meta.trimmedThrough : after;
    try { state.eventPage(cursor, 1); }
    catch (error) {
      if (safeCloudError(error).code === 'CLOUD_EVENT_CURSOR_EXPIRED') return Response.json({ error: { code: 'CLOUD_EVENT_CURSOR_EXPIRED', retryable: false }, ...meta }, { status: 410 });
      throw error;
    }
    this.readers++;
    const body = new IdentityTransformStream();
    const writer = body.writable.getWriter();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let cleaned = false;
    let last = cursor;
    const close = () => { if (!cleaned) { cleaned = true; this.readers--; controller.abort(); } };
    const limit = setTimeout(() => { close(); void writer.abort().catch(() => undefined); }, 110_000);
    void writer.closed.catch(close);
    let probing = false;
    const probe = setInterval(() => {
      if (controller.signal.aborted || probing) return;
      probing = true;
      void writer.write(encoder.encode(': keepalive\n\n')).catch(close).finally(() => { probing = false; });
    }, 250);
    const run = async () => {
      try {
        while (!controller.signal.aborted) {
          const version = this.bell.version;
          let rows;
          try { rows = state.eventPage(last); }
          catch (error) {
            if (safeCloudError(error).code !== 'CLOUD_EVENT_CURSOR_EXPIRED') throw error;
            await writer.write(encoder.encode('event: reset\ndata: ' + JSON.stringify(state.eventMeta()) + '\n\n'));
            break;
          }
          for (const row of rows) {
            if (controller.signal.aborted) break;
            await writer.write(encoder.encode('id: ' + row.seq + '\nevent: ' + row.type + '\ndata: ' + row.dataJson + '\n\n'));
            last = row.seq;
          }
          if (!rows.length && !controller.signal.aborted) {
            await this.bell.wait(version, controller.signal);
            if (!controller.signal.aborted && version === this.bell.version) await writer.write(encoder.encode(': keepalive\n\n'));
          }
        }
        try { await writer.close(); } catch { /* A peer may already have closed the native stream. */ }
      } catch { try { await writer.abort(); } catch { /* No raw transport exception escapes. */ } }
      finally { clearTimeout(limit); clearInterval(probe); close(); }
    };
    waitUntil(run());
    return new Response(body.readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
}
