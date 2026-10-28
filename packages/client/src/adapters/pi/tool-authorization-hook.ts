import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { formatToolAuthorizationDenial } from '../../tool-authorization';
import { requestToolAuthorization, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';

/** Pi's `tool_call` hook runs before execution; a block becomes the tool's error result. */
export function createPiToolAuthorizationHook(config: ToolAuthorizationIpcConfig): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, context) => {
      const verdict = await requestToolAuthorization(config, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
        cwd: context.cwd,
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        ...(process.env.PI_SUBAGENT_CHILD === '1' ? { nativeAgentId: `pi-subagent:${process.pid}` } : {}),
      });
      if (verdict.decision === 'deny') return { block: true, reason: formatToolAuthorizationDenial(verdict) };
      return undefined;
    });
  };
}
