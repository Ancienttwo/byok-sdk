import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  formatToolExecutionDenial, parseToolExecutionGateConfig, requestToolExecutionDecision,
  type ToolExecutionGateConfig,
} from '../../tool-execution-hook';

/** Inherited only by SDK-owned native Pi child sessions. The root comes from its digest-bound launch. */
export const PI_TOOL_EXECUTION_GATE_ENV = 'BYOK_TOOL_EXECUTION_GATE';

export function setPiToolExecutionGate(config: ToolExecutionGateConfig | null): void {
  if (config === null) delete process.env[PI_TOOL_EXECUTION_GATE_ENV];
  else process.env[PI_TOOL_EXECUTION_GATE_ENV] = JSON.stringify(config);
}

/** Malformed inherited configuration must never turn a gated child into an ungated session. */
export function readPiToolExecutionGate(): ToolExecutionGateConfig | undefined {
  const encoded = process.env[PI_TOOL_EXECUTION_GATE_ENV];
  return encoded === undefined ? undefined : parseToolExecutionGateConfig(JSON.parse(encoded));
}

/** Register last, after user/SDK handlers have finished changing the actual tool arguments. */
export function createPiToolExecutionHook(config: ToolExecutionGateConfig): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, context) => {
      const input = event.input as Record<string, unknown>;
      const decision = await requestToolExecutionDecision(config, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input,
        cwd: context.cwd,
        ...(typeof input.command === 'string' ? { command: input.command } : {}),
        paths: typeof input.path === 'string' ? [input.path] : [],
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        ...(process.env.PI_SUBAGENT_CHILD === '1' ? { nativeAgentId: `pi-subagent:${process.pid}` } : {}),
      });
      if (decision.decision === 'deny') return { block: true, reason: formatToolExecutionDenial(decision) };
      return undefined;
    });
  };
}
