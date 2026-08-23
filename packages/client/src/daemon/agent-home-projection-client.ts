import {
  AgentHomeProjectionCompletionRequestSchema,
  AgentHomeProjectionReadbackSchema,
  byokAgentHomeProjectionCompletionPath,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionReadback,
} from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export class AgentHomeProjectionCompletionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentHomeProjectionCompletionError';
  }
}

function sameAgentRef(
  left: AgentHomeProjectionReadback['agentRef'],
  right: AgentHomeProjectionCompletionRequest['agentRef'],
): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

/**
 * Direct authenticated completion lane. It deliberately does not use the
 * transport outbox: a handler may advance the server-to-daemon cursor only
 * after this request returns the exact durable status it just recorded.
 */
export class AgentHomeProjectionCompletionClient {
  constructor(private readonly options: {
    readonly serverUrl: string;
    readonly auth: AuthManager;
    readonly tenantId: string;
    readonly deviceId: string;
  }) {}

  async complete(input: AgentHomeProjectionCompletionRequest): Promise<AgentHomeProjectionReadback> {
    const completion = AgentHomeProjectionCompletionRequestSchema.parse(input);
    const url = new URL(
      byokAgentHomeProjectionCompletionPath(completion.requestId),
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
      throw new AgentHomeProjectionCompletionError('Agent-home projection completion transport failed', {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new AgentHomeProjectionCompletionError(
        `Agent-home projection completion was rejected with HTTP ${response.status}`,
      );
    }

    let readback: AgentHomeProjectionReadback;
    try {
      readback = AgentHomeProjectionReadbackSchema.parse(await response.json());
    } catch (error) {
      throw new AgentHomeProjectionCompletionError('Agent-home projection completion readback is invalid', {
        cause: error,
      });
    }
    if (
      readback.tenantId !== this.options.tenantId ||
      readback.deviceId !== this.options.deviceId ||
      readback.requestId !== completion.requestId ||
      !sameAgentRef(readback.agentRef, completion.agentRef) ||
      readback.projectionHash !== completion.projectionHash ||
      readback.status !== completion.outcome ||
      readback.completedAt === undefined
    ) {
      throw new AgentHomeProjectionCompletionError(
        'Agent-home projection completion readback does not exactly match the authenticated request',
      );
    }
    return readback;
  }
}
