import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLAGS, HOST_MCP_TASK_CONTEXT_CAPABILITY } from '../index';

/**
 * Contract §8.1 / AC13 (R2-N19), device-level half of the capability gate.
 *
 * Two independent channels carry `host-mcp-task-context`: a deployment declares
 * it through `CapabilityDeclarationSchema` (`@byok-sdk/cloud`'s
 * `CLOUD_CAPABILITIES`), and a DEVICE advertises it as a `conn.hello`
 * capability string a host consumes through `declaresCapabilities`. This file
 * pins the device-level one — the vocabulary, not the daemon's decision to send
 * it, which lives in `packages/client`.
 */
describe('host-mcp-task-context device capability', () => {
  it('is the exact name the contract gates on', () => {
    expect(HOST_MCP_TASK_CONTEXT_CAPABILITY).toBe('host-mcp-task-context');
  });

  it('is spelled so the deployment-level channel can carry the SAME string', () => {
    // `@byok-sdk/core`'s `CAPABILITY_NAME_PATTERN`, restated rather than
    // imported: `@byok-sdk/protocol` does not depend on core, and the point of
    // the assertion is that one literal name is legal in BOTH channels. A name
    // this rejects could never appear in a `CapabilityDeclaration`, which would
    // leave the two channels naming different things.
    expect(HOST_MCP_TASK_CONTEXT_CAPABILITY).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
  });

  it('is registered as a daemon capability flag', () => {
    // `CapabilityFlag` is the closed union `conn.hello.capabilities` is typed
    // by; an unregistered name is a flag no daemon can send.
    expect(CAPABILITY_FLAGS).toContain(HOST_MCP_TASK_CONTEXT_CAPABILITY);
  });
});
