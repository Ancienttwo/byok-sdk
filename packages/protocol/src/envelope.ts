import { z } from 'zod';
import { MESSAGE_PAYLOAD_SCHEMAS, type MessageType } from './messages';

/**
 * Build the full envelope schema for one message type. Field order here
 * matches the spec's documented shape (`v, id, ts, type, task_id?,
 * session_ref?, seq?, payload`) so parsed output has predictable key order.
 */
function envelopeFor<T extends MessageType>(type: T) {
  return z.object({
    v: z.number().int(),
    id: z.uuid(),
    ts: z.iso.datetime({ offset: true }),
    type: z.literal(type),
    task_id: z.string().optional(),
    session_ref: z.string().optional(),
    seq: z.number().int().optional(),
    payload: MESSAGE_PAYLOAD_SCHEMAS[type],
  });
}

/**
 * The wire envelope: common transport fields plus a `payload` whose shape is
 * determined by `type`. Unknown top-level fields are tolerated (stripped) for
 * forward-compat; unknown `type` values do not match any branch below and are
 * handled explicitly by {@link parseMessage} in `codec.ts`.
 */
export const EnvelopeSchema = z.discriminatedUnion('type', [
  envelopeFor('conn.hello'),
  envelopeFor('conn.ack'),
  envelopeFor('task.offer'),
  envelopeFor('task.approve'),
  envelopeFor('task.reject'),
  envelopeFor('task.cancel'),
  envelopeFor('task.steer'),
  envelopeFor('task.claim'),
  envelopeFor('task.progress'),
  envelopeFor('task.artifact'),
  envelopeFor('task.await_approval'),
  envelopeFor('task.complete'),
  envelopeFor('task.fail'),
]);

export type Envelope = z.infer<typeof EnvelopeSchema>;
