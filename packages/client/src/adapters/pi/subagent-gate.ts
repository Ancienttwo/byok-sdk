import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { isScopedFileToolName } from '../../file-scope-types';
import type { ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';
import { createPiToolAuthorizationHook } from './tool-authorization-hook';

/**
 * The gate every native Pi subagent child loads (#1061 D11).
 *
 * A file-scoped parent marks its child gate config with `fileScopeRequired`
 * and passes the serialized grant. This extension refuses any of the six file
 * tools unless the SDK scoped file tools actually registered in this child, so
 * a child whose scope extension failed to load or whose grant did not verify
 * cannot fall back to the native Pi file tools. It checks the registered tool
 * source rather than trusting that the extra required extension loaded.
 *
 * Non-file tools (bash, MCP, extensions) keep the ordinary per-call gate; this
 * extension does not turn them into scope violations.
 */
export function createPiSubagentGateExtension(gate: ToolAuthorizationIpcConfig): ExtensionFactory {
  const requiresScope = gate.fileScopeRequired === true || gate.fileScope !== undefined;
  return (pi) => {
    if (requiresScope) {
      pi.on('tool_call', (event) => {
        if (!isScopedFileToolName(event.toolName)) return undefined;
        try {
          const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
          if (tool !== undefined && tool.sourceInfo.path !== 'builtin:' + event.toolName) return undefined;
        } catch { /* An unreadable loadout cannot prove the scope. */ }
        return {
          block: true,
          reason: 'file_scope_unavailable: a file-scoped Pi subagent child did not register the SDK scoped '
            + event.toolName + ' tool, so the call is refused',
        };
      });
    }
    createPiToolAuthorizationHook(gate, { subagentChild: true })(pi);
  };
}
