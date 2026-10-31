import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { FileScopeGuardError } from '../../file-scope-guard';
import { verifySerializedFileScopeGrant } from '../../file-scope-launch';
import {
  isScopedFileToolName, type FileScopeGuardCode, type FileScopeGuardReason,
} from '../../file-scope-types';
import { reportFileScopeDenial, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';
import { createPiFileScopeExtension } from './file-scope-extension';

/**
 * The file-scope extension of a native Pi subagent child (#1061 D11/S1).
 *
 * The parent passes the same serialized grant (roots + digest) through the
 * child gate config. This factory re-resolves every root, recomputes the grant
 * digest and compares it with the parent's before it registers the six SDK
 * scoped file tools. A missing, mismatched, replaced or no-longer-supported
 * grant registers no file tools and blocks every one of the six names with the
 * typed failure, so the child fails closed instead of running unscoped. The
 * grant is never trusted because the parent says so, and the parent's audit
 * channel receives the child's denies through the same gate token.
 */
export function createPiSubagentFileScopeExtension(gate: ToolAuthorizationIpcConfig): ExtensionFactory {
  return async (pi) => {
    const block = (reason: string, code: FileScopeGuardCode, guardReason: FileScopeGuardReason) =>
      async (event: { readonly toolName: string; readonly toolCallId?: string }) => {
        if (!isScopedFileToolName(event.toolName)) return undefined;
        // The deny is enforced before this report; a transport failure never
        // turns it into an allow, and allow is never reported (D12).
        await reportFileScopeDenial(gate, {
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
          toolName: event.toolName, code, reason: guardReason,
        });
        return { block: true, reason };
      };
    const serialized = gate.fileScope;
    if (serialized === undefined) {
      pi.on('tool_call', block(
        'file_scope_unavailable: a file-scoped Pi subagent child has no parent grant (missing grant)',
        'file_scope_unavailable', 'io_error',
      ));
      return;
    }
    let grant;
    try {
      grant = await verifySerializedFileScopeGrant(serialized);
    } catch (error) {
      const guard = error instanceof FileScopeGuardError
        ? error : new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
      pi.on('tool_call', block(
        guard.code + ': a Pi subagent child could not re-verify the parent file-scope grant (' + guard.reason + ')',
        guard.code, guard.reason,
      ));
      return;
    }
    // Registration drift cannot silently hand the model a native file tool.
    pi.on('tool_call', (event) => {
      if (!isScopedFileToolName(event.toolName)) return undefined;
      try {
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (tool !== undefined && tool.sourceInfo.path !== 'builtin:' + event.toolName) return undefined;
      } catch { /* An unreadable loadout cannot prove the scope. */ }
      return {
        block: true,
        reason: 'file_scope_registry_drift: the scoped ' + event.toolName + ' tool is not registered in this subagent child',
      };
    });
    createPiFileScopeExtension({ grant, gate })(pi);
  };
}
