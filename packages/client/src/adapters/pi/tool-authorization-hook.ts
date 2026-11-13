import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { formatToolAuthorizationDenial } from '../../tool-authorization.js';
import { requestToolAuthorization, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc.js';

/** pi-subagents' hidden workflow-child approval tool; it starts nothing itself. */
const PI_SUBAGENT_LAUNCH_TOOL = 'subagent_launch';
const UNADMITTED_LAUNCH = 'tool_authorization_denied: subagent_launch is admitted only as the workflow child check of an allowed subagent call';
const MALFORMED_LAUNCH = 'tool_authorization_denied: subagent_launch input does not have its pinned shape';
// The pinned `subagent_launch` parameters (pi-subagents 0.88.1
// bundle/chunk-EYGBK6CE.js:8201-8216): `workflowRunId` and `key` are required
// strings; the rest are optional. Paths must be non-empty.
type FieldCheck = (value: unknown) => boolean;
const text: FieldCheck = value => typeof value === 'string';
const path: FieldCheck = value => typeof value === 'string' && value.length > 0;
const flag: FieldCheck = value => typeof value === 'boolean';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const env: FieldCheck = value => record(value) && Object.values(value).every(entry => typeof entry === 'string');
// Own properties only on both sides: an inherited name such as `toString` is neither a field nor a validator.
const exactObject = (required: Readonly<Record<string, FieldCheck>>, optional: Readonly<Record<string, FieldCheck>>): FieldCheck => value => record(value)
  && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
  && Object.entries(value).every(([key, field]) => Object.hasOwn(required, key) ? required[key]!(field)
    : Object.hasOwn(optional, key) ? optional[key]!(field) : false);
const command = exactObject({ command: text }, { cwd: path, env });
/** One validator at the hook boundary; the gate classifier relies on this shape. */
const wellFormedLaunch = exactObject({ workflowRunId: text, key: text }, {
  agent: text, task: text, cwd: path, model: text, async: flag, worktree: flag, resume: text,
  commands: value => Array.isArray(value) && value.every(command), output: path,
});

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
