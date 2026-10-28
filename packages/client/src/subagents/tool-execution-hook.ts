import { ToolExecutionUnsupportedError } from '../tool-execution-hook';

/** External runners do not enter the SDK Pi session's per-tool execution pipeline. */
export function assertSubagentToolHookRunnerSupported(): void {
  if (process.env.BYOK_TOOL_EXECUTION_GATE !== undefined) {
    throw new ToolExecutionUnsupportedError('pi', 'beforeTool cannot cover external-cli or external-job subagent runners');
  }
}
