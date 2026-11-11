import { DatabaseSync } from 'node:sqlite';
import type { BotProfile, BotRow, Roster, TranscriptEntry, TurnProjection, TurnRecord } from './types.ts';

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, persona TEXT NOT NULL, model TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL) STRICT;
CREATE TABLE entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('input', 'reply', 'clear')),
  bot_id TEXT NOT NULL, action_id TEXT UNIQUE, text TEXT, turn_id TEXT, task_id TEXT UNIQUE, at INTEGER NOT NULL) STRICT;
CREATE TABLE turns (turn_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, root TEXT NOT NULL, seq INTEGER NOT NULL, projection TEXT NOT NULL,
  concluded INTEGER NOT NULL DEFAULT 0, retained INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX turns_bot ON turns (bot_id, seq);
INSERT INTO meta (key, value) VALUES ('schema', ${SCHEMA_VERSION}), ('team_revision', 0);
`;

/** A keyed command that was already committed with other arguments. Nothing changes. */
export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

interface EntryRow { seq: number; kind: string; bot_id: string; action_id: string | null; text: string | null; turn_id: string | null; task_id: string | null; at: number }
interface TurnRow { turn_id: string; bot_id: string; root: string; seq: number; projection: string; reply: string | null }

function entryOf(row: EntryRow): TranscriptEntry {
  const base = { seq: row.seq, botId: row.bot_id, at: row.at };
  if (row.kind === 'input') return { ...base, kind: 'input', actionId: row.action_id!, text: row.text!, ...(row.turn_id === null ? {} : { turnId: row.turn_id }) };
  if (row.kind === 'reply') return { ...base, kind: 'reply', turnId: row.turn_id!, taskId: row.task_id!, text: row.text! };
  return { ...base, kind: 'clear', actionId: row.action_id! };
}
function turnOf(row: TurnRow): TurnRecord {
  return { turnId: row.turn_id, botId: row.bot_id, root: row.root, seq: row.seq, projection: JSON.parse(row.projection) as TurnProjection,
    ...(row.reply === null ? {} : { reply: row.reply }) };
}

/**
 * The Host store (#1499 s1.4): the app's own SQLite with the roster and its revision, the transcript and the per-Bot
 * clear epochs. It is the team and history authority of K8 in `team: 'external'` mode. Every write is one transaction.
 */
export class HostStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /** Opens or creates the store. A store with another schema version is refused; there is no automatic repair. */
  static open(file: string, now: () => number = Date.now): HostStore {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const meta = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
      if (meta === undefined) db.exec(`BEGIN; ${SCHEMA} COMMIT;`);
      const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: number } | undefined;
      if (version?.value !== SCHEMA_VERSION) throw new Error(`Host store ${file} has schema ${String(version?.value)}; this Host reads ${SCHEMA_VERSION}`);
      return new HostStore(db, now);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private bumpRevision(to?: number): void {
    if (to === undefined) this.db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'team_revision'`).run();
    else this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'team_revision'`).run(to);
  }

  /** The current roster: what `applyTeam` sends. */
  roster(): Roster {
    const { value } = this.db.prepare(`SELECT value FROM meta WHERE key = 'team_revision'`).get() as { value: number };
    const bots = this.db.prepare(`SELECT id, name, role, persona, model FROM bots WHERE archived = 0 ORDER BY created, id`).all() as unknown as BotProfile[];
    return { revision: value, bots: bots.map(bot => ({ ...bot })) };
  }

  /** Every Bot, archived ones included, for the UI. */
  bots(): BotRow[] {
    return (this.db.prepare(`SELECT id, name, role, persona, model, archived FROM bots ORDER BY created, id`).all() as unknown as Array<BotProfile & { archived: number }>)
      .map(row => ({ ...row, archived: row.archived === 1 }));
  }

  /**
   * Creates or edits a Bot and bumps the team revision. An archived Bot cannot be edited. An unchanged profile writes nothing.
   * `admit` sees the candidate roster and the Bot's prior profile before anything is written; a throw leaves the store unchanged.
   */
  saveBot(profile: BotProfile, admit: (candidate: Roster, prior: BotProfile | undefined) => void): Roster {
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT id, name, role, persona, model, archived FROM bots WHERE id = ?`).get(profile.id) as (BotProfile & { archived: number }) | undefined;
      if (prior?.archived === 1) throw new StoreConflictError(`Bot ${profile.id} is archived`);
      if (prior && prior.name === profile.name && prior.role === profile.role && prior.persona === profile.persona && prior.model === profile.model) return this.roster();
      const current = this.roster();
      const bots = prior ? current.bots.map(bot => bot.id === profile.id ? { ...profile } : bot) : [...current.bots, { ...profile }];
      admit({ revision: current.revision + 1, bots }, prior && { id: prior.id, name: prior.name, role: prior.role, persona: prior.persona, model: prior.model });
      this.db.prepare(`INSERT INTO bots (id, name, role, persona, model, created) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role, persona = excluded.persona, model = excluded.model`)
        .run(profile.id, profile.name, profile.role, profile.persona, profile.model, this.now());
      this.bumpRevision();
      return this.roster();
    });
  }

  /** Archives a Bot for good and bumps the team revision. Its transcript stays. */
  archiveBot(id: string): Roster {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT archived FROM bots WHERE id = ?`).get(id) as { archived: number } | undefined;
      if (!row) throw new StoreConflictError(`Unknown Bot ${id}`);
      if (row.archived === 1) return this.roster();
      this.db.prepare(`UPDATE bots SET archived = 1 WHERE id = ?`).run(id);
      this.bumpRevision();
      return this.roster();
    });
  }

  /**
   * K8 refused the store's roster as `stale_team`: its ledger holds a revision at or above this one. The store stays the
   * authority, so the same roster moves to the first revision above K8's.
   */
  raiseRevision(above: number): Roster {
    return this.transaction(() => {
      if (this.roster().revision <= above) this.bumpRevision(above + 1);
      return this.roster();
    });
  }

  private requireBot(botId: string): void {
    const row = this.db.prepare(`SELECT archived FROM bots WHERE id = ?`).get(botId) as { archived: number } | undefined;
    if (!row) throw new StoreConflictError(`Unknown Bot ${botId}`);
    if (row.archived === 1) throw new StoreConflictError(`Bot ${botId} is archived`);
  }

  /** Writes a user send keyed by its action id before K8 sees it. A retry with the same arguments returns the first entry. */
  recordInput(actionId: string, botId: string, text: string): Extract<TranscriptEntry, { kind: 'input' }> {
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT * FROM entries WHERE action_id = ?`).get(actionId) as EntryRow | undefined;
      if (prior) {
        if (prior.kind !== 'input' || prior.bot_id !== botId || prior.text !== text) throw new StoreConflictError(`Action ${actionId} was committed with other arguments`);
        return entryOf(prior) as Extract<TranscriptEntry, { kind: 'input' }>;
      }
      this.requireBot(botId);
      const row = this.db.prepare(`INSERT INTO entries (kind, bot_id, action_id, text, at) VALUES ('input', ?, ?, ?, ?) RETURNING *`)
        .get(botId, actionId, text, this.now()) as unknown as EntryRow;
      return entryOf(row) as Extract<TranscriptEntry, { kind: 'input' }>;
    });
  }

  /** Records the Turn that K8 committed for an input, and places that Turn at the input's position. */
  bindInput(actionId: string, turnId: string): void {
    this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM entries WHERE action_id = ? AND kind = 'input'`).get(actionId) as EntryRow | undefined;
      if (!row) throw new StoreConflictError(`Unknown input ${actionId}`);
      if (row.turn_id !== null && row.turn_id !== turnId) throw new StoreConflictError(`Input ${actionId} is bound to Turn ${row.turn_id}`);
      this.db.prepare(`UPDATE entries SET turn_id = ? WHERE seq = ?`).run(turnId, row.seq);
      this.db.prepare(`UPDATE turns SET seq = ? WHERE turn_id = ?`).run(row.seq, turnId);
    });
  }

  /** Inputs written to the transcript whose K8 commit is not recorded yet: a restart resolves them through `inputRoot`. */
  unboundInputs(): Array<Extract<TranscriptEntry, { kind: 'input' }>> {
    return (this.db.prepare(`SELECT * FROM entries WHERE kind = 'input' AND turn_id IS NULL ORDER BY seq`).all() as unknown as EntryRow[])
      .map(row => entryOf(row) as Extract<TranscriptEntry, { kind: 'input' }>);
  }

  /** Advances the Bot's context epoch. A retry with the same action id writes nothing. */
  recordClear(actionId: string, botId: string): void {
    this.transaction(() => {
      const prior = this.db.prepare(`SELECT kind, bot_id FROM entries WHERE action_id = ?`).get(actionId) as { kind: string; bot_id: string } | undefined;
      if (prior) {
        if (prior.kind !== 'clear' || prior.bot_id !== botId) throw new StoreConflictError(`Action ${actionId} was committed with other arguments`);
        return;
      }
      this.requireBot(botId);
      this.db.prepare(`INSERT INTO entries (kind, bot_id, action_id, at) VALUES ('clear', ?, ?, ?)`).run(botId, actionId, this.now());
    });
  }

  /**
   * Writes the latest projection of a Turn and, when given, its accepted reply in one transaction. A Turn first seen here
   * (not an input Turn) is placed after every entry so far. The reply is keyed by task id, so a replay writes it once.
   */
  recordTurn(projection: TurnProjection, reply?: { taskId: string; text: string }): void {
    this.transaction(() => {
      const seq = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM entries`).get() as { seq: number }).seq;
      const bound = this.db.prepare(`SELECT seq FROM entries WHERE kind = 'input' AND turn_id = ?`).get(projection.id) as { seq: number } | undefined;
      this.db.prepare(`INSERT INTO turns (turn_id, bot_id, root, seq, projection, concluded) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (turn_id) DO UPDATE SET projection = excluded.projection, concluded = excluded.concluded`)
        .run(projection.id, projection.botId, projection.root, bound?.seq ?? seq, JSON.stringify(projection), projection.conclusion === undefined ? 0 : 1);
      if (!reply) return;
      const prior = this.db.prepare(`SELECT turn_id, text FROM entries WHERE task_id = ?`).get(reply.taskId) as { turn_id: string; text: string } | undefined;
      if (prior) {
        if (prior.turn_id !== projection.id || prior.text !== reply.text) throw new StoreConflictError(`Reply of task ${reply.taskId} was written with another body`);
        return;
      }
      this.db.prepare(`INSERT INTO entries (kind, bot_id, text, turn_id, task_id, at) VALUES ('reply', ?, ?, ?, ?, ?)`)
        .run(projection.botId, reply.text, projection.id, reply.taskId, this.now());
    });
  }

  /** The Bot's whole transcript in commit order. The UI folds entries above the latest `clear`; nothing is deleted. */
  transcript(botId: string): TranscriptEntry[] {
    return (this.db.prepare(`SELECT * FROM entries WHERE bot_id = ? ORDER BY seq`).all(botId) as unknown as EntryRow[]).map(entryOf);
  }

  /** The Bot's Turns in transcript order. */
  turns(botId: string): TurnRecord[] {
    return (this.db.prepare(`SELECT t.*, e.text AS reply FROM turns t LEFT JOIN entries e ON e.kind = 'reply' AND e.turn_id = t.turn_id
      WHERE t.bot_id = ? ORDER BY t.seq, t.turn_id`).all(botId) as unknown as TurnRow[]).map(turnOf);
  }

  /** The Bot's ended Turns after its latest clear, oldest first, except `turnId`: the ContextPack history of `turnId`. */
  history(botId: string, turnId: string): TurnRecord[] {
    const epoch = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM entries WHERE bot_id = ? AND kind = 'clear'`).get(botId) as { seq: number }).seq;
    return this.turns(botId).filter(turn => turn.seq >= epoch && turn.turnId !== turnId && turn.projection.conclusion !== undefined);
  }

  /** Roots whose every recorded Turn ended and that K8 still holds: retention candidates. */
  retainableRoots(): string[] {
    return (this.db.prepare(`SELECT root FROM turns GROUP BY root HAVING MIN(concluded) = 1 AND MAX(retained) = 0 ORDER BY MIN(seq)`).all() as Array<{ root: string }>)
      .map(row => row.root);
  }

  markRetained(root: string): void {
    this.db.prepare(`UPDATE turns SET retained = 1 WHERE root = ?`).run(root);
  }
}
