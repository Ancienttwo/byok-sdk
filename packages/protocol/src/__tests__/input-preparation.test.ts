import { describe, expect, it } from 'vitest';
import {
  AGENT_INPUT_PREPARATION_CAPABILITY,
  INPUT_PREPARATION_WIRE_VERSION,
  AgentInputPreparationPayloadSchema,
  BYOK_INPUT_PREPARATION_COMPLETION_ROUTE,
  BYOK_INPUT_PREPARATION_STATUS_ROUTE,
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  InputPreparationCompletionRequestSchema,
  InputPreparationContextDocumentSchema,
  InputPreparationModelSchema,
  InputPreparationReadbackSchema,
  InputPreparationReceiptSummarySchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SERVER_TO_DAEMON_TYPES,
  TaskCompletePayloadSchema,
  TaskFailPayloadSchema,
  TerminalPreparedObservationSchema,
  UnknownMessageTypeError,
  byokInputPreparationCompletionPath,
  byokInputPreparationStatusPath,
  createEnvelope,
  encodeEnvelope,
  parseMessage,
  type MessageType,
} from '../index';

const SOURCE = { revision: 'source-r42', digest: `sha256:${'c'.repeat(64)}` } as const;

const SELECTION = {
  model: {
    id: 'model-1',
    name: 'Model One',
    api: 'openai-completions',
    provider: 'provider-1',
    baseUrl: 'https://provider.example/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  options: { cacheRetention: 'none', maxTokens: 1024 },
} as const;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: '10000000-0000-4000-8000-000000000001',
    agentRef: { agentId: 'agent-1', profileRevision: '7' },
    profileId: 'profile-1',
    policyRevision: 'limits-r1',
    source: SOURCE,
    selection: SELECTION,
    deadlineAt: '2026-01-01T00:01:00.000Z',
    context: { inline: '{"prompt":{},"messages":[]}' },
    requiredToolsets: ['team'],
    permissionMode: 'auto',
    ...overrides,
  };
}

const BINDING = {
  scopeId: 'scope-1',
  deviceId: 'device-1',
  agentRef: 'agent-1',
  profileId: 'profile-1',
  profileRevision: '7',
  source: SOURCE,
  target: { endpoint: 'https://provider.example/v1', modelId: 'model-1' },
  policyRevision: 'limits-r1',
  permissionMode: 'auto',
  runtime: {
    packageName: '@byok-sdk/pi-coding-agent',
    packageVersion: '0.85.1001',
    tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
    upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
    provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
    envelopeFormat: 'pi.prepared-session-input.v1',
    requestFormat: 'openai-completions.v1',
    compilerVersion: 1,
  },
  requestDigest: 'sha256:req',
} as const;

const RECEIPT = {
  reference: 'prep-ref-1',
  state: 'prepared',
  binding: BINDING,
  artifact: {
    requestDigest: 'sha256:req',
    envelopeDigest: 'sha256:env',
    toolManifestDigest: 'sha256:tools',
    requestBytes: 1024,
    projectionBytes: 900,
    projection: { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) },
    residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
    observationDigest: 'sha256:observation',
    toolBindingDigest: 'sha256:binding',
    toolImplementationKinds: { mcp__team__list: 'unavailable:resolver_unconfigured' },
  },
  ready: false,
  readinessReasons: ['accounting_policy_missing', 'executor_identity_unproven'],
  artifactExpiresAt: '2026-01-01T01:00:00.000Z',
} as const;

describe('agent.input.preparation envelope', () => {
  it('is a server -> daemon type that FORBIDS task_id and REQUIRES seq', () => {
    expect(SERVER_TO_DAEMON_TYPES as readonly MessageType[]).toContain('agent.input.preparation');

    const envelope = createEnvelope('agent.input.preparation', payload() as never, { seq: 4 });
    expect(envelope.task_id).toBeUndefined();
    expect(envelope.seq).toBe(4);

    // task_id is `z.never().optional()` for this branch: an envelope that
    // carries one does not merely lose the field, it fails to parse — routing a
    // task-free control message by a task id is a contract violation, not a
    // stray extra.
    expect(EnvelopeSchema.safeParse({ ...envelope, task_id: 'task-1' }).success).toBe(false);

    // seq is the redelivery cursor for every server -> daemon type.
    const { seq: _seq, ...withoutSeq } = envelope;
    expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);
  });

  it('an UNKNOWN envelope type raises UnknownMessageTypeError instead of matching a known branch', () => {
    // This asserts `parseMessage`'s structure, not an older build's behaviour:
    // a type string this build has no branch for answers
    // `UnknownMessageTypeError` — the distinctly skippable signal the long-poll
    // transport freezes its cursor on — rather than matching some other branch
    // with the payload silently stripped away. The argument that an old daemon
    // therefore skips `agent.input.preparation` follows from that structure,
    // because to such a build this type is exactly as unknown as the mutated
    // one below; no daemon predating the contract is executed here.
    const unknownPeerView = {
      ...JSON.parse(encodeEnvelope(createEnvelope('agent.input.preparation', payload() as never, { seq: 4 }))),
      type: 'agent.input.preparation.v2',
    };
    expect(() => parseMessage(unknownPeerView)).toThrow(UnknownMessageTypeError);

    // And the reverse: this type's payload is `.strict()`, so a NEWER sender's
    // extra control field is rejected, never stripped and then acted on.
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ futureControlField: true })).success).toBe(false);
  });

  it('carries no tools, tool executors, runtime identity, tenant or device', () => {
    const shape = Object.keys(AgentInputPreparationPayloadSchema.shape).sort();
    expect(shape).toEqual([
      // Host accounting authority, carried verbatim. It rules on residual KEYS
      // by name; it states no tool, no executor and no runtime identity, all of
      // which stay local observations the device alone can make.
      'accountingPolicyRef',
      'agentRef',
      'context',
      'deadlineAt',
      'permissionMode',
      'policyRevision',
      'profileId',
      'requestId',
      'requiredToolsets',
      'selection',
      'source',
    ]);
  });

  it('bounds inline context at 64 KiB and offers a blob ref above it', () => {
    const justUnder = 'a'.repeat(64 * 1024);
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ context: { inline: justUnder } })).success).toBe(true);
    expect(
      AgentInputPreparationPayloadSchema.safeParse(payload({ context: { inline: `${justUnder}a` } })).success,
    ).toBe(false);

    const blobRef = {
      blobId: 'blob-1',
      contentHash: `sha256:${'d'.repeat(64)}`,
      size: 200000,
      contentType: 'application/json',
    };
    expect(
      AgentInputPreparationPayloadSchema.safeParse(
        payload({ context: { blobRef, contentHash: blobRef.contentHash } }),
      ).success,
    ).toBe(true);
    expect(
      AgentInputPreparationPayloadSchema.safeParse(
        payload({ context: { blobRef, contentHash: `sha256:${'e'.repeat(64)}` } }),
      ).success,
    ).toBe(false);
  });

  it('rejects an unsupported model API instead of inferring one', () => {
    const selection = { ...SELECTION, model: { ...SELECTION.model, api: 'anthropic-messages' } };
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ selection })).success).toBe(false);
  });

  it('requires at least one toolset and rejects duplicates', () => {
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ requiredToolsets: [] })).success).toBe(true);
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ requiredToolsets: ['team', 'team'] })).success).toBe(false);
  });

  it('registers the payload schema under the message registry', () => {
    expect(MESSAGE_PAYLOAD_SCHEMAS['agent.input.preparation']).toBe(AgentInputPreparationPayloadSchema);
  });
});

describe('input preparation model: the launched model declarations', () => {
  const THINKING_LEVEL_MAP = {
    off: null,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  } as const;

  const COMPAT = {
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'zai',
    zaiToolStream: true,
  } as const;

  function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...SELECTION.model, ...overrides };
  }

  it('accepts a model that declares both thinkingLevelMap and compat, verbatim', () => {
    const value = model({ thinkingLevelMap: THINKING_LEVEL_MAP, compat: COMPAT });
    const parsed = InputPreparationModelSchema.parse(value);
    expect(parsed).toEqual(value);
    // Verbatim, not merely equal-ish: the whole point of carrying these is that
    // the prepared model can still EQUAL the session model composed from the
    // same declarations.
    expect(parsed.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
    expect(parsed.compat).toEqual(COMPAT);
  });

  it('accepts a model that declares neither, and leaves both keys ABSENT', () => {
    const parsed = InputPreparationModelSchema.parse(model());
    // Absent stays absent. A default here would be a second authority inventing
    // a body-affecting declaration the configuration never made.
    expect(Object.hasOwn(parsed, 'thinkingLevelMap')).toBe(false);
    expect(Object.hasOwn(parsed, 'compat')).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual([
      'api', 'baseUrl', 'contextWindow', 'cost', 'id', 'input', 'maxTokens', 'name', 'provider', 'reasoning',
    ]);
  });

  it('accepts either declaration alone', () => {
    expect(InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: THINKING_LEVEL_MAP })).success).toBe(true);
    expect(InputPreparationModelSchema.safeParse(model({ compat: COMPAT })).success).toBe(true);
    // An empty compat is a declaration with no flags, which is a real state a
    // configuration can be in; it is not the same as declaring no compat.
    expect(InputPreparationModelSchema.safeParse(model({ compat: {} })).success).toBe(true);
  });

  it('refuses an unknown compat key instead of stripping it', () => {
    expect(
      InputPreparationModelSchema.safeParse(model({ compat: { ...COMPAT, supportsStrictMode: true } })).success,
    ).toBe(false);
  });

  it('refuses a maxTokensField outside the two the declaration admits', () => {
    expect(
      InputPreparationModelSchema.safeParse(model({ compat: { ...COMPAT, maxTokensField: 'max_output_tokens' } })).success,
    ).toBe(false);
  });

  it('refuses a thinkingFormat outside the declared set', () => {
    expect(
      InputPreparationModelSchema.safeParse(model({ compat: { ...COMPAT, thinkingFormat: 'anthropic' } })).success,
    ).toBe(false);
  });

  it('refuses a thinking level outside the seven, and a map missing one of them', () => {
    expect(
      InputPreparationModelSchema.safeParse(
        model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, ultra: 'high' } }),
      ).success,
    ).toBe(false);
    const { max: _max, ...missingMax } = THINKING_LEVEL_MAP;
    expect(InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: missingMax })).success).toBe(false);
  });

  it('refuses a level value that is neither a string nor null', () => {
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: 3 } })).success,
    ).toBe(false);
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: undefined } })).success,
    ).toBe(false);
  });

  it('bounds an effort token at 64 characters and to the portable character set', () => {
    const justUnder = 'a'.repeat(64);
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: justUnder } })).success,
    ).toBe(true);
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: `${justUnder}a` } })).success,
    ).toBe(false);
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: '' } })).success,
    ).toBe(false);
    expect(
      InputPreparationModelSchema.safeParse(model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: 'very high' } })).success,
    ).toBe(false);
  });

  it('carries both declarations through the whole request payload', () => {
    const selection = { ...SELECTION, model: model({ thinkingLevelMap: THINKING_LEVEL_MAP, compat: COMPAT }) };
    const parsed = AgentInputPreparationPayloadSchema.safeParse(payload({ selection }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.selection.model.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
    expect(parsed.success && parsed.data.selection.model.compat).toEqual(COMPAT);
  });
});

describe('input preparation context document', () => {
  it('accepts the Host-authorized prompt and user messages and rejects model-visible tools', () => {
    const document = {
      prompt: { systemPrompt: 'Host fixture instructions' },
      messages: [{ role: 'user', content: 'hi', timestamp: 1767225600000 }],
    };
    expect(InputPreparationContextDocumentSchema.safeParse(document).success).toBe(true);
    // `tools` is a device observation. A Host that could send it could claim a
    // toolset the device does not have.
    expect(InputPreparationContextDocumentSchema.safeParse({ ...document, tools: [] }).success).toBe(false);
    // `selectedTools` is the manifest's own name list by native contract, so a
    // Host stating it would be stating the manifest through the prompt.
    expect(
      InputPreparationContextDocumentSchema.safeParse({
        ...document,
        prompt: { ...document.prompt, selectedTools: ['read'] },
      }).success,
    ).toBe(false);
    // An assistant message with no `origin` discriminant claims provenance
    // nobody here can check, so it rejects rather than being narrowed to the
    // host-canonical kind.
    expect(
      InputPreparationContextDocumentSchema.safeParse({
        ...document,
        messages: [{ role: 'assistant', content: 'hi', timestamp: 1 }],
      }).success,
    ).toBe(false);
  });

  it('accepts host-canonical assistant text beside user history, and nothing that claims provenance', () => {
    const document = {
      prompt: { systemPrompt: 'Host fixture instructions' },
      messages: [
        { role: 'user', content: 'hi', timestamp: 1767225600000 },
        { role: 'assistant', origin: 'host_canonical', content: 'hello', timestamp: 1767225600001 },
        { role: 'user', content: 'go on', timestamp: 1767225600002 },
      ],
    };
    const parsed = InputPreparationContextDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.messages : undefined).toEqual(document.messages);

    const host = document.messages[1]!;
    for (const forged of [
      // The host asserts the text was already said; it cannot assert that a
      // provider produced it, nor how many tokens that provider reported.
      { ...host, usage: { input: 1, output: 2 } },
      { ...host, model: 'glm-4.6' },
      { ...host, provider: 'zai' },
      { ...host, stopReason: 'stop' },
      // `origin` is the discriminant, and only one value is a fact this
      // surface can carry.
      { ...host, origin: 'provider' },
      // The native text-block array is the COMPILER's shape, never the wire's.
      { ...host, content: [{ type: 'text', text: 'hello' }] },
    ]) {
      expect(
        InputPreparationContextDocumentSchema.safeParse({ ...document, messages: [forged] }).success,
      ).toBe(false);
    }
  });
});

describe('input preparation completion and readback', () => {
  it('ties ready to an empty readinessReasons list', () => {
    expect(InputPreparationReceiptSummarySchema.safeParse(RECEIPT).success).toBe(true);
    expect(InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, ready: true }).success).toBe(false);
    expect(
      InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, ready: true, readinessReasons: [] }).success,
    ).toBe(true);
  });

  it('never discloses D, P(D) or the snapshot', () => {
    expect(
      InputPreparationReceiptSummarySchema.safeParse({
        ...RECEIPT,
        request: '{"model":"model-1"}',
      }).success,
    ).toBe(false);
  });

  it('makes "prepared without a receipt" and "rejected with one" unrepresentable', () => {
    const base = {
      requestId: '10000000-0000-4000-8000-000000000001',
      agentRef: { agentId: 'agent-1', profileRevision: '7' },
      profileId: 'profile-1',
      policyRevision: 'limits-r1',
    };
    expect(
      InputPreparationCompletionRequestSchema.safeParse({ ...base, outcome: 'prepared', receipt: RECEIPT }).success,
    ).toBe(true);
    expect(InputPreparationCompletionRequestSchema.safeParse({ ...base, outcome: 'prepared' }).success).toBe(false);
    expect(
      InputPreparationCompletionRequestSchema.safeParse({
        ...base,
        outcome: 'rejected',
        reason: 'input_preparation_unconfigured',
      }).success,
    ).toBe(true);
    expect(
      InputPreparationCompletionRequestSchema.safeParse({
        ...base,
        outcome: 'rejected',
        reason: 'scope_denied',
        receipt: RECEIPT,
      }).success,
    ).toBe(false);
  });

  it('keeps pending free of terminal evidence and every terminal status bound to its own', () => {
    const base = {
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      requestId: '10000000-0000-4000-8000-000000000001',
      agentRef: { agentId: 'agent-1', profileRevision: '7' },
      profileId: 'profile-1',
      policyRevision: 'limits-r1',
    };
    expect(InputPreparationReadbackSchema.safeParse({ ...base, status: 'pending' }).success).toBe(true);
    expect(
      InputPreparationReadbackSchema.safeParse({ ...base, status: 'pending', receipt: RECEIPT }).success,
    ).toBe(false);
    expect(
      InputPreparationReadbackSchema.safeParse({
        ...base,
        status: 'prepared',
        receipt: RECEIPT,
        completedAt: '2026-01-01T00:00:30.000Z',
      }).success,
    ).toBe(true);
    expect(
      InputPreparationReadbackSchema.safeParse({
        ...base,
        status: 'prepared',
        completedAt: '2026-01-01T00:00:30.000Z',
      }).success,
    ).toBe(false);
    expect(
      InputPreparationReadbackSchema.safeParse({
        ...base,
        status: 'rejected',
        reason: 'scope_denied',
        completedAt: '2026-01-01T00:00:30.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('bounded admission wire cut', () => {
  const COUNTER = {
    method: 'provider.tokenizer',
    methodVersion: '1',
    authority: 'provider',
    value: 812,
    coverage: { covered: true },
    providerEvidence: {
      projectionDigest: 'a'.repeat(64),
      endpoint: 'https://provider.example/v1',
      modelId: 'model-1',
      asserted: { httpStatus: 200, usageFields: { prompt_tokens: 812 }, responseDigest: 'e'.repeat(64) },
    },
    target: { endpoint: 'https://provider.example/v1', modelId: 'model-1' },
    calledAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  } as const;

  it('accepts a ready receipt with no counter at all', () => {
    expect(
      InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, ready: true, readinessReasons: [] }).success,
    ).toBe(true);
  });

  it('refuses the retired state, readiness names and counter kind rather than reading them forward', () => {
    expect(InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, state: 'counted' }).success).toBe(false);
    for (const retired of ['not_counted', 'counter_missing']) {
      expect(
        InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, readinessReasons: [retired] }).success,
      ).toBe(false);
    }
    expect(InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, counter: COUNTER }).success).toBe(true);
    for (const kind of ['count', 'bound']) {
      expect(
        InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, counter: { ...COUNTER, kind } }).success,
      ).toBe(false);
    }
  });

  it('names a non-text D and a not-yet-prepared record', () => {
    for (const reason of ['request_content_not_text', 'not_prepared']) {
      expect(
        InputPreparationReceiptSummarySchema.safeParse({ ...RECEIPT, readinessReasons: [reason] }).success,
      ).toBe(true);
    }
  });
});

describe('terminal prepared observation', () => {
  const OBSERVATION = { requestDigest: 'a'.repeat(64), initialPromptTokens: 812, maxPromptTokens: 2_048 };

  it('rides on task.complete and task.fail, strictly', () => {
    expect(TerminalPreparedObservationSchema.safeParse(OBSERVATION).success).toBe(true);
    expect(
      TaskCompletePayloadSchema.safeParse({ summary: 's', sessionRef: 'r', preparedObservation: OBSERVATION }).success,
    ).toBe(true);
    expect(TaskFailPayloadSchema.safeParse({ reason: 'context_overflow: x', preparedObservation: OBSERVATION }).success)
      .toBe(true);
    expect(TerminalPreparedObservationSchema.safeParse({ ...OBSERVATION, extra: 1 }).success).toBe(false);
  });

  it('refuses a max below the initial call and a missing or non-integer token count', () => {
    expect(TerminalPreparedObservationSchema.safeParse({ ...OBSERVATION, maxPromptTokens: 811 }).success).toBe(false);
    const { initialPromptTokens: _initial, ...withoutInitial } = OBSERVATION;
    expect(TerminalPreparedObservationSchema.safeParse(withoutInitial).success).toBe(false);
    expect(TerminalPreparedObservationSchema.safeParse({ ...OBSERVATION, initialPromptTokens: 1.5 }).success).toBe(false);
    expect(TerminalPreparedObservationSchema.safeParse({ ...OBSERVATION, requestDigest: '' }).success).toBe(false);
  });
});

describe('input preparation capability and routes', () => {
  it('declares one capability flag and two device routes', () => {
    expect(CAPABILITY_FLAGS as readonly string[]).toContain(AGENT_INPUT_PREPARATION_CAPABILITY);
    // The contract version is IN the token, because the relay wire carries no
    // version field: a device and a cloud on different versions never admit
    // each other's preparations. The retired unversioned token is gone.
    expect(AGENT_INPUT_PREPARATION_CAPABILITY).toBe(`agent-input-preparation-v${INPUT_PREPARATION_WIRE_VERSION}`);
    expect(AGENT_INPUT_PREPARATION_CAPABILITY).toBe('agent-input-preparation-v7');
    expect(CAPABILITY_FLAGS as readonly string[]).not.toContain('agent-input-preparation');
    expect(BYOK_INPUT_PREPARATION_COMPLETION_ROUTE).toBe('/byok/input-preparations/:requestId/completion');
    expect(BYOK_INPUT_PREPARATION_STATUS_ROUTE).toBe('/byok/input-preparations/:requestId');
  });

  it('builds each path with the request id URL-encoded, exactly as the router template names it', () => {
    expect(byokInputPreparationCompletionPath('a/b')).toBe('/byok/input-preparations/a%2Fb/completion');
    expect(byokInputPreparationStatusPath('a/b')).toBe('/byok/input-preparations/a%2Fb');
  });
});
