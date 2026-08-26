/** Device-authenticated write route for the optional one-way hosted memory projection. */
import type { Context } from 'hono';
import {
  AgentMemoryProjectionCommitRequestSchema,
  agentMemoryProjectionBase64UrlByteLength,
  type AgentMemoryProjectionCommitResponse,
} from '@byok-sdk/protocol';
import { base64UrlDecode } from '../crypto/web-crypto';
import { isCloudError } from '../errors';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';
import type { TenantStores } from '../tenant-stores';

export interface AgentMemoryProjectionRouteDeps extends DeviceRouteDeps {
  readonly commit: (
    stores: TenantStores,
    deviceId: string,
    mutation: import('@byok-sdk/protocol').AgentMemoryProjectionCommitRequest,
    redactedBytes: Uint8Array,
  ) => Promise<AgentMemoryProjectionCommitResponse>;
}

export function agentMemoryProjectionHandler(deps: AgentMemoryProjectionRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const parsed = AgentMemoryProjectionCommitRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid Agent-memory projection mutation' }, 422);
    // The schema rejects non-canonical encodings. Decode remains explicit so a
    // handler can never hand a different byte sequence to the hashing store.
    if (agentMemoryProjectionBase64UrlByteLength(parsed.data.snapshot.redactedBytes) === undefined) {
      return c.json({ error: 'invalid Agent-memory projection mutation' }, 422);
    }

    const decoded = base64UrlDecode(parsed.data.snapshot.redactedBytes);
    if (decoded === undefined || decoded.byteLength !== parsed.data.snapshot.redactedByteCount) {
      return c.json({ error: 'invalid Agent-memory projection mutation' }, 422);
    }

    try {
      return c.json(
        await deps.commit(authenticated.stores, authenticated.device.deviceId, parsed.data, decoded),
        200,
      );
    } catch (error) {
      if (
        isCloudError(error, 'agent_memory_projection_authorization_denied') ||
        isCloudError(error, 'agent_memory_projection_task_mismatch') ||
        isCloudError(error, 'agent_memory_projection_replay_mismatch') ||
        isCloudError(error, 'agent_memory_projection_stale_epoch') ||
        isCloudError(error, 'agent_memory_projection_erased_epoch') ||
        isCloudError(error, 'agent_memory_projection_epoch_exhausted') ||
        isCloudError(error, 'agent_memory_projection_sequence_gap')
      ) return c.json({ error: error.code }, 409);
      if (isCloudError(error, 'agent_memory_projection_hash_mismatch')) {
        return c.json({ error: error.code }, 422);
      }
      throw error;
    }
  };
}
