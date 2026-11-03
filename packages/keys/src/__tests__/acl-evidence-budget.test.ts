import { describe, expect, it } from 'vitest';
import { PI_ACL_CLIENT_STARTUP_DEADLINE_MS } from '../fixtures/acl-evidence-budget';

describe('Windows Pi projection ACL evidence budget', () => {
  it('matches the client startup deadline', () => {
    expect(PI_ACL_CLIENT_STARTUP_DEADLINE_MS).toBe(30_000);
  });
});
