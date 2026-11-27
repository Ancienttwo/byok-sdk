import { RequestError } from '@agentclientprotocol/sdk';
import { ModelConfirmationError } from '../../vendor/oar/223703d/contracts/model-confirmation-error.js';
import { acpReportedModel } from '../../vendor/oar/223703d/shared/acp/model.js';
import type { AcpSessionProfile } from '../../vendor/oar/223703d/shared/acp/profile.js';
import { acpSession, type StartAcpSession } from '../../vendor/oar/223703d/shared/acp/session.js';

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

const start = acpSession(cursorProfile);

type StartArgs = Parameters<StartAcpSession>;

/** Cursor runs shell tools itself. A reverse terminal request cannot start a Host process. */
export function cursorSession(spawn: StartArgs[0], installation: StartArgs[2], options: StartArgs[3], hooks?: StartArgs[4]): ReturnType<StartAcpSession> {
  return start(spawn, () => { throw RequestError.methodNotFound('terminal/create'); }, installation, options, hooks);
}
