import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { FileScopeGuardError } from '../../file-scope-guard';
import { verifySerializedFileScopeGrant } from '../../file-scope-launch';
import {
  isScopedFileToolName, SCOPED_FILE_TOOL_NAMES, type FileScopeGuardCode, type FileScopeGuardReason,
} from '../../file-scope-types';
import { reportFileScopeDenial, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';
import { createPiFileScopeExtension } from './file-scope-extension';
import { setPiSubagentScopedToolSource } from './subagent-scope-registry';

export interface PiSubagentFileScopeExtensionOptions {
  /** Test seam only; production uses the exact path of this loaded module. */
  readonly sourcePath?: string;
}

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
 *
 * After registration, every file call re-checks the live tool registry: the
 * called name must resolve to exactly one non-builtin tool sourced from this
 * exact extension file, with no other non-builtin registration of that name.
 * A name the child's own tool allowlist omitted is simply not callable and is
 * not required; every present scoped name is still checked. Only then does the
 * extension publish the verified source path for the gate extension, which
 * independently re-checks the same exact source.
 */
export function createPiSubagentFileScopeExtension(
  gate: ToolAuthorizationIpcConfig,
  options: PiSubagentFileScopeExtensionOptions = {},
): ExtensionFactory {
  const sourcePath = options.sourcePath ?? fileURLToPath(import.meta.url);
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
    pi.on('tool_call', (event) => {
      if (!isScopedFileToolName(event.toolName)) return undefined;
      try {
        if (!scopedToolsAreExact(pi.getAllTools(), sourcePath, event.toolName)) {
          return {
            block: true,
            reason: 'file_scope_registry_drift: the scoped file tools are missing, duplicated, shadowed or not sourced from the SDK file-scope extension in this subagent child',
          };
        }
        setPiSubagentScopedToolSource(sourcePath);
        return undefined;
      } catch {
        return { block: true, reason: 'file_scope_unavailable: the scoped file-tool loadout could not be read in this subagent child' };
      }
    });
    createPiFileScopeExtension({ grant, gate })(pi);
  };
}

interface RegisteredTool {
  readonly name: string;
  readonly sourceInfo: { readonly path: string };
}

/**
 * True when the called name and every other present scoped name resolve to
 * exactly one non-builtin entry from the exact SDK scope extension file, with
 * no other non-builtin entry. A name the child's tool allowlist omitted is not
 * callable; the called name is never allowed to be absent. Builtin entries
 * beside the SDK one are ignored so a builtin-first registry ordering does not
 * brick a correctly registered scope.
 */
function scopedToolsAreExact(tools: readonly RegisteredTool[], sourcePath: string, called: string): boolean {
  for (const name of SCOPED_FILE_TOOL_NAMES) {
    const builtin = 'builtin:' + name;
    const entries = tools.filter((tool) => tool.name === name);
    if (entries.length === 0) {
      if (name === called) return false;
      continue;
    }
    const scoped = entries.filter((tool) => tool.sourceInfo.path === sourcePath);
    const shadows = entries.filter((tool) => tool.sourceInfo.path !== sourcePath && tool.sourceInfo.path !== builtin);
    if (scoped.length !== 1 || shadows.length > 0) return false;
  }
  return true;
}
