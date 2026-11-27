import { ModelConfirmationError } from '../../vendor/oar/223703d/contracts/model-confirmation-error.js';
import { UnsupportedOptionError } from '../../vendor/oar/223703d/contracts/errors.js';
import { acpReportedModel } from '../../vendor/oar/223703d/shared/acp/model.js';
import type { AcpSessionProfile } from '../../vendor/oar/223703d/shared/acp/profile.js';
import { acpSession } from '../../vendor/oar/223703d/shared/acp/session.js';
import { cursorMcpHasCredentials, unsupportedCursorOption } from '../adapters/cursor/cursor-policy.js';

export const CURSOR_ACP_ARGS = ['--force', 'acp'] as const;
export const CURSOR_ACP_CLIENT_META = Object.freeze({ parameterizedModelPicker: true });

const cursorProfile: AcpSessionProfile = {
  args: CURSOR_ACP_ARGS,
  capabilities: { queue: { durable: false }, attribution: 'opaque' },
  requestTimeoutMs: 30_000,
  clientCapabilitiesMeta: () => CURSOR_ACP_CLIENT_META,
  // ACP startup discovers existing CLI login. Sending authenticate can start browser login.
  // Cursor vendor requests are unregistered, so the protocol SDK returns method not found.
  modelViaConfigOption: true,
  validateOptions(options) {
    const unsupported = unsupportedCursorOption(options);
    if (unsupported !== undefined) throw new Error(`Cursor ACP does not support ${unsupported}`);
    if (options.mcpServers?.some(cursorMcpHasCredentials)) {
      throw new UnsupportedOptionError('mcpServers', 'Cursor ACP refuses credentialed task MCP servers');
    }
  },
  async configureModel({ options, setModel, setEffort }) {
    const response = options.model === undefined ? undefined : await setModel(options.model);
    if (options.model !== undefined) {
      const reported = acpReportedModel(response ?? null);
      if (reported !== options.model) {
        throw new ModelConfirmationError('Cursor ACP returned a different model', { requested: options.model, reported });
      }
    }
    if (options.effort !== undefined) await setEffort(options.effort, response);
    return response;
  },
};

export const cursorSession = acpSession(cursorProfile);
