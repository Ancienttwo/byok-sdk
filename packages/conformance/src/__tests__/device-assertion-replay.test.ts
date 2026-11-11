import { InMemoryDeviceAssertionReplayAuthority } from '@byok-sdk/core';
import { MEMBER_CHAIN_OPS } from '@byok-sdk/core/sealed-payload';
import { E2EE_MEMBER_CHAIN_OPS } from '@byok-sdk/protocol';
import { expect, it } from 'vitest';
import { runDeviceAssertionReplayConformance } from '../device-assertion-replay';

runDeviceAssertionReplayConformance('in-memory', {
  create: () => ({ replay: new InMemoryDeviceAssertionReplayAuthority() }),
});

// core and protocol are deliberately independent (§12.1), so the op list is a copy; this is its drift check.
// The member-id pattern is not compared: neither package exports it (protocol's is a module-private literal).
it('keeps the member-chain op list identical in core and protocol', () => {
  expect([...E2EE_MEMBER_CHAIN_OPS]).toEqual([...MEMBER_CHAIN_OPS]);
});
