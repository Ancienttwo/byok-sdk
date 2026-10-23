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
`;
