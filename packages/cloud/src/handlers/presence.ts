import { isCoreError } from '@byok-sdk/core';
import { PresencePublishRequestSchema } from '@byok-sdk/protocol';
import type { Context } from 'hono';
import { appendActivityEvents, type ActivityBounds } from '../coordination';
import { ActivityAppendRequestSchema } from '../activity';
import { isCloudError } from '../errors';
import { admitDeviceRequest, readBoundedJsonBody, type DeviceRouteDeps } from './shared';

export interface PresenceRouteDeps extends DeviceRouteDeps {
  readonly ttlMs: number;
  readonly minimumIntervalMs: number;
  readonly detailMaxBytes: number;
}

export interface ActivityRouteDeps extends DeviceRouteDeps {
  readonly bounds: ActivityBounds;
}

const PresenceBodySchema = PresencePublishRequestSchema;

/** Everything in a presence body besides `detail` (runtimes, toolsets, versions). */
export const PRESENCE_FIXED_FIELDS_MAX_BYTES = 64 * 1024;

/** An activity body's ids and counters around its `events` array. */
export const ACTIVITY_ENVELOPE_MAX_BYTES = 16 * 1024;

export function presencePublishHandler(deps: PresenceRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await admitDeviceRequest(c, deps);
    if (authenticated instanceof Response) return authenticated;
    const body = await readBoundedJsonBody(c, deps.detailMaxBytes + PRESENCE_FIXED_FIELDS_MAX_BYTES);
    if (body.tooLarge) return c.json({ error: 'request body too large' }, 413);
    const parsed = PresenceBodySchema.safeParse(body.body);
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
    const authenticated = await admitDeviceRequest(c, deps);
    if (authenticated instanceof Response) return authenticated;
    const body = await readBoundedJsonBody(c, deps.bounds.maxBytes + ACTIVITY_ENVELOPE_MAX_BYTES);
    if (body.tooLarge) return c.json({ error: 'request body too large' }, 413);
    const parsed = ActivityAppendRequestSchema.safeParse(body.body);
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
