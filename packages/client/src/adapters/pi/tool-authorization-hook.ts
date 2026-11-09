import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { formatToolAuthorizationDenial } from '../../tool-authorization';
import { requestToolAuthorization, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';

/** pi-subagents' hidden workflow-child approval tool; it starts nothing itself. */
const PI_SUBAGENT_LAUNCH_TOOL = 'subagent_launch';
const UNADMITTED_LAUNCH = 'tool_authorization_denied: subagent_launch is admitted only as the workflow child check of an allowed subagent call';
const MALFORMED_LAUNCH = 'tool_authorization_denied: subagent_launch input does not have its pinned shape';
// The parameters of the pinned pi-subagents `subagent_launch` tool.
const LAUNCH_KEYS = new Set(['workflowRunId', 'key', 'agent', 'task', 'cwd', 'model', 'async', 'worktree', 'resume', 'commands', 'output']);
const LAUNCH_COMMAND_KEYS = new Set(['command', 'cwd', 'env']);

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The gate judges `cwd`, `commands` and `output`; any other shape is refused rather than guessed. */
function wellFormedLaunch(input: unknown): boolean {
  if (!record(input) || Object.keys(input).some(key => !LAUNCH_KEYS.has(key))) return false;
  if (!optionalString(input.cwd) || !optionalString(input.output)) return false;
  if (input.commands === undefined) return true;
  return Array.isArray(input.commands) && input.commands.every(entry => record(entry)
    && Object.keys(entry).every(key => LAUNCH_COMMAND_KEYS.has(key)) && typeof entry.command === 'string' && optionalString(entry.cwd)
    && (entry.env === undefined || (record(entry.env) && Object.values(entry.env).every(value => typeof value === 'string'))));
}

/**
 * Pi's `tool_call` hook runs before execution; a block becomes the tool's error
 * result. In a native subagent child it names the child session as the agent.
 *
 * pi-subagents asks `subagent_launch` before each workflow child starts, as a
 * nested call of the `subagent` call that runs the workflow (also after an
 * async `subagent` call returned). The model can reach the same name through
 * `tool_search` or a codemode script, so the name proves nothing (#1511).
 * Pi sets `parentToolCallId` on a nested call itself. Only a call whose parent
 * is a `subagent` call this session's gate allowed, with the pinned input
 * shape, reaches the gate, which judges its cwd, gate commands and output with
 * its floor and ask rules; every other one is refused here.
 */
export function createPiToolAuthorizationHook(config: ToolAuthorizationIpcConfig, options: { subagentChild?: boolean } = {}): ExtensionFactory {
  return (pi) => {
    const allowedSubagentCalls = new Set<string>();
    pi.on('session_shutdown', () => { allowedSubagentCalls.clear(); });
    pi.on('tool_call', async (event, context) => {
      if (event.toolName === PI_SUBAGENT_LAUNCH_TOOL && !(event.parentToolCallId !== undefined && allowedSubagentCalls.has(event.parentToolCallId))) {
        return { block: true, reason: UNADMITTED_LAUNCH };
      }
      if (event.toolName === PI_SUBAGENT_LAUNCH_TOOL && !wellFormedLaunch(event.input)) return { block: true, reason: MALFORMED_LAUNCH };
      const verdict = await requestToolAuthorization(config, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
        cwd: context.cwd,
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        ...(options.subagentChild ? { nativeAgentId: `pi-subagent:${context.sessionManager.getSessionId()}` } : {}),
      });
      if (verdict.decision === 'deny') return { block: true, reason: formatToolAuthorizationDenial(verdict) };
      if (event.toolName === 'subagent') allowedSubagentCalls.add(event.toolCallId);
      return undefined;
    });
  };
}
