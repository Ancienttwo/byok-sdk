import { DEFAULT_APPROVAL_TIMELINE_CAPACITY, DEFAULT_APPROVAL_TIMELINE_TTL_MS } from '@byok-sdk/cloud';

/** The instant a task stops admitting output: its first terminal, or an accepted Host cancellation. */
const CLOSED_AT = (row: string) => `COALESCE(${row}.terminal_at, ${row}.cancellation_requested_at)`;
const DEADLINE = (at: string, ttlMs: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, printf('+%.3f seconds', ${ttlMs} / 1000.0))`;
const APPROVAL_TTL = String(DEFAULT_APPROVAL_TIMELINE_TTL_MS);
const EMPTY_APPROVALS = `'[]', 1, 0, ${DEFAULT_APPROVAL_TIMELINE_CAPACITY}`;

const OUTPUT_CLOSURE_TRIGGER_NAME = 'task_output_closed';

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
