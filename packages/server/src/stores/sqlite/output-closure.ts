import { ACTIVITY_TERMINAL_TTL_MS, DEFAULT_APPROVAL_TIMELINE_CAPACITY, DEFAULT_APPROVAL_TIMELINE_TTL_MS } from '@byok-sdk/cloud';

/** The instant a task stops admitting output: its first terminal, or an accepted Host cancellation. */
const CLOSED_AT = (row: string) => `COALESCE(${row}.terminal_at, ${row}.cancellation_requested_at)`;
const DEADLINE = (at: string, ttlMs: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, printf('+%.3f seconds', ${ttlMs} / 1000.0))`;
const APPROVAL_TTL = String(DEFAULT_APPROVAL_TIMELINE_TTL_MS);
const EMPTY_APPROVALS = `'[]', 1, 0, ${DEFAULT_APPROVAL_TIMELINE_CAPACITY}`;

export const OUTPUT_CLOSURE_TRIGGER_NAME = 'task_output_closed';

/**
 * Whichever store writes it, the attempt update that first closes a task's
 * output closes the task's activity log and approval timeline in the same
 * transaction: admission ends and their deadlines are frozen (#1113 A3). Each
 * gets a closed row even when the task recorded nothing, so a later append is
 * refused too.
 */
export const OUTPUT_CLOSURE_TRIGGER = `
CREATE TRIGGER ${OUTPUT_CLOSURE_TRIGGER_NAME}
AFTER UPDATE OF status, terminal_at, cancellation_requested_at ON task_attempt
WHEN ${CLOSED_AT('OLD')} IS NULL AND ${CLOSED_AT('NEW')} IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO activity_log_head (tenant_id, task_id, generation) VALUES (NEW.tenant_id, NEW.task_id, lower(hex(randomblob(16))));
  UPDATE activity_log_head SET terminal_at = ${CLOSED_AT('NEW')}, expires_at = ${DEADLINE(CLOSED_AT('NEW'), 'ttl_ms')}
  WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id AND terminal_at IS NULL AND removed = 0;
  INSERT OR IGNORE INTO approval_timeline_tail (tenant_id, task_id, entries_json, next_revision, dropped, capacity)
  VALUES (NEW.tenant_id, NEW.task_id, ${EMPTY_APPROVALS});
  UPDATE approval_timeline_tail SET terminal_at = ${CLOSED_AT('NEW')}, expires_at = ${DEADLINE(CLOSED_AT('NEW'), APPROVAL_TTL)}
  WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id AND terminal_at IS NULL;
END;`;

const CLOSED_TASKS = `SELECT tenant_id, task_id, COALESCE(terminal_at, cancellation_requested_at,
  CASE WHEN status IN ('complete', 'failed', 'cancelled') THEN updated_at END) AS closed_at FROM task_attempt`;

/**
 * Runs once, in the open that creates the v8 schema: a task whose output
 * closed before it gets closed rows at its original deadlines, never a new
 * ten minutes. A terminal task from before terminal_at was recorded closes at
 * its last update.
 */
export const OUTPUT_CLOSURE_BACKFILL = `
INSERT OR IGNORE INTO activity_log_head (tenant_id, task_id, generation, terminal_at, expires_at)
SELECT tenant_id, task_id, lower(hex(randomblob(16))), closed_at, ${DEADLINE('closed_at', String(ACTIVITY_TERMINAL_TTL_MS))}
FROM (${CLOSED_TASKS}) WHERE closed_at IS NOT NULL;
INSERT OR IGNORE INTO approval_timeline_tail (tenant_id, task_id, entries_json, next_revision, dropped, capacity)
SELECT tenant_id, task_id, ${EMPTY_APPROVALS} FROM (${CLOSED_TASKS}) WHERE closed_at IS NOT NULL;
UPDATE approval_timeline_tail AS tail SET terminal_at = closed.closed_at, expires_at = ${DEADLINE('closed.closed_at', APPROVAL_TTL)}
FROM (${CLOSED_TASKS}) AS closed
WHERE tail.tenant_id = closed.tenant_id AND tail.task_id = closed.task_id AND closed.closed_at IS NOT NULL AND tail.terminal_at IS NULL;`;
