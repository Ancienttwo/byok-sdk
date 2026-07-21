import { z } from 'zod';
import { MESSAGE_PAYLOAD_SCHEMAS, SERVER_TO_DAEMON_TYPES, type MessageType } from './messages';

const REQUIRED_TASK_ID = z.string().min(1);
const OPTIONAL_TASK_ID = REQUIRED_TASK_ID.optional();
const REQUIRED_SEQ = z.number().int();
const OPTIONAL_SEQ = REQUIRED_SEQ.optional();

/**
 * Build the full envelope schema for one message type. Field order here
 * matches the spec's documented shape (`v, id, ts, type, task_id?,
 * session_ref?, seq?, payload`) so parsed output has predictable key order.
 *
 * `taskId`/`seq` are passed in as concrete schemas (not a boolean flag)
 * so each call site's return type is precisely the required-or-optional
 * shape for that branch — `z.infer<typeof EnvelopeSchema>` then reflects the
 * per-message-type requiredness rather than collapsing it to `string |
 * undefined` for every branch.
 */
function envelopeShape<
  T extends MessageType,
  TaskId extends z.ZodTypeAny,
  Seq extends z.ZodTypeAny,
>(type: T, taskId: TaskId, seq: Seq) {
  return z.object({
    v: z.number().int(),
    id: z.uuid(),
    ts: z.iso.datetime({ offset: true }),
    type: z.literal(type),
    task_id: taskId,
    session_ref: z.string().optional(),
    seq,
    payload: MESSAGE_PAYLOAD_SCHEMAS[type],
  });
}

/**
 * The wire envelope: common transport fields plus a `payload` whose shape is
 * determined by `type`. Unknown top-level fields are tolerated (stripped) for
 * forward-compat; unknown `type` values do not match any branch below and are
 * handled explicitly by {@link parseMessage} in `codec.ts`.
 *
 * Two cross-cutting requiredness rules, fixed at M1 (see docs/protocol.md
 * "M0 -> M1 breaking changes"):
 *
 * - `task_id` is REQUIRED for every `task.*` type (they all route by task id)
 *   and stays optional for `conn.*` (M1 gap #1).
 * - `seq` is REQUIRED for every type the *server* sends to the daemon — a
 *   per-device monotonic counter used as a redelivery cursor — and stays
 *   optional for daemon -> server types (M1 redelivery cursor; see
 *   `conn.hello.cursor` in `messages.ts`).
 */
export const EnvelopeSchema = z.discriminatedUnion('type', [
  // conn.* — task_id stays optional (no task routing). conn.hello is
  // daemon -> server (no cursor to satisfy on this leg); conn.ack is
  // server -> daemon and therefore carries the required redelivery `seq`.
  envelopeShape('conn.hello', OPTIONAL_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('conn.ack', OPTIONAL_TASK_ID, REQUIRED_SEQ),

  // task.* server -> daemon: task_id required (routing key) + seq required
  // (per-device redelivery cursor).
  envelopeShape('task.offer', REQUIRED_TASK_ID, REQUIRED_SEQ),
  envelopeShape('task.approve', REQUIRED_TASK_ID, REQUIRED_SEQ),
  envelopeShape('task.reject', REQUIRED_TASK_ID, REQUIRED_SEQ),
  envelopeShape('task.cancel', REQUIRED_TASK_ID, REQUIRED_SEQ),
  envelopeShape('task.steer', REQUIRED_TASK_ID, REQUIRED_SEQ),

  // task.* daemon -> server: task_id required (routing key); envelope-level
  // seq is not required in this direction in M1 (no daemon->server
  // redelivery cursor yet — see docs/protocol.md).
  envelopeShape('task.claim', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.started', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.decline', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.progress', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.artifact', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.await_approval', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.complete', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.fail', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.cancelled', REQUIRED_TASK_ID, OPTIONAL_SEQ),
  envelopeShape('task.approval_resolved', REQUIRED_TASK_ID, OPTIONAL_SEQ),
]);

export type Envelope = z.infer<typeof EnvelopeSchema>;

/** `true` for every message type the server sends to the daemon (envelope `seq` is required for these). */
export function isServerToDaemonType(type: MessageType): boolean {
  return (SERVER_TO_DAEMON_TYPES as readonly MessageType[]).includes(type);
}
