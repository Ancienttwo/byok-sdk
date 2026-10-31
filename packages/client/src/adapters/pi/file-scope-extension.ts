import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { FileScopeGuardError, type FileScopeGrant } from '../../file-scope-guard';
import {
  createScopedFileTools,
  formatScopedFileDenial,
  isScopedFileToolName,
  precheckScopedFileCall,
  type ScopedFileDenial,
} from '../../file-scope-tools';
import { reportFileScopeDenial, type ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';

export interface PiFileScopeExtensionOptions {
  readonly grant: FileScopeGrant;
  /** The per-task loopback gate; its token authenticates the deny-audit channel too. */
  readonly gate: ToolAuthorizationIpcConfig;
  /** Reported when a deny could not reach the daemon; the deny itself is already enforced. */
  readonly onTransportFailure?: (denial: ScopedFileDenial) => void;
}

/**
 * Register the SDK-owned scoped read/write/edit tools in the ordinary Pi RPC
 * session. Each tool guards immediately before touching a file, and the
 * `tool_call` precheck denies an out-of-scope call before the auto-approval
 * gate is asked, so a scope violation is never presented as an approval
 * request.
 *
 * The extension does not replace `bash`, which remains the documented
 * out-of-scope shell capability, and it does not replace find/grep/ls in this
 * slice: those native tools are excluded from a scoped session instead, so
 * they cannot read around the scope.
 */
export function createPiFileScopeExtension(options: PiFileScopeExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const onDenial = async (denial: ScopedFileDenial): Promise<void> => {
      const reported = await reportFileScopeDenial(options.gate, denial);
      if (!reported) {
        try { options.onTransportFailure?.(denial); } catch { /* The deny already stands. */ }
      }
    };
    const tools = createScopedFileTools({ grant: options.grant, onDenial });
    for (const tool of tools) (pi.registerTool as (definition: unknown) => void)(tool);
    pi.on('tool_call', async (event, context) => {
      if (!isScopedFileToolName(event.toolName)) return undefined;
      const input = event.input as Readonly<Record<string, unknown>>;
      try {
        await precheckScopedFileCall({ grant: options.grant, onDenial }, {
          toolName: event.toolName, input, cwd: context.cwd,
        });
        return undefined;
      } catch (error) {
        const guard = error instanceof FileScopeGuardError
          ? error
          : new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
        await onDenial({
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
          toolName: event.toolName,
          code: guard.code,
          reason: guard.reason,
          ...(guard.rootId === undefined ? {} : { rootId: guard.rootId }),
          ...(guard.access === undefined ? {} : { access: guard.access }),
        });
        return { block: true, reason: formatScopedFileDenial(event.toolName, input.path, guard) };
      }
    });
  };
}
