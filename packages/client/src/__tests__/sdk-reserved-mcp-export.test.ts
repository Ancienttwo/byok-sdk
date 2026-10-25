import { describe, expect, it } from 'vitest';
import { isReservedMcpServerName } from '../index';

// A Host checks each Codex `event.mcp.server` against its task toolsets and
// these names (#935), so the package entry must keep exporting the predicate.
describe('isReservedMcpServerName from the package entry', () => {
  it('accepts exactly the SDK-owned server names', () => {
    for (const name of ['byokagentmessage', 'byokagentmemory', 'byokagentteam', 'byokagentresult']) {
      expect(isReservedMcpServerName(name)).toBe(true);
    }
    for (const name of ['', 'byokagent', 'BYOKAGENTMEMORY', 'user-notes', 'byokagentmemory ']) {
      expect(isReservedMcpServerName(name)).toBe(false);
    }
  });
});
