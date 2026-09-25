/**
 * Official Pi 0.87.1 conformance — A1' compile parity (a) and A2' wire
 * neutrality (b). Synthetic SSE only; zero network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { admitHostAssistantContent } from '../host-history-admission';
import {
  byteLength,
  compileA1,
  createOfficialSession,
  hostAssistant,
  hostTranscript,
  installGlobalFetchSpy,
  OBSERVE_TOOL_NAME,
  OBSERVE_TOOL_RESULT_TEXT,
  SAME_MODEL_PROVENANCE,
  SENTINEL_PROVENANCE,
  sha256,
  SINK_BASE_URL,
  textResponse,
  toolCallResponse,
  TRIGGER_TEXT,
  type GlobalFetchSpy,
} from './official-pi-fixture';

const TIMEOUT_MS = 30_000;

let globalFetch: GlobalFetchSpy;
beforeEach(() => {
  globalFetch = installGlobalFetchSpy();
});
afterEach(() => {
  globalFetch.restore();
});

describe('official Pi 0.87.1: A1\' compile parity', () => {
  test('(a) A1\' sink compile equals the live registerProvider-gated body, first and tool-result request', async () => {
    const first = await compileA1(hostTranscript());
    const again = await compileA1(hostTranscript());
    expect(first.fetchCalls).toBe(1);
    expect(again.fetchCalls).toBe(1);
    expect(first.url).toBe(`${SINK_BASE_URL}/chat/completions`);
    expect(first.terminal?.type).toBe('error');
    const d1 = first.body;
    if (d1 === undefined) throw new Error('A1\' compile captured no body');
    expect(again.body).toBe(d1);

    const harness = await createOfficialSession({
      transcript: () => hostTranscript(),
      gate: (sequence, body) => {
        if (sequence === 1) {
          return body === d1
            ? toolCallResponse()
            : { refuse: { code: 'prepared_request_bytes_mismatch', sequence, expectedSha256: sha256(d1), observedSha256: sha256(body), observedBytes: byteLength(body) } };
        }
        return textResponse('done', true);
      },
    });
    try {
      await harness.session.prompt(TRIGGER_TEXT);

      expect(harness.contextAnomalies).toEqual([]);
      expect(harness.run.refusal).toBeUndefined();
      expect(harness.gateBodies).toHaveLength(2);
      expect(harness.gateBodies[0]).toBe(d1);
      expect(harness.toolExecutions).toBe(1);

      // The second request's tail comes from the session's own `message_end`
      // emissions: the assistant tool call it streamed and the tool result it
      // produced, in order.
      const toolTurn = harness.messageEnds.filter((message) => message.role === 'assistant' || message.role === 'toolResult');
      const assistantToolCall = toolTurn[0] as AssistantMessage | undefined;
      const toolResult = toolTurn[1];
      expect(assistantToolCall?.role).toBe('assistant');
      expect(assistantToolCall?.content.some((block) => block.type === 'toolCall' && block.name === OBSERVE_TOOL_NAME)).toBe(true);
      expect(toolResult?.role).toBe('toolResult');
      expect(JSON.stringify(toolResult)).toContain(OBSERVE_TOOL_RESULT_TEXT);
      // The context handler saw the same tail the session emitted.
      expect(harness.contextTails[1]).toEqual([assistantToolCall, toolResult]);

      const second = await compileA1([...hostTranscript(), assistantToolCall, toolResult] as Message[]);
      expect(second.fetchCalls).toBe(1);
      expect(harness.gateBodies[1]).toBe(second.body);
      expect(second.body).not.toBe(d1);

      console.info('[conformance a] D1', byteLength(d1), sha256(d1), 'D2', byteLength(second.body!), sha256(second.body!));
      // What the session hands the provider: no cacheRetention (so the gate
      // wrapper pins it, see (e)), provider retries 0 from settings, no maxTokens.
      for (const providerOptions of harness.providerOptions) {
        expect(providerOptions.cacheRetention).toBeUndefined();
        expect(providerOptions.maxRetries).toBe(0);
        expect(providerOptions.maxTokens).toBeUndefined();
        expect(providerOptions.reasoning).toBe('medium');
      }
      expect(globalFetch.calls).toEqual([]);
    } finally {
      harness.dispose();
    }
  }, TIMEOUT_MS);
});

describe('official Pi 0.87.1: A2\' sentinel provenance', () => {
  test('(b) sentinel and same-model provenance compile to identical bytes; admission refuses thinking', async () => {
    const sentinel = await compileA1(hostTranscript(SENTINEL_PROVENANCE));
    const sameModel = await compileA1(hostTranscript(SAME_MODEL_PROVENANCE));
    expect(sentinel.fetchCalls).toBe(1);
    expect(sameModel.fetchCalls).toBe(1);
    expect(sentinel.body).toBeDefined();
    expect(sentinel.body).toBe(sameModel.body);
    // The sentinel never reaches the wire.
    for (const value of Object.values(SENTINEL_PROVENANCE)) expect(sentinel.body).not.toContain(value);
    console.info('[conformance b] D', byteLength(sentinel.body!), sha256(sentinel.body!));

    const textOnly = hostTranscript()[2] as AssistantMessage;
    expect(admitHostAssistantContent(textOnly.content)).toEqual({ admitted: true, texts: ['earlier Host-canonical assistant text'] });

    const withThinking = hostAssistant(
      [{ type: 'thinking', thinking: 'private chain' }, { type: 'text', text: 'answer' }],
      SENTINEL_PROVENANCE,
      1,
    );
    expect(admitHostAssistantContent(withThinking.content)).toEqual({
      admitted: false,
      refusal: { code: 'host_assistant_block_not_text', blockIndex: 0, blockType: 'thinking' },
    });
    const withToolCall = hostAssistant(
      [{ type: 'text', text: 'calling' }, { type: 'toolCall', id: 'c1', name: OBSERVE_TOOL_NAME, arguments: { note: 'x' } }],
      SENTINEL_PROVENANCE,
      1,
    );
    expect(admitHostAssistantContent(withToolCall.content)).toEqual({
      admitted: false,
      refusal: { code: 'host_assistant_block_not_text', blockIndex: 1, blockType: 'toolCall' },
    });
    expect(admitHostAssistantContent([{ type: 'text', text: 'x', textSignature: 'sig' }])).toEqual({
      admitted: false,
      refusal: { code: 'host_assistant_text_block_malformed', blockIndex: 0, blockType: 'text' },
    });
    expect(admitHostAssistantContent([])).toEqual({ admitted: false, refusal: { code: 'host_assistant_content_empty' } });
    expect(globalFetch.calls).toEqual([]);
  });
});
