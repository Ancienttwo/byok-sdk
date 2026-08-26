/** Device-authenticated write route for the optional one-way hosted memory projection. */
import type { Context } from 'hono';
import {
  AgentMemoryProjectionCommitRequestSchema,
  agentMemoryProjectionBase64UrlByteLength,
  type AgentMemoryProjectionCommitResponse,
} from '@byok-sdk/protocol';
import { base64UrlDecode } from '../crypto/web-crypto';
import { isCloudError } from '../errors';
import { authenticateDevice, readBoundedJsonBody, type DeviceRouteDeps } from './shared';
import type { TenantStores } from '../tenant-stores';

/**
 * The protocol's 512 KiB redacted ceiling encodes to about 700 KiB of
 * base64url. A finite 1 MiB request ceiling leaves room for the bounded JSON
 * envelope and rejects oversized input before JSON.parse allocates it.
 */
export const DEFAULT_MAX_AGENT_MEMORY_PROJECTION_REQUEST_BYTES = 1 * 1024 * 1024;

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

    const body = await readBoundedJsonBody(c, DEFAULT_MAX_AGENT_MEMORY_PROJECTION_REQUEST_BYTES);
    if (body.tooLarge) return c.json({ error: 'Agent-memory projection request body too large' }, 413);
    const parsed = AgentMemoryProjectionCommitRequestSchema.safeParse(body.body);
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
