import type { SearchRuntimeEvidence } from './search-runtime-qualification.js';

/** Only combinations with a passing runtime-contract receipt belong here. */
export const SEARCH_RUNTIME_EVIDENCE: readonly SearchRuntimeEvidence[] = Object.freeze([
  Object.freeze({
    runtimeId: 'dsh', variant: 'sandbox=danger-full-access', version: '0.2.2-rc.1',
    platform: 'darwin', arch: 'arm64', lane: 'ordinary', helper: 'dist-script', executableSource: 'env',
    receipt: 'docs/researches/2026-11-19-mcp-search-runtime-qualification.md#dsh-022-rc1',
  }),
]);
