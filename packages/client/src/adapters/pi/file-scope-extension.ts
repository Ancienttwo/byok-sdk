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

/** The six SDK scoped file tools and the precheck that runs before the auto gate. */
export interface PiFileScopeGuard {
  readonly tools: ReturnType<typeof createScopedFileTools>;
  /**
   * Deny an out-of-scope call to one of the six tools before the auto gate is
   * asked, so a scope violation is never presented as an approval request.
   * Returns the tool error text of a denial; any other tool passes.
   */
  precheck(call: {
    readonly toolCallId?: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly cwd: string;
  }): Promise<string | undefined>;
}

export function createPiFileScopeGuard(options: PiFileScopeExtensionOptions): PiFileScopeGuard {
  const onDenial = async (denial: ScopedFileDenial): Promise<void> => {
    const reported = await reportFileScopeDenial(options.gate, denial);
    if (!reported) {
      try { options.onTransportFailure?.(denial); } catch { /* The deny already stands. */ }
    }
  };
  return {
    tools: createScopedFileTools({ grant: options.grant, onDenial }),
    async precheck({ toolCallId, toolName, input, cwd }) {
      if (!isScopedFileToolName(toolName)) return undefined;
      try {
        await precheckScopedFileCall({ grant: options.grant, onDenial }, { toolName, input, cwd });
        return undefined;
      } catch (error) {
        const guard = error instanceof FileScopeGuardError
          ? error
          : new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
        await onDenial({
          ...(toolCallId === undefined ? {} : { toolCallId }),
          toolName,
          code: guard.code,
          reason: guard.reason,
          ...(guard.rootId === undefined ? {} : { rootId: guard.rootId }),
          ...(guard.access === undefined ? {} : { access: guard.access }),
        });
        return formatScopedFileDenial(toolName, input.path, guard);
      }
    },
  };
}

/**
 * Register the six SDK-owned scoped file tools (read, write, edit, find, grep,
 * ls) in the ordinary Pi RPC session, with the precheck on `tool_call`. Each
 * tool also guards immediately before touching a path.
 *
 * These tools shadow the native Pi file tools of the same name. The extension
 * does not replace `bash`, which remains the documented out-of-scope shell
 * capability (subject to the scoped per-call approval floor).
 */
export function createPiFileScopeExtension(options: PiFileScopeExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const guard = createPiFileScopeGuard(options);
    for (const tool of guard.tools) (pi.registerTool as (definition: unknown) => void)(tool);
    pi.on('tool_call', async (event, context) => {
      const reason = await guard.precheck({
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        toolName: event.toolName, input: event.input as Readonly<Record<string, unknown>>, cwd: context.cwd,
      });
      return reason === undefined ? undefined : { block: true, reason };
    });
  };
}
