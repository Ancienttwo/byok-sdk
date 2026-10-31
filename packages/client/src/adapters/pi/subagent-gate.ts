import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { isScopedFileToolName } from '../../file-scope-types';
import type { ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';
import { piSubagentScopedToolSource } from './subagent-scope-registry';
import { createPiToolAuthorizationHook } from './tool-authorization-hook';

/**
 * The gate every native Pi subagent child loads (#1061 D11).
 *
 * A file-scoped parent marks its child gate config with `fileScopeRequired`
 * and passes the serialized grant. This extension refuses any of the six file
 * tools unless the scope extension published the exact source path of the six
 * SDK tool definitions, and the live registry still resolves that name to
 * exactly one tool from that source. A shadowing non-builtin registration, a
 * duplicate registration, a missing scope extension or a builtin fallback is
 * blocked; builtin entries beside the SDK one are ignored so a builtin-first
 * ordering does not brick a correctly registered scope.
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
        const source = piSubagentScopedToolSource();
        if (source !== undefined) {
          try {
            const entries = pi.getAllTools().filter((candidate) => candidate.name === event.toolName);
            const builtin = 'builtin:' + event.toolName;
            const scoped = entries.filter((candidate) => candidate.sourceInfo.path === source.sourcePath);
            const shadows = entries.filter((candidate) => candidate.sourceInfo.path !== source.sourcePath && candidate.sourceInfo.path !== builtin);
            if (scoped.length === 1 && shadows.length === 0) return undefined;
          } catch { /* An unreadable loadout cannot prove the scope. */ }
        }
        return {
          block: true,
          reason: 'file_scope_unavailable: a file-scoped Pi subagent child did not register the SDK scoped '
            + event.toolName + ' tool from the verified file-scope source, so the call is refused',
        };
      });
    }
    createPiToolAuthorizationHook(gate, { subagentChild: true })(pi);
  };
}
