import { TOOL_AUTHORIZATION_GATE_ENV } from '../tool-authorization-ipc';

/** External CLI/job runners execute outside the Pi tool pipeline, so `auto` cannot gate them. */
export function assertSubagentRunnerAuthorized(): void {
  if (process.env[TOOL_AUTHORIZATION_GATE_ENV] !== undefined) {
    throw new Error('tool_authorization_unsupported: external-cli and external-job subagent runners cannot be gated before execution in auto mode');
  }
}
