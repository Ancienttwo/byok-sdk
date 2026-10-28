import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSubagentToolHookRunnerSupported } from '../subagents/tool-execution-hook';

afterEach(() => vi.unstubAllEnvs());

describe('Pi subagent runner hook coverage', () => {
  it('refuses external runners while a parent gate is present', () => {
    vi.stubEnv('BYOK_TOOL_EXECUTION_GATE', '{}');
    expect(assertSubagentToolHookRunnerSupported).toThrow('beforeTool cannot cover external-cli or external-job subagent runners');
    try { assertSubagentToolHookRunnerSupported(); } catch (error) {
      expect(error).toMatchObject({ code: 'tool_execution_hook_unsupported' });
    }
  });

  it('leaves external runners available without the optional hook', () => {
    vi.stubEnv('BYOK_TOOL_EXECUTION_GATE', undefined);
    expect(assertSubagentToolHookRunnerSupported).not.toThrow();
  });
});
