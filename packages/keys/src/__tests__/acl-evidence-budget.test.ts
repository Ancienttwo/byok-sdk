import { describe, expect, it } from 'vitest';
import {
  PI_ACL_CLIENT_STARTUP_DEADLINE_MS,
  PI_ACL_COLD_EVIDENCE_BUDGET_MS,
  PI_ACL_EVIDENCE_MARGIN_MS,
  PI_ACL_ICACLS_DEADLINE_MS,
  PI_ACL_TEARDOWN_EVIDENCE_BUDGET_MS,
  PI_ACL_WARM_EVIDENCE_BUDGET_MS,
  remainingAclEvidenceMs,
} from '../fixtures/acl-evidence-budget';

// Vitest's own defaults, restated because every budget below must stay
// strictly inside them. A vitest.config.ts change must update this guard.
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;

describe('Windows Pi projection ACL evidence budgets', () => {
  it('keeps the cold watchdog strictly inside the client startup deadline', () => {
    expect(PI_ACL_CLIENT_STARTUP_DEADLINE_MS).toBe(30_000);
    expect(PI_ACL_EVIDENCE_MARGIN_MS).toBe(200);
    expect(PI_ACL_COLD_EVIDENCE_BUDGET_MS)
      .toBe(PI_ACL_CLIENT_STARTUP_DEADLINE_MS - PI_ACL_EVIDENCE_MARGIN_MS);
    expect(PI_ACL_COLD_EVIDENCE_BUDGET_MS).toBeLessThan(PI_ACL_CLIENT_STARTUP_DEADLINE_MS);
  });

  it('keeps warm, icacls and teardown budgets inside vitest defaults', () => {
    expect(PI_ACL_WARM_EVIDENCE_BUDGET_MS).toBeLessThan(VITEST_DEFAULT_TEST_TIMEOUT_MS);
    expect(PI_ACL_ICACLS_DEADLINE_MS).toBeLessThan(PI_ACL_WARM_EVIDENCE_BUDGET_MS);
    expect(PI_ACL_TEARDOWN_EVIDENCE_BUDGET_MS).toBeLessThan(VITEST_DEFAULT_HOOK_TIMEOUT_MS);
  });

  it('recomputes the remaining probe budget at the observed phase offsets', () => {
    // Run 41143045892: the cold probe started at t+59ms, the warm at t+50ms.
    expect(remainingAclEvidenceMs(PI_ACL_COLD_EVIDENCE_BUDGET_MS, 59)).toBe(29_741);
    expect(remainingAclEvidenceMs(PI_ACL_WARM_EVIDENCE_BUDGET_MS, 50)).toBe(4_750);
  });

  it('never turns a spent or over-spent budget into a negative watchdog', () => {
    expect(remainingAclEvidenceMs(PI_ACL_WARM_EVIDENCE_BUDGET_MS, 0)).toBe(PI_ACL_WARM_EVIDENCE_BUDGET_MS);
    expect(remainingAclEvidenceMs(PI_ACL_WARM_EVIDENCE_BUDGET_MS, PI_ACL_WARM_EVIDENCE_BUDGET_MS)).toBe(0);
    expect(remainingAclEvidenceMs(PI_ACL_WARM_EVIDENCE_BUDGET_MS, 9_999)).toBe(0);
  });
});
