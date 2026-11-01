/**
 * Rewinds a v8 file to v7, the schema this build upgrades in place: v7 had no
 * activity log and no output closure, and its approval timeline carried an
 * idle deadline on every row. Each retained row gets `idleExpiresAt`.
 */
export function rewindToV7(idleExpiresAt: string): string {
  return `DROP TRIGGER task_output_closed; DROP TABLE activity_log_entry; DROP TABLE activity_log_head;
    ALTER TABLE approval_timeline_tail RENAME TO approval_timeline_tail_v8;
    DROP INDEX approval_timeline_expiry;
    CREATE TABLE approval_timeline_tail (
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      entries_json TEXT NOT NULL,
      next_revision INTEGER NOT NULL CHECK (next_revision > 0),
      dropped INTEGER NOT NULL CHECK (dropped >= 0),
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      expires_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, task_id)
    );
    CREATE INDEX approval_timeline_expiry ON approval_timeline_tail (tenant_id, expires_at, task_id);
    INSERT INTO approval_timeline_tail SELECT tenant_id, task_id, entries_json, next_revision, dropped, capacity, '${idleExpiresAt}'
      FROM approval_timeline_tail_v8 WHERE entries_json <> '[]';
    DROP TABLE approval_timeline_tail_v8;
    UPDATE byok_sqlite_meta SET value = '7' WHERE key = 'schema_version';`;
}
