import { describe, expect, it } from 'vitest';
import {
  AGENT_INPUT_PREPARATION_CAPABILITY,
  AgentInputPreparationPayloadSchema,
  BYOK_INPUT_PREPARATION_COMPLETION_ROUTE,
  BYOK_INPUT_PREPARATION_STATUS_ROUTE,
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  InputPreparationCompletionRequestSchema,
  InputPreparationContextDocumentSchema,
  InputPreparationReadbackSchema,
  InputPreparationReceiptSummarySchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SERVER_TO_DAEMON_TYPES,
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
  runtime: {
    packageName: '@byok-sdk/pi-coding-agent',
    packageVersion: '0.85.1001',
    upstreamBase: '0.85.1',
    upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
    forkBuild: 1,
    envelopeFormat: 'pi.prepared-session-input.v1',
    requestFormat: 'openai-completions.v1',
    compilerVersion: 1,
  },
  requestDigest: 'sha256:req',
} as const;

const RECEIPT = {
  reference: 'prep-ref-1',
  state: 'counted',
  binding: BINDING,
  artifact: {
    requestDigest: 'sha256:req',
    envelopeDigest: 'sha256:env',
    toolManifestDigest: 'sha256:tools',
    requestBytes: 1024,
    projectionBytes: 900,
    coverage: 'unknown',
  },
  ready: false,
  readinessReasons: ['compiler_coverage_unknown', 'executor_identity_unproven'],
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
      'agentRef',
      'context',
      'deadlineAt',
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
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ requiredToolsets: [] })).success).toBe(false);
    expect(AgentInputPreparationPayloadSchema.safeParse(payload({ requiredToolsets: ['team', 'team'] })).success).toBe(false);
  });

  it('registers the payload schema under the message registry', () => {
    expect(MESSAGE_PAYLOAD_SCHEMAS['agent.input.preparation']).toBe(AgentInputPreparationPayloadSchema);
  });
});

describe('input preparation context document', () => {
  it('accepts the Host-authorized prompt and user messages and rejects model-visible tools', () => {
    const document = {
      prompt: {
        cwd: '/home/agent',
        selectedTools: ['read'],
        toolSnippets: { read: 'reads a file' },
        promptGuidelines: [],
        contextFiles: [],
        formattedSkills: '',
        docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
      },
      messages: [{ role: 'user', content: 'hi', timestamp: 1767225600000 }],
    };
    expect(InputPreparationContextDocumentSchema.safeParse(document).success).toBe(true);
    // `tools` is a device observation. A Host that could send it could claim a
    // toolset the device does not have.
    expect(InputPreparationContextDocumentSchema.safeParse({ ...document, tools: [] }).success).toBe(false);
    // Only `user` history is in the first support set; anything else rejects.
    expect(
      InputPreparationContextDocumentSchema.safeParse({
        ...document,
        messages: [{ role: 'assistant', content: 'hi', timestamp: 1 }],
      }).success,
    ).toBe(false);
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

describe('input preparation capability and routes', () => {
  it('declares one capability flag and two device routes', () => {
    expect(CAPABILITY_FLAGS as readonly string[]).toContain(AGENT_INPUT_PREPARATION_CAPABILITY);
    expect(AGENT_INPUT_PREPARATION_CAPABILITY).toBe('agent-input-preparation');
    expect(BYOK_INPUT_PREPARATION_COMPLETION_ROUTE).toBe('/byok/input-preparations/:requestId/completion');
    expect(BYOK_INPUT_PREPARATION_STATUS_ROUTE).toBe('/byok/input-preparations/:requestId');
  });

  it('builds each path with the request id URL-encoded, exactly as the router template names it', () => {
    expect(byokInputPreparationCompletionPath('a/b')).toBe('/byok/input-preparations/a%2Fb/completion');
    expect(byokInputPreparationStatusPath('a/b')).toBe('/byok/input-preparations/a%2Fb');
  });
});
