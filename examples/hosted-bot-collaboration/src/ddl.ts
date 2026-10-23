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
  frame          json    NOT NULL
);
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
  scope     text   NOT NULL REFERENCES scope (scope),
  key       text   NOT NULL,
  ordinal   bigint NOT NULL CHECK (ordinal >= 0),
  kind      text   NOT NULL CHECK (kind IN ('projection', 'delivery')),
  -- The projection value. NULL for a delivery: its content is the delivery entity.
  body      json,
  CHECK ((kind = 'projection') = (body IS NOT NULL)),
  PRIMARY KEY (scope, key),
  UNIQUE (scope, ordinal)
);
-- One row per Turn intent (#793 D2b). No intent row is deleted before D2g adds tombstones:
-- a deleted row would let the same Turn freeze again under the same task id.
CREATE TABLE IF NOT EXISTS intent (
  scope          text    NOT NULL REFERENCES scope (scope),
  -- JSON.stringify(turn id): one intent per Turn.
  key            text    NOT NULL,
  -- K4 taskId(turn id, 0). It is never updated.
  task_id        text    NOT NULL,
  -- The FIFO order, the K4 sequence.
  ordinal        bigint  NOT NULL CHECK (ordinal >= 0),
  -- K4 agentKey(scope, execution): one FIFO for each scope, device and Agent.
  agent          text    NOT NULL,
  -- K4 IntentInput.source, part of the intent identity. A routine occurrence is not an H intent before D2f.
  source         text    NOT NULL CHECK (source IN ('user', 'bot')),
  -- The frozen AgentExecutionInput.
  input          json    NOT NULL,
  wait_until     bigint  NOT NULL CHECK (wait_until >= 0),
  submission     text    NOT NULL CHECK (submission IN ('reserved', 'uncertain', 'delivered')),
  -- Submit tries. A row with tries = 0 never reached the SDK. Each try raises it, and every write
  -- after the SDK call is fenced with WHERE tries = $mine AND submission <> 'delivered'.
  tries          integer NOT NULL DEFAULT 0 CHECK (tries >= 0),
  -- The earliest time of the next submit try: a lease while a submitter is in flight, then a backoff.
  next_at        bigint  NOT NULL DEFAULT 0 CHECK (next_at >= 0),
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
`;
