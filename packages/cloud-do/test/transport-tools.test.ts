import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Tool } from '@earendil-works/pi-ai';
import { createProviderFetch, type CloudToolTransport } from '../src/provider-fetch';
import { createPlatformModels, type CloudModelRuntime } from '../src/platform-provider';
import { CloudDoError, type CloudDoErrorCode } from '../src/errors';
import { PLATFORM_PROFILES } from '../src/platform-credentials';

const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
const SECONDARY = 'Secondary~0123456789QRSTUVWXYZabcd';
const profile = PLATFORM_PROFILES.zai_openai;
const endpoint = `${profile.baseUrl}/chat/completions`;
const tool = (name: string): Tool => ({ name, description: 'Read data.', parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } });
const frame = (toolCalls: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'raw-provider-id', vendor: 'discarded', choices: [{ index: 0, delta: { tool_calls: toolCalls, vendor: 'discarded', ...extra }, finish_reason: finish }] })}\n\n`;
const call = (index = 0, name = 'get_security_profile', args = '{}', id = `upstream-${index}`) => ({ index, id, type: 'function', function: { name, arguments: args } });
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
const response = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const names = ['get_security_profile', 'get_quote_snapshot'];
async function checked(text: string, admit = vi.fn(), offeredToolNames = names) {
  const config: CloudToolTransport = { offeredToolNames, admitToolCall: admit };
  const fetch = createProviderFetch(profile, KEY, async () => response(text), config);
  return (await fetch(endpoint, { method: 'POST', body: '{}' })).text();
}

function models(runtime?: CloudModelRuntime) {
  const models = createPlatformModels({ AIPHABEE_ZAI_API_KEY: KEY }, undefined, runtime);
  return { models, model: models.getModel('zai_openai', profile.model)! };
}

describe('bounded tool-call transport', () => {
  it('assembles interleaved fragments by index, admits decoded objects, and replaces raw ids', async () => {
    const admit = vi.fn();
    const wire = frame([call(1, names[1], '{"value":"se'), call(0, names[0], '{"value":"fi')])
      + frame([{ index: 0, function: { arguments: 'rst"}' } }, { index: 1, function: { arguments: 'cond"}' } }]) + ending;
    const text = await checked(wire, admit);
    expect(admit.mock.calls).toEqual([[names[0], 'upstream-0', { value: 'first' }], [names[1], 'upstream-1', { value: 'second' }]]);
    const payload = JSON.parse(text.split('\n').find(line => line.startsWith('data: {'))!.slice(6));
    expect(payload.choices[0]).toEqual({ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: names[0], arguments: '{"value":"first"}' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: names[1], arguments: '{"value":"second"}' } },
    ] }, finish_reason: 'tool_calls' });
    expect(text).not.toContain('upstream-');
    expect(text).not.toContain('discarded');
  });

  it('treats null optional streaming metadata as absent while still assembling arguments', async () => {
    const admit = vi.fn();
    const wire = frame([call(0, names[0], '{"value":"')])
      + frame([{ index: 0, id: null, type: null, function: { name: null, arguments: 'safe"}' } }])
      + frame([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }])
      + frame([{ index: 0, function: null }]) + ending.replace('"delta":{}', '"delta":{"tool_calls":null}');
    const text = await checked(wire, admit);
    expect(admit.mock.calls).toEqual([[names[0], 'upstream-0', { value: 'safe' }]]);
    expect(text).toContain('call_1');
    expect(text).not.toContain('upstream-0');
  });

  it('withholds tools until terminal completion and async admission of every call', async () => {
    let finish!: () => void;
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    const admit = vi.fn(async () => admission);
    const upstream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame([call()])));
      finish = () => { controller.enqueue(new TextEncoder().encode(ending)); controller.close(); };
    } });
    const fetch = createProviderFetch(profile, KEY, async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }), { offeredToolNames: names, admitToolCall: admit });
    const output = await fetch(endpoint, { method: 'POST', body: '{}' });
    let complete = false;
    const reading = output.text().then(text => { complete = true; return text; });
    await Promise.resolve();
    expect(admit).not.toHaveBeenCalled();
    expect(complete).toBe(false);
    finish();
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    release();
    expect(await reading).toContain('call_1');
  });

  const invalid = [
    { label: 'unknown name', wire: frame([call(0, 'unknown')]) + ending },
    { label: 'name change', wire: frame([call()]) + frame([{ index: 0, function: { name: names[1] } }]) + ending },
    { label: 'duplicate name', wire: frame([call()]) + frame([{ index: 0, function: { name: names[0] } }]) + ending },
    { label: 'duplicate id', wire: frame([call()]) + frame([{ index: 0, id: 'again' }]) + ending },
    { label: 'duplicate type', wire: frame([call()]) + frame([{ index: 0, type: 'function' }]) + ending },
    { label: 'duplicate index in frame', wire: frame([call(), call()]) + ending },
    { label: 'duplicate raw ids', wire: frame([call(), call(1, names[1], '{}', 'upstream-0')]) + ending },
    { label: 'negative index', wire: frame([call(-1)]) + ending },
    { label: 'fractional index', wire: frame([call(0.5)]) + ending },
    { label: 'index gap', wire: frame([call(1)]) + ending },
    { label: 'thirteenth call', wire: frame(Array.from({ length: 13 }, (_, index) => call(index))) + ending },
    { label: 'malformed JSON', wire: frame([call(0, names[0], '{')]) + ending },
    { label: 'JSON array', wire: frame([call(0, names[0], '[]')]) + ending },
    { label: 'JSON null', wire: frame([call(0, names[0], 'null')]) + ending },
    { label: 'missing id', wire: frame([{ index: 0, type: 'function', function: { name: names[0], arguments: '{}' } }]) + ending },
    { label: 'missing name', wire: frame([{ index: 0, id: 'x', type: 'function', function: { arguments: '{}' } }]) + ending },
    { label: 'incomplete EOF', wire: frame([call(0, names[0], '{')]) },
    { label: 'complete call without finish reason', wire: frame([call()]) + 'data: [DONE]\n\n' },
    { label: 'wrong finish reason', wire: frame([call()], 'stop') + 'data: [DONE]\n\n' },
    { label: 'tool finish without calls', wire: ending },
    { label: 'call after finish', wire: frame([call()], 'tool_calls') + frame([{ index: 0, function: { arguments: 'x' } }]) },
    { label: 'overlarge total arguments', wire: frame([call(0, names[0], '{"value":"' + 'x'.repeat(30_000))]) + frame([{ index: 0, function: { arguments: 'x'.repeat(30_000) } }]) + frame([{ index: 0, function: { arguments: 'x'.repeat(6_000) + '"}' } }]) + ending },
  ];
  for (const { label, wire } of invalid) it(`rejects ${label} before admission or tool release`, async () => {
    const admit = vi.fn();
    await expect(checked(wire, admit)).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(admit).not.toHaveBeenCalled();
  });

  for (const value of [KEY, btoa(KEY), encodeURIComponent(KEY), 'sk-proj-UserSecret0123456789abcdef']) {
    for (const field of ['id', 'name', 'argument value', 'argument key']) it(`rejects secret in ${field} before admission`, async () => {
      const wireCall = field === 'id' ? call(0, names[0], '{}', value)
        : field === 'name' ? call(0, value)
        : call(0, names[0], JSON.stringify(field === 'argument key' ? { [value]: 'x' } : { value }));
      const admit = vi.fn();
      await expect(checked(frame([wireCall]) + ending, admit, field === 'name' ? [value] : names)).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
      expect(admit).not.toHaveBeenCalled();
    });
  }

  for (const field of ['id', 'name']) it(`rejects Unicode-escaped raw ${field} before admission`, async () => {
    const encoded = Array.from(KEY, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const wireCall = field === 'id' ? call(0, names[0], '{}', KEY) : call(0, KEY);
    const wire = frame([wireCall]).replace(JSON.stringify(KEY), `"${encoded}"`) + ending;
    const admit = vi.fn();
    await expect(checked(wire, admit, field === 'name' ? [KEY] : names)).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(admit).not.toHaveBeenCalled();
  });

  it('drops unknown fields inside tool-call envelopes and retains numeric usage', async () => {
    const wireCall = { ...call(), vendor: KEY, function: { ...call().function, vendor: KEY } };
    const wire = frame([wireCall]) + ending.replace('data: [DONE]',
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, vendor: KEY } })}\n\ndata: [DONE]`);
    const text = await checked(wire);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('vendor');
    expect(text).toContain('"prompt_tokens":11,"completion_tokens":7,"total_tokens":18');
  });

  it('decodes split Unicode argument escapes before the leak check', async () => {
    const encoded = Array.from(KEY, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const args = `{"value":"${encoded}"}`;
    const wire = frame([call(0, names[0], args.slice(0, 17))])
      + frame([{ index: 0, function: { arguments: args.slice(17) } }]) + ending;
    const admit = vi.fn();
    await expect(checked(wire, admit)).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(admit).not.toHaveBeenCalled();
  });

  it('lets the trusted callback reject a secondary configured key before native tool events', async () => {
    const { models: registry, model } = models({ beforeRequest() {}, admitToolCall(_name, _id, args) {
      if (args.value === SECONDARY) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
    } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(frame([call(0, names[0], JSON.stringify({ value: SECONDARY }))]) + ending));
    try {
      const stream = registry.stream(model, { messages: [{ role: 'system', content: '', toolsAdded: [tool(names[0]!)], timestamp: 0 }] });
      const events = [];
      for await (const event of stream) events.push(event);
      expect((await stream.result()).errorMessage).toBe('CLOUD_MODEL_RESPONSE_REJECTED');
      expect(events.some(event => event.type.startsWith('toolcall'))).toBe(false);
      expect(JSON.stringify(events)).not.toContain(SECONDARY);
    } finally { fetch.mockRestore(); }
  });

  it('rejects non-SSE tool results sent through the model boundary', async () => {
    const fetch = createProviderFetch(profile, KEY, async () => Response.json({ ok: true, data: {} }), { offeredToolNames: names, admitToolCall() {} });
    await expect(fetch(endpoint, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'CLOUD_MODEL_REQUEST_FAILED' });
  });
});

describe('native platform model tool messages and stop gate', () => {
  it('sends only current tool schemas, serializes assistant calls and tool results, and emits native toolUse', async () => {
    const admit = vi.fn();
    const { models: registry, model } = models({ beforeRequest() {}, admitToolCall: admit });
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: names[0]!, arguments: { value: 'old' } }],
      api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    let body: Record<string, unknown> | undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      body = JSON.parse(await new Request(input, init).text());
      return response(frame([call(0, names[1], '{"value":"new"}')]) + ending);
    });
    try {
      const stream = registry.stream(model, { messages: [
        { role: 'system', content: 'Read data.', toolsAdded: [tool(names[0]!)], timestamp: 0 }, assistant,
        { role: 'toolResult', toolCallId: 'call_1', toolName: names[0]!, content: [{ type: 'text', text: '{"ok":true}' }], isError: false, timestamp: 2 },
        { role: 'system', content: 'Tool changed.', toolsRemoved: [{ name: names[0]! }], toolsAdded: [tool(names[1]!)], timestamp: 3 },
      ] });
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      expect(body!.tools).toEqual([{ type: 'function', function: tool(names[1]!) }]);
      expect(body!.messages).toEqual([
        { role: 'system', content: 'Read data.' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: names[0], arguments: '{"value":"old"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
        { role: 'system', content: 'Tool changed.' },
      ]);
      expect(result.stopReason).toBe('toolUse');
      expect(result.content).toEqual([{ type: 'toolCall', id: 'call_1', name: names[1], arguments: { value: 'new' } }]);
      expect(events.map(event => event.type)).toEqual(['start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
      expect(admit.mock.calls).toEqual([[names[1], 'upstream-0', { value: 'new' }]]);
    } finally { fetch.mockRestore(); }
  });

  for (const code of ['CLOUD_EXECUTION_INTERRUPTED', 'CLOUD_TOOL_RESULT_LIMIT', 'CLOUD_STEP_LIMIT', 'CLOUD_TOOL_LIMIT', 'CLOUD_TOOL_TIMEOUT', 'CLOUD_EXECUTION_TIMEOUT'] as const satisfies readonly CloudDoErrorCode[]) {
    for (const method of ['stream', 'streamSimple'] as const) it(`preserves ${code} from ${method} gate before any provider request with live cancel signal`, async () => {
      const { models: registry, model } = models({ async beforeRequest() { throw new CloudDoError(code); }, admitToolCall() {} });
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not send'));
      const signal = new AbortController().signal;
      try {
        const stream = registry[method](model, { messages: [{ role: 'user', content: 'Read.', timestamp: 0 }] }, { signal });
        const events = [];
        for await (const event of stream) events.push(event);
        expect(signal.aborted).toBe(false);
        expect(events).toMatchObject([{ type: 'error', error: { stopReason: 'error', errorMessage: code } }]);
        expect((await stream.result()).errorMessage).toBe(code);
        expect(fetch).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
    });
  }
});

describe('provider dispatch intent and numeric usage boundary', () => {
  const stop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const usageFrame = (usage: unknown) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
  const transport = (callbacks: Pick<CloudToolTransport, 'onSend' | 'onUsage'> = {}): CloudToolTransport => ({
    offeredToolNames: names, admitToolCall() {}, ...callbacks,
  });
  it('refuses a pre-aborted request before the mark and fetch', async () => {
    const abort = new AbortController(); abort.abort();
    const onSend = vi.fn(); const fetchImpl = vi.fn(async () => response(stop));
    const fetch = createProviderFetch(profile, KEY, fetchImpl, transport({ onSend }));
    await expect(fetch(endpoint, { method: 'POST', body: '{}', signal: abort.signal })).rejects.toMatchObject({ code: 'CLOUD_MODEL_REQUEST_FAILED' });
    expect(onSend).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('marks once before immediate dispatch of the final authenticated Request', async () => {
    const order: string[] = [];
    const onSend = vi.fn(() => { order.push('send'); queueMicrotask(() => order.push('microtask')); });
    const fetch = createProviderFetch(profile, KEY, async input => {
      order.push('fetch');
      expect(input).toBeInstanceOf(Request);
      const request = input as Request;
      expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(request.redirect).toBe('manual');
      expect(await request.text()).toBe('{"body":"exact"}');
      return response(stop);
    }, transport({ onSend }));
    await (await fetch(endpoint, { method: 'POST', body: '{"body":"exact"}' })).text();
    expect(onSend).toHaveBeenCalledOnce(); expect(order).toEqual(['send', 'fetch', 'microtask']);
  });
  it('prevents dispatch when its mark throws and returns a fixed SDK error', async () => {
    const fetchImpl = vi.fn(async () => response(stop));
    const onSend = vi.fn(() => { throw new Error('private-write-error'); });
    const fetch = createProviderFetch(profile, KEY, fetchImpl, transport({ onSend }));
    await expect(fetch(endpoint, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'CLOUD_MODEL_REQUEST_FAILED' });
    expect(onSend).toHaveBeenCalledOnce(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps per-field monotone totals across repeats, increases and malformed frames', async () => {
    const onUsage = vi.fn();
    const wire = usageFrame({ prompt_tokens: 100, completion_tokens: 10 }) + usageFrame({ prompt_tokens: 100 })
      + usageFrame({ completion_tokens: 13 }) + usageFrame({ prompt_tokens: 120 })
      + usageFrame({ prompt_tokens: 'bad', completion_tokens: -1 }) + usageFrame({}) + usageFrame(null) + stop;
    const fetch = createProviderFetch(profile, KEY, async () => response(wire), transport({ onUsage }));
    const text = await (await fetch(endpoint, { method: 'POST', body: '{}' })).text();
    expect(onUsage.mock.calls).toEqual([
      [{ prompt_tokens: 100, completion_tokens: 10 }], [{ prompt_tokens: 100, completion_tokens: 10 }],
      [{ prompt_tokens: 100, completion_tokens: 13 }], [{ prompt_tokens: 120, completion_tokens: 13 }],
    ]);
    expect(text).toContain('"prompt_tokens":120,"completion_tokens":13');
  });
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) it(`rejects ${field} decreases before reporting any part of the frame`, async () => {
    const onUsage = vi.fn();
    const fetch = createProviderFetch(profile, KEY, async () => response(usageFrame({ [field]: 100 })
      + usageFrame({ [field]: 90, ...(field !== 'completion_tokens' ? { completion_tokens: 999 } : { prompt_tokens: 999 }) }) + stop), transport({ onUsage }));
    await expect((await fetch(endpoint, { method: 'POST', body: '{}' })).text()).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(onUsage.mock.calls).toEqual([[{ [field]: 100 }]]);
  });
  const rejections = [
    { reason: 'text type', wire: `data: ${JSON.stringify({ usage: { prompt_tokens: 42 }, choices: [{ index: 0, delta: { content: 123 }, finish_reason: null }] })}\n\n` },
    { reason: 'text leak', wire: `data: ${JSON.stringify({ usage: { prompt_tokens: 42 }, choices: [{ index: 0, delta: { content: KEY }, finish_reason: null }] })}\n\n` },
    { reason: 'tool rejection', wire: usageFrame({ prompt_tokens: 42 }) + frame([call(0, 'unknown')]) + ending },
    { reason: 'interrupted stream', wire: usageFrame({ prompt_tokens: 42 }) },
  ];
  for (const { reason, wire } of rejections) it(`reports checked usage before ${reason}`, async () => {
    const onUsage = vi.fn();
    const fetch = createProviderFetch(profile, KEY, async () => response(wire), transport({ onUsage }));
    await expect((await fetch(endpoint, { method: 'POST', body: '{}' })).text()).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(onUsage.mock.calls).toEqual([[{ prompt_tokens: 42 }]]);
  });
  it('reports no invented usage when the provider omits it', async () => {
    const onUsage = vi.fn(); const fetch = createProviderFetch(profile, KEY, async () => response(stop), transport({ onUsage }));
    await (await fetch(endpoint, { method: 'POST', body: '{}' })).text(); expect(onUsage).not.toHaveBeenCalled();
  });
  it('fails before stream success when the usage write throws', async () => {
    const onUsage = vi.fn(() => { throw new Error('private-write-error'); });
    const fetch = createProviderFetch(profile, KEY, async () => response(usageFrame({ prompt_tokens: 11 }) + stop), transport({ onUsage }));
    await expect((await fetch(endpoint, { method: 'POST', body: '{}' })).text()).rejects.toMatchObject({ code: 'CLOUD_MODEL_REQUEST_FAILED' });
    expect(onUsage).toHaveBeenCalledOnce();
  });
  it('gates the exact final UTF-8 body and binds the returned account', async () => {
    let inputBytes = 0; const order: string[] = []; const usage = vi.fn(); const sent = vi.fn(() => order.push('sent'));
    const { models: registry, model } = models({ beforeRequest(info) { inputBytes = info.inputBytes; order.push('gate'); return { sent, usage }; }, admitToolCall() {} });
    let body = '';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      order.push('fetch'); body = await (input as Request).text(); return response(usageFrame({ prompt_tokens: 17, completion_tokens: 4 }) + stop);
    });
    try {
      const stream = registry.stream(model, { messages: [
        { role: 'system', content: 'Read 数据.', toolsAdded: [tool(names[0]!)], timestamp: 0 },
        { role: 'user', content: 'Read 中文.', timestamp: 1 },
      ] });
      const events = []; for await (const event of stream) events.push(event);
      expect((await stream.result()).stopReason).toBe('stop');
      expect(inputBytes).toBe(new TextEncoder().encode(body).byteLength); expect(inputBytes).toBeGreaterThan(body.length);
      expect(JSON.parse(body).max_tokens).toBe(4096);
      expect(JSON.parse(body).tools).toEqual([{ type: 'function', function: tool(names[0]!) }]);
      expect(order).toEqual(['gate', 'sent', 'fetch']); expect(sent).toHaveBeenCalledOnce();
      expect(usage.mock.calls).toEqual([[{ input: 17, output: 4 }]]); expect(events.at(-1)?.type).toBe('done');
    } finally { fetch.mockRestore(); }
  });
  it('rejects an invalid body before the paid gate', async () => {
    const beforeRequest = vi.fn(); const { models: registry, model } = models({ beforeRequest, admitToolCall() {} });
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const stream = registry.stream(model, { messages: [{ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], timestamp: 0 }] });
      for await (const _event of stream) { /* Drain the real model boundary. */ }
      expect((await stream.result()).errorMessage).toBe('CLOUD_REQUEST_INVALID');
      expect(beforeRequest).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
