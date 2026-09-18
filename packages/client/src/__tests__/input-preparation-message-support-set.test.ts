import { describe, expect, it } from 'vitest';
import { InputPreparationContextDocumentSchema } from '@byok-sdk/protocol';
import type { HostCanonicalAssistantMessage } from '@earendil-works/pi-coding-agent/input-preparation';
import { parseInputPreparationRequestParams } from '../daemon/control-protocol';
import { projectPreparedInputMessage } from '../adapters/pi/input-preparation';
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
 * native shape in `adapters/pi/input-preparation.ts`. So all three are pinned
 * here, on the same matrix, and none of it needs an installed fork: the
 * projection is driven directly and the native shape is asserted against the
 * pinned type.
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
      prompt: {
        cwd: '/workspace/project',
        toolSnippets: {},
        promptGuidelines: [],
        contextFiles: [],
        formattedSkills: '',
        docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
      },
      messages,
    },
    permissionMode: 'auto',
    requiredToolsets: ['team'],
  };
}

function contextDocument(messages: readonly unknown[]): unknown {
  return {
    prompt: {
      cwd: '/workspace/project',
      toolSnippets: {},
      promptGuidelines: [],
      contextFiles: [],
      formattedSkills: '',
      docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
    },
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

describe('input-preparation support set: the native projection', () => {
  it('projects user text onto the native user message, unchanged', () => {
    expect(projectPreparedInputMessage(USER)).toEqual({
      role: 'user',
      content: 'summarise the repository',
      timestamp: 1_700_000_000_000,
    });
  });

  it('projects host-canonical text onto the exact native HostCanonicalAssistantMessage', () => {
    const projected = projectPreparedInputMessage(HOST_CANONICAL);

    // The exact native shape, key for key. `content` is a text-block array so
    // it serializes through the ordinary assistant path byte-identically to a
    // provenance-carrying assistant text message.
    expect(projected).toEqual({
      role: 'assistant',
      origin: 'host_canonical',
      content: [{ type: 'text', text: 'I read the README first.' }],
      timestamp: 1_700_000_000_001,
    });

    // Nothing is fabricated to fill the provenance-carrying assistant shape:
    // the host asserts the text was already said, and no provider generated it
    // here, so there is no honest value for any of these.
    for (const forbidden of ['api', 'provider', 'model', 'usage', 'stopReason']) {
      expect(Object.keys(projected)).not.toContain(forbidden);
    }
  });

  it('is assignable to the pinned native type, at the type level', () => {
    // A type-level assertion, not a runtime one: a fork that changes the
    // host-canonical shape has to break the BUILD, not a comparison against
    // this test's own idea of the shape.
    const local: InputPreparationHostCanonicalAssistantMessageV1 = HOST_CANONICAL;
    const native: HostCanonicalAssistantMessage = {
      role: 'assistant',
      origin: 'host_canonical',
      content: [{ type: 'text', text: local.content }],
      timestamp: local.timestamp,
    };
    expect(projectPreparedInputMessage(local)).toEqual(native);
  });

  it('is exhaustive over the whole support set', () => {
    // Every member, driven through the projection. The `default: never` branch
    // in the projection is what makes a NEW member a compile error; this is the
    // runtime half — no supported member falls through.
    const every: readonly InputPreparationMessageV1[] = [USER, HOST_CANONICAL];
    for (const message of every) {
      expect(projectPreparedInputMessage(message)).toBeDefined();
    }
  });
});
