import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from 'pi-subagents/capability-ceiling';
import {
  BYOK_PI_PERMISSION_MODE,
  BYOK_PI_READONLY_SUBAGENT_AGENTS,
  BYOK_PI_READONLY_SUBAGENT_TOOLS,
} from './subagents-policy-config';

function permissionMode(): 'auto' | 'readonly' {
  const mode = process.env[BYOK_PI_PERMISSION_MODE];
  if (mode === 'auto' || mode === 'readonly') return mode;
  throw new Error(`${BYOK_PI_PERMISSION_MODE} must be "auto" or "readonly"`);
}

/**
 * Keep pi-subagents available in every Pi session without letting a readonly
 * parent widen its task contract through a child process.
 */
export default function registerByokSubagentsPolicy(pi: ExtensionAPI): void {
  const mode = permissionMode();
  let ceiling: SubagentCapabilityCeilingHandle | undefined;

  pi.on('session_start', (_event, ctx) => {
    ceiling?.dispose();
    ceiling = undefined;
    if (mode === 'auto') return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) throw new Error('readonly Pi subagent policy requires an authoritative session id');
    ceiling = registerSubagentCapabilityCeiling({
      sessionId,
      source: 'byok-sdk-readonly',
      ceiling: {
        allowedTools: BYOK_PI_READONLY_SUBAGENT_TOOLS,
        allowedAgents: BYOK_PI_READONLY_SUBAGENT_AGENTS,
        denyExtensions: true,
      },
    });
  });

  pi.on('tool_call', (event) => {
    if (mode === 'readonly' && event.toolName === 'subagent' && ceiling === undefined) {
      return {
        block: true,
        terminate: true,
        reason: 'readonly Pi subagent capability ceiling is unavailable',
      };
    }
  });

  pi.on('session_shutdown', () => {
    ceiling?.dispose();
    ceiling = undefined;
  });
}
