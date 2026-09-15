import {
  InputPreparationCompletionRequestSchema,
  InputPreparationReadbackSchema,
  byokInputPreparationCompletionPath,
  type InputPreparationCompletionRequest,
  type InputPreparationReadback,
} from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export class InputPreparationCompletionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InputPreparationCompletionError';
  }
}

function sameAgentRef(
  left: InputPreparationReadback['agentRef'],
  right: InputPreparationCompletionRequest['agentRef'],
): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

/**
 * Direct authenticated completion lane, mirroring
 * `AgentHomeProjectionCompletionClient`.
 *
 * It deliberately does NOT use the transport outbox. The envelope handler may
 * advance the server-to-daemon redelivery cursor only after this request has
 * returned the exact durable status it just recorded — an outbox enqueue would
 * give the handler nothing to wait on, so a crash between "queued" and "sent"
 * would look identical to a completed preparation and the mailbox row would be
 * acknowledged for work the cloud never learned the outcome of.
 *
 * The readback is checked field by field against what was sent. A 200 whose
 * body names a different tenant, device, request, Agent or outcome is not a
 * completion this daemon may act on, even though the HTTP call "succeeded".
 */
export class InputPreparationCompletionClient {
  constructor(private readonly options: {
    readonly serverUrl: string;
    readonly auth: AuthManager;
    readonly tenantId: string;
    readonly deviceId: string;
  }) {}

  async complete(input: InputPreparationCompletionRequest): Promise<InputPreparationReadback> {
    const completion = InputPreparationCompletionRequestSchema.parse(input);
    const url = new URL(
      byokInputPreparationCompletionPath(completion.requestId),
      toHttpBase(this.options.serverUrl),
    );
    let response: Response;
    try {
      response = await authedFetch(
        url,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(completion),
        },
        this.options.auth,
      );
    } catch (error) {
      throw new InputPreparationCompletionError('input preparation completion transport failed', { cause: error });
    }
    if (!response.ok) {
      throw new InputPreparationCompletionError(
        `input preparation completion was rejected with HTTP ${response.status}`,
      );
    }

    let readback: InputPreparationReadback;
    try {
      readback = InputPreparationReadbackSchema.parse(await response.json());
    } catch (error) {
      throw new InputPreparationCompletionError('input preparation completion readback is invalid', { cause: error });
    }
    if (
      readback.tenantId !== this.options.tenantId ||
      readback.deviceId !== this.options.deviceId ||
      readback.requestId !== completion.requestId ||
      !sameAgentRef(readback.agentRef, completion.agentRef) ||
      readback.profileId !== completion.profileId ||
      readback.policyRevision !== completion.policyRevision ||
      readback.status !== completion.outcome ||
      readback.completedAt === undefined
    ) {
      throw new InputPreparationCompletionError(
        'input preparation completion readback does not exactly match the authenticated request',
      );
    }
    return readback;
  }
}
