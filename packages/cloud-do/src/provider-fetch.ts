import type { FetchFunction } from '@earendil-works/pi-ai';
import { CloudDoError, safeCloudError } from './errors';
import { RollingLeakGuard } from './leak-guard';
import { hasUserKeyShape } from './admission';
import { requirePlatformKey, type PlatformProfile } from './platform-credentials';

const FRAME_LIMIT = 65_536;
const TOOL_ARGUMENT_LIMIT = 65_536;
const TOOL_CALL_LIMIT = 12;

export interface CloudToolTransport {
  readonly offeredToolNames: readonly string[];
  admitToolCall(name: string, rawId: string, args: Record<string, unknown>): void | Promise<void>;
  onSend?(): void;
  onUsage?(usage: Record<string, number>): void;
}

type ToolAssembly = { id?: string; name?: string; type?: 'function'; arguments: string };
type CheckedToolCall = { index: number; id: string; type: 'function'; function: { name: string; arguments: string } };

/** Tool fields stay private until the whole response is complete and admitted. */
class ToolCallAssembly {
  private readonly calls = new Map<number, ToolAssembly>();
  private argumentBytes = 0;
  private readonly encoder = new TextEncoder();
  constructor(private readonly key: string, private readonly config?: CloudToolTransport) {}

  private reject(): never { throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED'); }

  private checkString(value: string): void {
    if (hasUserKeyShape(value)) this.reject();
    const guard = new RollingLeakGuard(this.key);
    guard.push(value); guard.finish();
  }

  private checkValues(value: unknown): void {
    const pending = [value];
    while (pending.length) {
      const next = pending.pop();
      if (typeof next === 'string') this.checkString(next);
      else if (Array.isArray(next)) pending.push(...next);
      else if (object(next)) {
        for (const [name, child] of Object.entries(next as Record<string, unknown>)) {
          this.checkString(name); pending.push(child);
        }
      }
    }
  }

  add(value: unknown): void {
    if (!this.config || !Array.isArray(value) || value.length > TOOL_CALL_LIMIT) this.reject();
    const indices = new Set<number>();
    for (const item of value) {
      const row = object(item);
      if (!row || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= TOOL_CALL_LIMIT) this.reject();
      const index = row.index as number;
      if (indices.has(index)) this.reject();
      indices.add(index);
      const call = this.calls.get(index) ?? { arguments: '' };
      if (!this.calls.has(index)) this.calls.set(index, call);
      if (row.id != null) {
        if (call.id !== undefined || typeof row.id !== 'string' || !row.id || row.id.length > 512) this.reject();
        this.checkString(row.id); call.id = row.id;
      }
      if (row.type != null) {
        if (call.type !== undefined || row.type !== 'function') this.reject();
        call.type = 'function';
      }
      if (row.function != null) {
        const fn = object(row.function);
        if (!fn) this.reject();
        if (fn.name != null) {
          if (call.name !== undefined || typeof fn.name !== 'string' || !this.config!.offeredToolNames.includes(fn.name)) this.reject();
          this.checkString(fn.name); call.name = fn.name;
        }
        if (fn.arguments != null) {
          if (typeof fn.arguments !== 'string') this.reject();
          this.argumentBytes += this.encoder.encode(fn.arguments).byteLength;
          if (this.argumentBytes > TOOL_ARGUMENT_LIMIT) this.reject();
          call.arguments += fn.arguments;
        }
      }
    }
  }

  get size(): number { return this.calls.size; }

  async finish(): Promise<CheckedToolCall[]> {
    const checked: { index: number; call: ToolAssembly; args: Record<string, unknown> }[] = [];
    const ids = new Set<string>();
    const ordered = [...this.calls].sort(([left], [right]) => left - right);
    for (const [index, call] of ordered) {
      if (index !== checked.length || !call.id || !call.name || call.type !== 'function' || ids.has(call.id)) this.reject();
      ids.add(call.id);
      let parsed: unknown;
      try { parsed = JSON.parse(call.arguments); } catch { this.reject(); }
      const args = object(parsed);
      if (!args) this.reject();
      this.checkValues(args);
      checked.push({ index, call, args });
    }
    // Admit every call before returning any native event or retained tool field.
    for (const { call, args } of checked) await this.config!.admitToolCall(call.name!, call.id!, args);
    return checked.map(({ index, call, args }) => ({ index, id: `call_${index + 1}`, type: 'function',
      function: { name: call.name!, arguments: JSON.stringify(args) } }));
  }
}
type Lane = 'content' | 'reasoning_content';
type Segment = { lane: Lane; text: string };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Read bounded complete SSE frames, not an entire provider response. JSON escaping
 * is decoded by the caller before text enters the rolling guard. */
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let frame = '';
  let line = '';
  let lastWasCR = false;
  while (true) {
    const next = await reader.read();
    const text = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
    for (const character of text) {
      if (character === '\n' && lastWasCR) { lastWasCR = false; continue; }
      lastWasCR = character === '\r';
      if (character === '\n' || character === '\r') {
        if (!line) { if (frame) yield frame; frame = ''; }
        else { frame += `${line}\n`; line = ''; }
      } else line += character;
      if (frame.length + line.length > FRAME_LIMIT) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
    }
    if (next.done) {
      if (line || frame) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
      return;
    }
  }
}

function eventData(frame: string): string {
  return frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
}

export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  try {
    for await (const frame of frames(reader)) {
      const data = eventData(frame);
      if (data) yield data;
    }
  } finally { try { await reader.cancel(); } catch { /* Never retain an upstream error. */ } }
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const result: Record<string, number> = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const n = usage[field];
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) result[field] = n;
  }
  return Object.keys(result).length ? result : undefined;
}

/** The SDK receives only re-encoded, checked text and bounded numeric usage. IDs,
 * headers and arbitrary vendor fields never cross this boundary. Tool calls cross
 * only after terminal assembly, decoded-value checks and admission. */
function guardedBody(body: ReadableStream<Uint8Array>, key: string, profile: PlatformProfile, abort: AbortController, cleanup: () => void, transport?: CloudToolTransport): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const guard = new RollingLeakGuard(key);
  // pi reconstructs each lane separately. Checking only wire order lets benign
  // thinking deltas hide a key that is reassembled inside the content lane.
  const laneGuards = { content: new RollingLeakGuard(key), reasoning_content: new RollingLeakGuard(key) };
  const segments: Segment[] = [];
  const encoder = new TextEncoder();
  let finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | undefined;
  const tools = new ToolCallAssembly(key, transport);
  let usage: Record<string, number> | undefined;
  const encode = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'cloud', object: 'chat.completion.chunk', created: 0, model: profile.model,
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const release = (text: string): string => {
    let remaining = text.length;
    let result = '';
    while (remaining > 0) {
      const first = segments[0]!;
      const size = Math.min(first.text.length, remaining);
      result += encode({ [first.lane]: first.text.slice(0, size) });
      first.text = first.text.slice(size);
      remaining -= size;
      if (!first.text) segments.shift();
    }
    return result;
  };
  const stop = async () => {
    guard.discard(); laneGuards.content.discard(); laneGuards.reasoning_content.discard(); segments.length = 0;
    try { await reader.cancel(); } catch { /* No upstream exceptions escape. */ }
    finally { abort.abort(); cleanup(); }
  };
  const checkedLane = (lane: Lane, text: string): string => {
    if (!text) return '';
    const previous = segments.at(-1);
    if (previous?.lane === lane) previous.text += text;
    else segments.push({ lane, text });
    return release(guard.push(text));
  };
  async function* output(): AsyncGenerator<string> {
    let done = false;
    try {
      for await (const frame of frames(reader)) {
        const data = eventData(frame);
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        const payload = object(JSON.parse(data));
        if (!payload || payload.error) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        const currentUsage = numericUsage(payload.usage);
        if (currentUsage) {
          for (const [field, value] of Object.entries(currentUsage)) {
            if (usage?.[field] !== undefined && value < usage[field]!) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
          }
          usage = { ...usage, ...currentUsage };
          transport?.onUsage?.(usage);
        }
        if (!Array.isArray(payload.choices)) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        const choice = payload.choices.find(item => object(item)?.index === 0);
        if (!choice) continue; // e.g. the terminal numeric-usage frame
        const row = object(choice)!;
        const delta = object(row.delta);
        if (!delta || delta.function_call || delta.refusal) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        if (finishReason && (delta.tool_calls != null || delta.content || delta.reasoning_content)) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        if (delta.tool_calls != null) tools.add(delta.tool_calls);
        for (const lane of ['content', 'reasoning_content'] as const) {
          const text = delta[lane];
          if (text === undefined || text === null) continue;
          if (typeof text !== 'string') throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
          if (!text) continue;
          const safe = checkedLane(lane, laneGuards[lane].push(text));
          if (safe) yield safe;
        }
        if (row.finish_reason != null) {
          if (finishReason || !['stop', 'length', 'content_filter', 'tool_calls'].includes(String(row.finish_reason))) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
          finishReason = row.finish_reason as 'stop' | 'length' | 'content_filter' | 'tool_calls';
        }
      }
      if (!done && !finishReason) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
      if ((tools.size > 0) !== (finishReason === 'tool_calls')) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
      const checkedTools = tools.size ? await tools.finish() : [];
      const terminal = encode(checkedTools.length ? { tool_calls: checkedTools } : {}, finishReason ?? 'stop');
      if (terminal.length > FRAME_LIMIT) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
      for (const lane of ['content', 'reasoning_content'] as const) {
        const safe = checkedLane(lane, laneGuards[lane].finish());
        if (safe) yield safe;
      }
      const final = release(guard.finish());
      if (final) yield final;
      yield terminal;
      if (usage) yield `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
      yield 'data: [DONE]\n\n';
    } catch (error) { throw safeCloudError(error); }
    finally { await stop(); }
  }
  const iterator = output();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { controller.error(safeCloudError(error)); }
    },
    async cancel() { await stop(); await iterator.return(undefined); },
  });
}

/** Credential only in auth headers; never follow any redirect, even same origin. */
export function createProviderFetch(profile: PlatformProfile, secret: string, fetchImpl: FetchFunction = globalThis.fetch, transport?: CloudToolTransport): FetchFunction {
  const key = requirePlatformKey(secret);
  const endpoint = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`;
  return async (input, init) => {
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw new CloudDoError('CLOUD_REQUEST_INVALID'); }
    if (request.url !== endpoint || request.method !== 'POST') throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) abort.abort();
    const cleanup = () => request.signal.removeEventListener('abort', onAbort);
    try {
      const dispatch = new Request(request, { signal: abort.signal,
        redirect: 'manual', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' } });
      if (abort.signal.aborted) throw new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
      transport?.onSend?.();
      const response = await fetchImpl(dispatch);
      if (!response.ok || (response.status >= 300 && response.status < 400) || !response.body
        || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        abort.abort(); cleanup();
        try { await response.body?.cancel(); } catch { /* Drop raw error bodies. */ }
        throw new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
      }
      return new Response(guardedBody(response.body, key, profile, abort, cleanup, transport), { headers: { 'content-type': 'text/event-stream' } });
    } catch (error) { abort.abort(); cleanup(); throw safeCloudError(error); }
  };
}
