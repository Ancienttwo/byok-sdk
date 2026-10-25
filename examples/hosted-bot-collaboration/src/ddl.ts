import { LISTS, MAPS, ROOM_MESSAGE } from './layout';

/**
 * The H store version (#793 O3). A store refuses a scope row of any version it does not support, under
 * the scope lock and before any write (#798 Q4). It is not the `CollaborationState.version` literal.
 */
export const STORE_VERSION = 2;
export const SUPPORTED_STORE_VERSIONS: ReadonlySet<number> = new Set([STORE_VERSION]);

const names = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ');

/**
 * The example's own tables (#793 D2a). The SDK tables stay under the SDK migrations. The statements are
 * unqualified: the store runs them with `search_path` set to its own schema.
 * Scopes and keys hold `JSON.stringify(value)` (#793 O4). Bodies are `json`, so the stored text keeps its bytes (#793 O1).
 * `ordinal` is the insertion order of a row in its kind (#793 O2). It is set once and never changes.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS scope (
  scope          text    PRIMARY KEY,
  state_version  integer NOT NULL CHECK (state_version >= 2),
  -- The state with each map emptied and each list cleared: the scalars (revision, sequence,
  -- team.external), the key order and which optional fields exist. It does not grow with history.
  frame          json    NOT NULL,
  -- The earliest time that the K8 rule \`collaborationDue\` gives for this scope's state, or NULL for none. Each store
  -- transaction writes it from the state that it commits.
  due_at         bigint  CHECK (due_at >= 0),
  -- The due scheduler's backoff (#794 H1): no pass syncs the scope before this time. It holds only for the due time it
  -- was set on: the write that moves \`due_at\` clears it.
  retry_at       bigint  CHECK (retry_at >= 0)
);
CREATE INDEX IF NOT EXISTS scope_due ON scope (due_at, scope) WHERE due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS entity (
  scope    text   NOT NULL REFERENCES scope (scope),
  kind     text   NOT NULL CHECK (kind IN (${names(MAPS.map(([kind]) => kind))})),
  key      text   NOT NULL,
  ordinal  bigint NOT NULL CHECK (ordinal >= 0),
  body     json   NOT NULL,
  PRIMARY KEY (scope, kind, key),
  UNIQUE (scope, kind, ordinal)
);
CREATE TABLE IF NOT EXISTS entry (
  scope     text   NOT NULL REFERENCES scope (scope),
  kind      text   NOT NULL CHECK (kind IN (${names([...LISTS.map(([kind]) => kind), ROOM_MESSAGE])})),
  -- '' for a state list; the room key for a room message.
  owner     text   NOT NULL,
  position  bigint NOT NULL CHECK (position >= 0),
  body      json   NOT NULL,
  PRIMARY KEY (scope, kind, owner, position)
);
CREATE TABLE IF NOT EXISTS command (
  scope     text   NOT NULL REFERENCES scope (scope),
  key       text   NOT NULL,
  ordinal   bigint NOT NULL CHECK (ordinal >= 0),
  evidence  text   NOT NULL,
  result    json   NOT NULL,
  root      text,
  PRIMARY KEY (scope, key),
  UNIQUE (scope, ordinal)
);
CREATE TABLE IF NOT EXISTS outbox (
  scope       text    NOT NULL REFERENCES scope (scope),
  key         text    NOT NULL,
  ordinal     bigint  NOT NULL CHECK (ordinal >= 0),
  kind        text    NOT NULL CHECK (kind IN ('projection', 'delivery', 'card', 'home', 'host_job')),
  -- The projection value. NULL for every other kind: the K8 entity or the occurrence is the content.
  body        json,
  -- The earliest time the sender looks at the row again: 0 when new, a lease while a send or call is in flight, then a
  -- backoff. For a delivery or a home operation it is an index only: the entity decides what to send.
  next_at     bigint  NOT NULL DEFAULT 0 CHECK (next_at >= 0),
  -- Projection send tries, connector call tries and Host job tries. Each try raises it under the scope lock before the
  -- call, and the settle write is fenced by it. Always 0 for a delivery and a home operation: their entity is the fence.
  tries       integer NOT NULL DEFAULT 0 CHECK (tries >= 0),
  last_error  text,
  -- Set once: the receiver confirmed the projection, the delivery reached 'accepted' or 'rejected', the card has its
  -- result or error, the home operation is 'applied' or 'failed', or the Host job concluded its occurrence.
  settled_at  bigint  CHECK (settled_at >= 0),
  CHECK ((kind = 'projection') = (body IS NOT NULL)),
  CHECK (kind IN ('projection', 'card', 'host_job') OR (tries = 0 AND last_error IS NULL)),
  PRIMARY KEY (scope, key),
  UNIQUE (scope, ordinal)
);
-- The sender scan: unsettled rows by due time, across scopes.
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_at, scope, ordinal) WHERE settled_at IS NULL;
-- One row per Turn intent (#793 D2b) or Host intent (#955). Only operator intent compaction deletes a row (#793 S8), and it
-- writes the permanent intent tombstone (kind 'intent', hash(key)) in retired_identity in the same transaction: a row
-- deleted without it would let the same key freeze again under the same task id.
CREATE TABLE IF NOT EXISTS intent (
  scope          text    NOT NULL REFERENCES scope (scope),
  -- JSON.stringify(turn id), or of the Host intent key: one intent per key.
  key            text    NOT NULL,
  -- K4 taskId(turn id, 0). It is never updated.
  task_id        text    NOT NULL,
  -- The FIFO order, the K4 sequence.
  ordinal        bigint  NOT NULL CHECK (ordinal >= 0),
  -- K4 agentKey(scope, execution): one FIFO for each scope, device and Agent.
  agent          text    NOT NULL,
  -- K4 IntentInput.source, part of the intent identity. A promoted routine occurrence is an H intent with source 'routine'.
  source         text    NOT NULL CHECK (source IN ('user', 'bot', 'routine')),
  -- The Host intent handler name (#955). NULL for a Turn intent. Part of the intent identity.
  handler        text,
  -- K4 Intent.retryUntil: a superseded routine version stops its intent early (K4 routines.ts:162, :177, :193).
  retry_until    bigint  CHECK (retry_until >= 0),
  -- The frozen AgentExecutionInput.
  input          json    NOT NULL,
  wait_until     bigint  NOT NULL CHECK (wait_until >= 0),
  submission     text    NOT NULL CHECK (submission IN ('reserved', 'uncertain', 'delivered')),
  -- Submit tries. A row with tries = 0 never reached the SDK. Each try raises it, and every write
  -- after the SDK call is fenced with WHERE tries = $mine AND submission <> 'delivered'.
  tries          integer NOT NULL DEFAULT 0 CHECK (tries >= 0),
  -- The earliest time of the next submit try: a lease while a submitter is in flight, then a backoff.
  next_at        bigint  NOT NULL DEFAULT 0 CHECK (next_at >= 0),
  -- The last failed submit try, then the last refused terminal of a delivered row: '<code>: <message>' (#955).
  last_error     text,
  cancel_reason  text    CHECK (cancel_reason IN ('expired', 'cancelled')),
  conclusion     text    CHECK (conclusion IN ('succeeded', 'failed', 'declined', 'cancelled', 'expired', 'superseded')),
  -- K4 Execution.started: the SDK attempt has claimedRuntime or ownerDeviceId.
  started        boolean NOT NULL DEFAULT false,
  -- The last SDK attempt and the device terminal that the reconciliation read.
  attempt        json,
  terminal       json,
  -- The earliest time of the next readback (readDeviceTerminal, readTaskAttempt).
  reconcile_at   bigint  NOT NULL DEFAULT 0 CHECK (reconcile_at >= 0),
  CONSTRAINT intent_input_task CHECK ((input ->> 'taskId') = task_id),
  -- Pins task_id to K4 taskId(turn id, 0) = sha256(canonical([turn id, 0])); key is JSON.stringify(turn id).
  CONSTRAINT intent_stable_task CHECK (task_id = encode(sha256(convert_to('[' || key || ',0]', 'UTF8')), 'hex')),
  PRIMARY KEY (scope, key),
  UNIQUE (scope, task_id),
  UNIQUE (scope, ordinal)
);
-- The FIFO head and the reconciliation read only unsettled rows.
CREATE INDEX IF NOT EXISTS intent_unsettled ON intent (scope, agent, ordinal) WHERE conclusion IS NULL;
-- The submit scan: unsettled, not delivered and not cancelled.
CREATE INDEX IF NOT EXISTS intent_due ON intent (next_at) WHERE conclusion IS NULL AND submission <> 'delivered' AND cancel_reason IS NULL;
-- The paged reconciliation scan: every tried row that has no conclusion, across scopes (#793 D2d).
CREATE INDEX IF NOT EXISTS intent_reconcile ON intent (reconcile_at, scope, key) WHERE conclusion IS NULL AND submission <> 'reserved';
CREATE TABLE IF NOT EXISTS device_binding (
  scope          text    NOT NULL REFERENCES scope (scope),
  -- JSON.stringify(device id).
  device         text    NOT NULL,
  ordinal        bigint  NOT NULL CHECK (ordinal >= 0),
  -- §4.1 record shape: the mode that owns the device's orchestration. A device with no row is in the default mode L.
  mode           text    NOT NULL CHECK (mode IN ('L', 'H')),
  -- The owner revision. Every write that can create execution checks it, and each switch step raises it (#957).
  mode_revision  bigint  NOT NULL CHECK (mode_revision >= 1),
  -- Set once by revoke, in the same write that raises mode_revision. The row is kept as the tombstone.
  revoked_at     bigint  CHECK (revoked_at >= 0),
  -- The target mode while an owner switch is open (§4.1, #957): the old owner is frozen. NULL when no switch is open.
  switching      text    CHECK (switching IN ('L', 'H')),
  CHECK (switching IS NULL OR switching <> mode),
  PRIMARY KEY (scope, device),
  UNIQUE (scope, ordinal)
);
CREATE TABLE IF NOT EXISTS routine (
  scope            text    NOT NULL REFERENCES scope (scope),
  -- JSON.stringify(routine id).
  id               text    NOT NULL,
  -- Insertion order. L passes the routines in this order into the frozen instruction and the schema routine ids.
  ordinal          bigint  NOT NULL CHECK (ordinal >= 0),
  definition       json    NOT NULL,
  -- The staged next version (updateRoutine). It replaces \`definition\` when the switch is due.
  pending          json,
  lifecycle        text    NOT NULL CHECK (lifecycle IN ('active', 'paused', 'completed')),
  -- Computed with the K4 nextWake rule (K4 routines.ts:28-37). It reaches the ContextPack.
  status           text    NOT NULL CHECK (status IN ('ok', 'schedule_retrying', 'no_occurrence_within_horizon', 'calendar_error')),
  -- The next planned slot time. NULL: no slot within the horizon.
  next_at          bigint  CHECK (next_at >= 0),
  calendar_errors  json,
  -- The routine scheduler's backoff after a fenced or failed fire (#794 H1): no pass fires the routine before this time.
  -- It holds only for the slot it was set on: the write that moves \`next_at\` clears it.
  retry_at         bigint  CHECK (retry_at >= 0),
  PRIMARY KEY (scope, id),
  UNIQUE (scope, ordinal)
);
CREATE INDEX IF NOT EXISTS routine_due ON routine (next_at) WHERE lifecycle = 'active' AND next_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS occurrence (
  scope                text    NOT NULL REFERENCES scope (scope),
  -- The JSON text of the K4 occurrence key, a SHA-256 hex digest. Its intent key is always \`occurrence:<key>\` (K4 routines.ts:174, :188).
  key                  text    NOT NULL,
  ordinal              bigint  NOT NULL CHECK (ordinal >= 0),
  routine_id           text    NOT NULL,
  definition_version   integer NOT NULL CHECK (definition_version >= 1),
  trigger_kind         text    NOT NULL CHECK (trigger_kind IN ('scheduled', 'catch_up')),
  planned_at           bigint  NOT NULL CHECK (planned_at >= 0),
  recorded_at          bigint  NOT NULL CHECK (recorded_at >= 0),
  next_at              bigint  CHECK (next_at >= 0),
  -- K4 hook.executionSuperseded.
  execution_superseded boolean NOT NULL DEFAULT false,
  -- K4 occurrence.job without its attempts (outbox.tries counts them): {} while pending, { summary } once done.
  -- NULL for a Bot routine occurrence.
  job                  json,
  -- Only for an occurrence that the Host concludes with no intent. A promoted occurrence reads its intent's conclusion.
  conclusion           text    CHECK (conclusion IN ('succeeded', 'failed', 'declined', 'cancelled', 'expired', 'superseded')),
  PRIMARY KEY (scope, key),
  UNIQUE (scope, ordinal),
  -- The replay guard of one slot, in place of the K4 \`slots\` map (K4 routines.ts:125, :180).
  UNIQUE (scope, routine_id, definition_version, planned_at),
  FOREIGN KEY (scope, routine_id) REFERENCES routine (scope, id)
);
CREATE INDEX IF NOT EXISTS occurrence_open ON occurrence (scope, routine_id) WHERE conclusion IS NULL;
-- Tombstones in the K4 scheme (K4 host_retired_identity, #975), so an owner switch moves them as they are.
CREATE TABLE IF NOT EXISTS retired_identity (
  scope       text   NOT NULL REFERENCES scope (scope),
  -- 'row': a K8 row that retention retired. 'intent': a compacted intent (#793 S8). 'slot' and 'application': K4's routine
  -- slot and applied outcome tombstones, which H itself never writes.
  kind        text   NOT NULL CHECK (kind IN ('row', 'intent', 'slot', 'application')),
  -- A K4 digest: hash([namespace, id]) for a row, hash(key) (the K4 intent id) for an intent.
  identity    text   NOT NULL,
  -- NULL: permanent. Every tombstone H writes is permanent.
  expires_at  bigint CHECK (expires_at >= 0),
  PRIMARY KEY (scope, kind, identity)
);
CREATE TABLE IF NOT EXISTS archived_row (
  scope       text   NOT NULL REFERENCES scope (scope),
  namespace   text   NOT NULL,
  -- JSON.stringify(row id). Code checks the K4 namespace and id limits (K4 ledger.ts:52-58) on the raw values.
  id          text   NOT NULL,
  body        json   NOT NULL,
  expires_at  bigint CHECK (expires_at >= 0),
  PRIMARY KEY (scope, namespace, id)
);
CREATE INDEX IF NOT EXISTS archived_row_expiry ON archived_row (scope, namespace, expires_at) WHERE expires_at IS NOT NULL;
`;
