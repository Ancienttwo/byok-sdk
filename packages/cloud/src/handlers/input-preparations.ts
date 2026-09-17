/** Device-authenticated completion and readback for remote input preparations. */
import type { Context } from 'hono';
import {
  InputPreparationCompletionRequestSchema,
  InputPreparationStatusQuerySchema,
  type InputPreparationCompletionRequest,
  type InputPreparationReadback,
} from '@byok-sdk/protocol';
import { isCloudError } from '../errors';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';
import type { TenantStores } from '../tenant-stores';

export interface InputPreparationRouteDeps extends DeviceRouteDeps {
  readonly complete: (
    stores: TenantStores,
    deviceId: string,
    receipt: InputPreparationCompletionRequest,
  ) => Promise<InputPreparationReadback>;
  readonly status: (
    stores: TenantStores,
    deviceId: string,
    input: { readonly requestId: string; readonly agentRef: { readonly agentId: string; readonly profileRevision: string } },
  ) => Promise<InputPreparationReadback | undefined>;
}

/**
 * Both handlers map this surface's codes onto HTTP with the same table the
 * Agent-home pair uses, minus `agent_capability_missing`: neither route here
 * can raise it. Admission is `enqueueInputPreparation`'s job, the completion
 * deliberately asserts no capability (see `completeInputPreparationFromStores`)
 * and the status readback never asserted one, so the code is unreachable on
 * this surface rather than merely unused.
 */
function mapCloudError(c: Context, error: unknown): Response {
  if (isCloudError(error, 'input_preparation_request_not_found')) {
    return c.json({ error: error.code }, 404);
  }
  if (
    isCloudError(error, 'input_preparation_receipt_mismatch') ||
    isCloudError(error, 'input_preparation_receipt_invalid')
  ) {
    return c.json({ error: error.code }, 422);
  }
  if (
    isCloudError(error, 'input_preparation_request_conflict') ||
    isCloudError(error, 'input_preparation_completion_conflict')
  ) {
    return c.json({ error: error.code }, 409);
  }
  throw error;
}

export function inputPreparationCompletionHandler(deps: InputPreparationRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const parsed = InputPreparationCompletionRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid input preparation completion' }, 422);
    const requestId = c.req.param('requestId');
    if (requestId === undefined || requestId !== parsed.data.requestId) {
      return c.json({ error: 'input_preparation_receipt_mismatch' }, 422);
    }

    try {
      return c.json(
        await deps.complete(authenticated.stores, authenticated.device.deviceId, parsed.data),
        200,
      );
    } catch (error) {
      return mapCloudError(c, error);
    }
  };
}

export function inputPreparationStatusHandler(deps: InputPreparationRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const requestId = c.req.param('requestId');
    if (requestId === undefined || requestId.length === 0) {
      return c.json({ error: 'invalid input preparation request id' }, 422);
    }
    // The key is `(deviceId, agentRef, requestId)`. `deviceId` comes from
    // bearer auth alone, so a caller can only ever read back its OWN device's
    // preparations however it spells the query.
    const query = InputPreparationStatusQuerySchema.safeParse({
      agentId: c.req.query('agentId'),
      profileRevision: c.req.query('profileRevision'),
    });
    if (!query.success) return c.json({ error: 'invalid input preparation status query' }, 422);

    try {
      const readback = await deps.status(authenticated.stores, authenticated.device.deviceId, {
        requestId,
        agentRef: { agentId: query.data.agentId, profileRevision: query.data.profileRevision },
      });
      if (readback === undefined) return c.json({ error: 'input_preparation_request_not_found' }, 404);
      return c.json(readback, 200);
    } catch (error) {
      return mapCloudError(c, error);
    }
  };
}
