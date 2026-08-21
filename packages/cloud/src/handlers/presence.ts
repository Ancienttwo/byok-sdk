import { isCoreError } from '@byok-sdk/core';
import { PresencePublishRequestSchema } from '@byok-sdk/protocol';
import type { Context } from 'hono';
import { appendActivityEvents, type ActivityBounds } from '../coordination';
import { ActivityAppendRequestSchema } from '../activity';
import { isCloudError } from '../errors';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';

export interface PresenceRouteDeps extends DeviceRouteDeps {
  readonly ttlMs: number;
  readonly minimumIntervalMs: number;
  readonly detailMaxBytes: number;
}

export interface ActivityRouteDeps extends DeviceRouteDeps {
  readonly bounds: ActivityBounds;
}

const PresenceBodySchema = PresencePublishRequestSchema;

export function presencePublishHandler(deps: PresenceRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const parsed = PresenceBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid presence body' }, 400);
    if (
      parsed.data.detail !== undefined &&
      new TextEncoder().encode(parsed.data.detail).length > deps.detailMaxBytes
    ) {
      return c.json({ error: 'presence detail too large' }, 413);
    }
    try {
      return c.json(
        await authenticated.stores.presence.publish({
          deviceId: authenticated.device.deviceId,
          level: parsed.data.level,
          ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
          ...(parsed.data.configuredToolsets === undefined
            ? {}
            : { configuredToolsets: parsed.data.configuredToolsets }),
          ...(parsed.data.clientVersion === undefined ? {} : { clientVersion: parsed.data.clientVersion }),
          ...(parsed.data.protocolVersions === undefined
            ? {}
            : { protocolVersions: parsed.data.protocolVersions }),
          ...(parsed.data.runtimes === undefined
            ? {}
            : {
                runtimes: parsed.data.runtimes.map(({ id, version, authPresent }) => ({
                  id,
                  ...(version === undefined ? {} : { version }),
                  ...(authPresent === undefined ? {} : { authPresent }),
                })),
              }),
          ttlMs: deps.ttlMs,
          minimumIntervalMs: deps.minimumIntervalMs,
        }),
        200,
      );
    } catch (caught) {
      if (isCoreError(caught, 'hint_rate_limited')) {
        return c.json({ error: caught.code }, 429);
      }
      throw caught;
    }
  };
}

export function activityAppendHandler(deps: ActivityRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const parsed = ActivityAppendRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid activity body' }, 400);
    try {
      return c.json(
        await appendActivityEvents(authenticated.stores.activity, parsed.data, deps.bounds),
        200,
      );
    } catch (caught) {
      if (isCloudError(caught, 'activity_batch_too_large')) {
        return c.json({ error: caught.code }, 413);
      }
      if (isCloudError(caught, 'coordination_input_invalid')) {
        return c.json({ error: caught.code }, 400);
      }
      throw caught;
    }
  };
}
