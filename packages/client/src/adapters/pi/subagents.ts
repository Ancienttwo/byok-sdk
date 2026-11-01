import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';

// pi-subagents reads its own package files (manifest, agents, prompts, runner
// scripts) at run time, so it loads only from the installed package. The
// specifiers stay opaque to bundlers: a product bundle never inlines it.
const PI_SUBAGENTS: string = 'pi-subagents';
const PI_SUBAGENTS_REQUIRED_CHILD_EXTENSIONS: string = 'pi-subagents/required-child-extensions';

/** Launch-evidence id of the SDK gate in every native Pi subagent child. */
export const PI_SUBAGENT_GATE_EXTENSION_ID = 'byok-tool-authorization';
/** Launch-evidence id of the file-scope extension required only by a scoped parent. */
export const PI_SUBAGENT_FILE_SCOPE_EXTENSION_ID = 'byok-file-scope';

/**
 * The installed pi-subagents extension. Under the `auto` gate, the parent
 * session requires `gateExtensionPath` in every native child (foreground,
 * background, nested and resumed), and pi-subagents refuses external-cli,
 * external-job and machine runners before they start, because only native
 * children load the gate (`requireForAllRunners`).
 *
 * A file-scoped parent additionally requires the scope extension, which
 * re-resolves the same grant before registering the SDK scoped file tools. The
 * gate extension refuses the six file tools when those tools did not register,
 * so a scope extension that fails to load cannot leave an unscoped child.
 */
export async function loadPiSubagentsExtensions(
  gate: ToolAuthorizationIpcConfig | null,
  gateExtensionPath: string,
  fileScopeExtensionPath?: string,
): Promise<ExtensionFactory[]> {
  const { default: subagents } = await import(PI_SUBAGENTS) as typeof import('pi-subagents');
  if (gate === null) return [subagents];
  const { registerRequiredChildExtensions } = await import(PI_SUBAGENTS_REQUIRED_CHILD_EXTENSIONS) as typeof import('pi-subagents/required-child-extensions');
  const requireGate: ExtensionFactory = (pi) => {
    let registration: { dispose(): void } | undefined;
    const release = (): void => { registration?.dispose(); registration = undefined; };
    pi.on('session_start', (_event, context) => {
      // A replaced session has a new id; pi-subagents allows one registration per session.
      release();
      registration = registerRequiredChildExtensions({
        sessionId: context.sessionManager.getSessionId(),
        // The scope extension loads first so its tool_call precheck runs
        // before the authorization hook: an out-of-scope file call is denied,
        // never presented as an approval request. The gate stays last.
        extensions: [
          ...(fileScopeExtensionPath === undefined ? [] : [{ id: PI_SUBAGENT_FILE_SCOPE_EXTENSION_ID, path: fileScopeExtensionPath }]),
          { id: PI_SUBAGENT_GATE_EXTENSION_ID, path: gateExtensionPath },
        ],
        requireForAllRunners: true,
      });
    });
    pi.on('session_shutdown', release);
  };
  return [subagents, requireGate];
}
