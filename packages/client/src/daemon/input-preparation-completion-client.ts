import {
  InputPreparationCompletionRequestSchema,
  InputPreparationReadbackSchema,
  byokInputPreparationCompletionPath,
  byokInputPreparationStatusPath,
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
  private readonly statusReadDeadlineMs: number;

  constructor(private readonly options: {
    readonly serverUrl: string;
    readonly auth: AuthManager;
    readonly tenantId: string;
    readonly deviceId: string;
    /** One transport budget for status auth, headers and body; independent of preparation expiry. */
    readonly statusReadDeadlineMs?: number;
    /** Daemon lifecycle owner; only the status-read boundary uses this signal. */
    readonly statusReadSignal?: AbortSignal;
  }) {
    this.statusReadDeadlineMs = options.statusReadDeadlineMs ?? 15_000;
    if (!Number.isSafeInteger(this.statusReadDeadlineMs) || this.statusReadDeadlineMs <= 0 || this.statusReadDeadlineMs > 2_147_483_647) {
      throw new Error('statusReadDeadlineMs must be a positive timer-safe integer');
    }
  }

  /**
   * Race the whole read, not just fetch's header promise. Abort the transport
   * AND cancel our owned body reader; neither fetch nor a stream's underlying
   * cancel acknowledgement is trusted to settle on abort. Late results cannot
   * start another request, parse a receipt, or reach the preparation handler.
   */
  private async readStatus(url: URL): Promise<unknown> {
    const owner = this.options.statusReadSignal;
    if (owner?.aborted) throw new InputPreparationCompletionError('input preparation status read cancelled');
    const controller = new AbortController();
    let cancelBody = (): void => {};
    let rejectAbort!: (error: InputPreparationCompletionError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = (reason: 'deadline elapsed' | 'cancelled'): void => {
      if (controller.signal.aborted) return;
      const error = new InputPreparationCompletionError(`input preparation status read ${reason}`);
      controller.abort(error);
      cancelBody();
      rejectAbort(error);
    };
    const cancel = (): void => abort('cancelled');
    owner?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort('deadline elapsed'), this.statusReadDeadlineMs);
    timer.unref?.();
    const checkActive = (): void => controller.signal.throwIfAborted();
    const discard = (response: Response): void => { void response.body?.cancel().catch(() => undefined); };
    const read = async (): Promise<unknown> => {
      // Same single-401 renewal convention as authedFetch. The status lane
      // additionally gates each post-auth/post-fetch continuation, so an auth
      // or fetch implementation that ignores abort cannot send a late retry.
      const send = async (token: string): Promise<Response> => {
        checkActive();
        let response: Response;
        try {
          response = await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
        } catch (cause) {
          throw new InputPreparationCompletionError('input preparation status transport failed', { cause });
        }
        if (controller.signal.aborted) { discard(response); checkActive(); }
        return response;
      };
      let response = await send(await this.options.auth.getValidAccessToken());
      checkActive();
      if (response.status === 401) {
        discard(response);
        response = await send(await this.options.auth.handleUnauthorized());
        checkActive();
      }
      if (!response.ok) {
        discard(response);
        throw new InputPreparationCompletionError(`input preparation status was rejected with HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      let text = '';
      if (reader !== undefined) {
        cancelBody = () => { void reader.cancel().catch(() => undefined); };
        try {
          const decoder = new TextDecoder();
          for (;;) {
            checkActive();
            const { done, value } = await reader.read();
            checkActive();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          cancelBody = () => {};
          reader.releaseLock();
        }
      }
      checkActive();
      return JSON.parse(text);
    };
    try {
      return await Promise.race([read(), aborted]);
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw cause;
    } finally {
      clearTimeout(timer);
      owner?.removeEventListener('abort', cancel);
    }
  }

  /**
   * Recover an already committed terminal fact before doing any local work.
   * The authenticated cloud owns the immutable request and completion key;
   * expiry, local GC and changed launch readiness cannot rewrite that history.
   * Only a validated `pending` response permits new work. Missing, unavailable
   * or inconsistent readback throws and leaves the mailbox row unacknowledged.
   */
  async readCompleted(
    identity: Pick<InputPreparationCompletionRequest, 'requestId' | 'agentRef' | 'profileId' | 'policyRevision'>,
  ): Promise<InputPreparationCompletionRequest | undefined> {
    const url = new URL(byokInputPreparationStatusPath(identity.requestId), toHttpBase(this.options.serverUrl));
    url.searchParams.set('agentId', identity.agentRef.agentId);
    url.searchParams.set('profileRevision', identity.agentRef.profileRevision);
    let readback: InputPreparationReadback;
    try {
      readback = InputPreparationReadbackSchema.parse(await this.readStatus(url));
    } catch (cause) {
      if (cause instanceof InputPreparationCompletionError) throw cause;
      throw new InputPreparationCompletionError('input preparation status readback is invalid', { cause });
    }
    if (
      readback.tenantId !== this.options.tenantId ||
      readback.deviceId !== this.options.deviceId ||
      readback.requestId !== identity.requestId ||
      !sameAgentRef(readback.agentRef, identity.agentRef) ||
      readback.profileId !== identity.profileId ||
      readback.policyRevision !== identity.policyRevision
    ) {
      throw new InputPreparationCompletionError('input preparation status readback does not exactly match the authenticated request');
    }
    if (readback.status === 'pending') return undefined;
    // The readback schema requires completedAt and exactly the corresponding
    // terminal payload. Project the recorded fact, never current local state.
    return InputPreparationCompletionRequestSchema.parse({
      ...identity,
      outcome: readback.status,
      ...(readback.status === 'prepared' ? { receipt: readback.receipt } : { reason: readback.reason }),
    });
  }

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
