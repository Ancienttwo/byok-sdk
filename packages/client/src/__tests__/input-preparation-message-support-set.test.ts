import { describe, expect, it } from 'vitest';
import { InputPreparationContextDocumentSchema } from '@byok-sdk/protocol';
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai';
import { parseInputPreparationRequestParams } from '../daemon/control-protocol';
import {
  buildPreparedTranscriptMessages,
  PREPARED_HOST_ASSISTANT_PROVENANCE,
  PreparedRequestError,
} from '../adapters/pi/prepared-request';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationHostCanonicalAssistantMessageV1,
  type InputPreparationMessageV1,
} from '../input-preparation';

/**
 * The input-preparation MESSAGE support set: text-only user history,
 * host-canonical assistant text history, and the current user message.
 *
 * Three validators speak this shape and none of them is the authority over the
 * other two — the hand-written parse in `daemon/control-protocol.ts`, the zod
 * discriminated union in `@byok-sdk/protocol`, and the projection onto the
 * official Pi message shape in `adapters/pi/prepared-request.ts`
 * (`buildPreparedTranscriptMessages`, A2'). So all three are pinned here, and
 * the projection is driven directly and asserted against the pinned official
 * `@earendil-works/pi-ai` types.
 */

const USER = { role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 } as const;
const HOST_CANONICAL = {
  role: 'assistant',
  origin: 'host_canonical',
  content: 'I read the README first.',
  timestamp: 1_700_000_000_001,
} as const;

function params(messages: readonly unknown[]): unknown {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-1',
    policyRevision: 'limits-rev-1',
    scope: { deviceId: 'device-1', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' },
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    selection: {
      model: {
        id: 'glm-4.6',
        name: 'GLM 4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: false,
        input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      options: { cacheRetention: 'none', maxTokens: 4_096 },
    },
    snapshot: {
      prompt: { systemPrompt: 'Host framing' },
      messages,
    },
    permissionMode: 'auto',
    requiredToolsets: ['team'],
  };
}

function contextDocument(messages: readonly unknown[]): unknown {
  return {
    prompt: { systemPrompt: 'Host framing' },
    messages,
  };
}

/** Everything outside the support set, stated once and run through every validator. */
const REFUSED: readonly (readonly [string, unknown])[] = [
  ['an assistant message with no origin discriminant', { role: 'assistant', content: 'hi', timestamp: 1 }],
  ['an assistant message whose origin claims a provider generated it', { ...HOST_CANONICAL, origin: 'provider' }],
  [
    'host-canonical content as a native text-block array rather than text',
    { ...HOST_CANONICAL, content: [{ type: 'text', text: 'hi' }] },
  ],
  ['a fabricated usage field beside host-canonical text', { ...HOST_CANONICAL, usage: { input: 1, output: 2 } }],
  ['a fabricated model field beside host-canonical text', { ...HOST_CANONICAL, model: 'glm-4.6' }],
  ['a toolResult message', { role: 'toolResult', content: 'hi', timestamp: 1 }],
  ['multimodal user content', { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }],
  ['an origin key on a user message', { ...USER, origin: 'host_canonical' }],
];

describe('input-preparation support set: the device parse', () => {
  it('accepts mixed user and host-canonical assistant history', () => {
    const parsed = parseInputPreparationRequestParams(params([USER, HOST_CANONICAL, USER]));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true ? parsed.request.snapshot.messages : undefined).toEqual([
      USER,
      HOST_CANONICAL,
      USER,
    ]);
  });

  it.each(REFUSED)('refuses %s', (_label, message) => {
    const parsed = parseInputPreparationRequestParams(params([USER, message]));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false ? parsed.code : undefined).toBe('bad_request');
  });
});

describe('input-preparation support set: the wire schema', () => {
  it('accepts mixed user and host-canonical assistant history', () => {
    const parsed = InputPreparationContextDocumentSchema.safeParse(contextDocument([USER, HOST_CANONICAL]));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.messages : undefined).toEqual([USER, HOST_CANONICAL]);
  });

  it.each(REFUSED)('refuses %s', (_label, message) => {
    expect(InputPreparationContextDocumentSchema.safeParse(contextDocument([USER, message])).success).toBe(false);
  });
});

function project(messages: readonly InputPreparationMessageV1[]): Message[] {
  // T always leads with the Host system message and ends on a user message;
  // the projected history sits between them.
  return buildPreparedTranscriptMessages({ systemPrompt: 'Host system message', tools: [], messages });
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe('input-preparation support set: the official projection (A2\')', () => {
  it('projects user text onto the official user message, unchanged', () => {
    const [, user] = project([USER]);
    expect(user).toEqual({
      role: 'user',
      content: 'summarise the repository',
      timestamp: 1_700_000_000_000,
    });
  });

  it('projects host-canonical text onto an official AssistantMessage with the request-scoped sentinel provenance', () => {
    const [, , assistant] = project([USER, HOST_CANONICAL, USER]);

    // The exact official shape, key for key. `content` is a text-block array so
    // it serializes through the ordinary assistant path. The provenance is the
    // A2' sentinel, never a real api/provider/model: no provider generated this
    // text, so the sentinel names the Host, and `usage` is zero.
    expect(assistant).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I read the README first.' }],
      api: PREPARED_HOST_ASSISTANT_PROVENANCE.api,
      provider: PREPARED_HOST_ASSISTANT_PROVENANCE.provider,
      model: PREPARED_HOST_ASSISTANT_PROVENANCE.model,
      usage: ZERO_USAGE,
      stopReason: 'stop',
      timestamp: 1_700_000_000_001,
    });
    // The wire discriminant does not leak into the official message.
    expect(Object.keys(assistant as object)).not.toContain('origin');
  });

  it('is assignable to the pinned official types, at the type level', () => {
    // A type-level assertion, not a runtime one: an official release that
    // changes the message shapes has to break the BUILD, not a comparison
    // against this test's own idea of the shape.
    const local: InputPreparationHostCanonicalAssistantMessageV1 = HOST_CANONICAL;
    const user: UserMessage = { role: 'user', content: USER.content, timestamp: USER.timestamp };
    const native: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: local.content }],
      api: PREPARED_HOST_ASSISTANT_PROVENANCE.api,
      provider: PREPARED_HOST_ASSISTANT_PROVENANCE.provider,
      model: PREPARED_HOST_ASSISTANT_PROVENANCE.model,
      usage: ZERO_USAGE,
      stopReason: 'stop',
      timestamp: local.timestamp,
    };
    expect(project([USER, local, USER]).slice(1)).toEqual([user, native, user]);
  });

  it('is exhaustive over the whole support set', () => {
    // Every member, driven through the projection; no supported member falls
    // through to the refusal branch.
    const every: readonly InputPreparationMessageV1[] = [USER, HOST_CANONICAL, USER];
    expect(project(every)).toHaveLength(every.length + 1);
  });

  it.each([
    ['an assistant message with no origin discriminant', { role: 'assistant', content: 'hi', timestamp: 1 }],
    ['an assistant message whose origin claims a provider generated it', { ...HOST_CANONICAL, origin: 'provider' }],
    ['a toolResult message', { role: 'toolResult', content: 'hi', timestamp: 1 }],
    ['multimodal user content', { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }],
  ] as const)('refuses %s', (_label, message) => {
    let caught: unknown;
    try {
      project([USER, message as unknown as InputPreparationMessageV1, USER]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreparedRequestError);
    expect((caught as PreparedRequestError).code).toBe('prepared_transcript_invalid');
  });
});
