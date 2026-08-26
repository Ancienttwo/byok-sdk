import { createMutableClock } from '@byok-sdk/core';
import {
  AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  InMemoryAgentMemoryProjectionAuthorizer,
  InMemoryAgentMemoryProjectionStore,
  createWebCrypto,
  fullCapabilityDeclaration,
} from '..';
import { DEFAULT_MAX_AGENT_MEMORY_PROJECTION_REQUEST_BYTES } from '../handlers/agent-memory-projections';
import { TENANT_A, createHarness } from './support/harness';

describe('Agent-memory projection request-body boundary', () => {
  it('rejects an authenticated JSON body larger than any valid projection envelope', async () => {
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const harness = createHarness({
      clock,
      crypto,
      capabilities: fullCapabilityDeclaration(undefined, { includeAgentMemoryProjection: true }),
      agentMemoryProjectionAuthorizer: new InMemoryAgentMemoryProjectionAuthorizer(),
      agentMemoryProjectionStore: new InMemoryAgentMemoryProjectionStore(clock, crypto),
    });
    const device = await harness.pairDevice(TENANT_A);

    // No Content-Length is supplied: chunked/streamed requests need the same
    // pre-parse bound as declared-length requests. This body is twice the
    // 512 KiB decoded snapshot ceiling before its JSON envelope is counted.
    const response = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ignored: 'x'.repeat(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES * 2) }),
    });

    expect(response.status).toBe(413);
  });

  it('rejects a declared Content-Length above the finite envelope ceiling before parsing', async () => {
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const harness = createHarness({
      clock,
      crypto,
      capabilities: fullCapabilityDeclaration(undefined, { includeAgentMemoryProjection: true }),
      agentMemoryProjectionAuthorizer: new InMemoryAgentMemoryProjectionAuthorizer(),
      agentMemoryProjectionStore: new InMemoryAgentMemoryProjectionStore(clock, crypto),
    });
    const device = await harness.pairDevice(TENANT_A);

    const response = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
      method: 'POST',
      headers: {
        ...device.authorization,
        'content-type': 'application/json',
        'content-length': String(DEFAULT_MAX_AGENT_MEMORY_PROJECTION_REQUEST_BYTES + 1),
      },
      body: '{}',
    });

    expect(response.status).toBe(413);
  });

  it('keeps malformed and invalid JSON bodies within the bound at 422', async () => {
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const harness = createHarness({
      clock,
      crypto,
      capabilities: fullCapabilityDeclaration(undefined, { includeAgentMemoryProjection: true }),
      agentMemoryProjectionAuthorizer: new InMemoryAgentMemoryProjectionAuthorizer(),
      agentMemoryProjectionStore: new InMemoryAgentMemoryProjectionStore(clock, crypto),
    });
    const device = await harness.pairDevice(TENANT_A);

    for (const body of ['{"', '{}']) {
      const response = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(422);
    }
  });
});
