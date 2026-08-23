/** Device-authenticated exact completion readback for task-free Agent-home projections. */
import type { Context } from 'hono';
import {
  AgentHomeProjectionCompletionRequestSchema,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionReadback,
} from '@byok-sdk/protocol';
import { isCloudError } from '../errors';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';
import type { TenantStores } from '../tenant-stores';

export interface AgentHomeProjectionRouteDeps extends DeviceRouteDeps {
  readonly complete: (
    stores: TenantStores,
    deviceId: string,
    receipt: AgentHomeProjectionCompletionRequest,
  ) => Promise<AgentHomeProjectionReadback>;
}

export function agentHomeProjectionCompletionHandler(deps: AgentHomeProjectionRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const parsed = AgentHomeProjectionCompletionRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid Agent-home projection completion' }, 422);
    const requestId = c.req.param('requestId');
    if (requestId === undefined || requestId !== parsed.data.requestId) {
      return c.json({ error: 'agent_home_projection_receipt_mismatch' }, 422);
    }

    try {
      return c.json(
        await deps.complete(authenticated.stores, authenticated.device.deviceId, parsed.data),
        200,
      );
    } catch (error) {
      if (isCloudError(error, 'agent_home_projection_request_not_found')) {
        return c.json({ error: error.code }, 404);
      }
      if (
        isCloudError(error, 'agent_home_projection_receipt_mismatch') ||
        isCloudError(error, 'agent_home_projection_receipt_invalid')
      ) {
        return c.json({ error: error.code }, 422);
      }
      if (
        isCloudError(error, 'agent_home_projection_request_conflict') ||
        isCloudError(error, 'agent_home_projection_completion_conflict') ||
        isCloudError(error, 'agent_capability_missing')
      ) {
        return c.json({ error: error.code }, 409);
      }
      throw error;
    }
  };
}
