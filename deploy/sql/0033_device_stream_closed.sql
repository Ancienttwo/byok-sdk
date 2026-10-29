-- #1160: a retired device's mailbox stream is closed.
--
-- Revoke and supersede close the device's stream row in the transaction that
-- retires the device, and every append reads closed_cause from the stream row
-- version its own upsert locked, so no pending row for that device commits
-- after the retirement. Registering the same device id again clears both
-- columns. A stream row is never deleted by retirement, so seq, cursor and
-- recoverableFrom stay monotonic across a close and a reopen.
--
-- closed_at is the first close instant, in the same text form as acked_at;
-- closed_cause is the latest retirement's cause. Both are set or both NULL.

ALTER TABLE device_stream ADD COLUMN closed_at text;
ALTER TABLE device_stream ADD COLUMN closed_cause text
  CHECK (closed_cause IN ('device_revoked', 'device_superseded'));
ALTER TABLE device_stream ADD CONSTRAINT device_stream_closed_pair
  CHECK ((closed_at IS NULL) = (closed_cause IS NULL));

-- One-shot backfill: a stream whose device row is gone belongs to a device
-- retired before this migration, and is closed as a retirement closes it: its
-- pending rows become expired, since no device will ever ack them. Its cause
-- is device_revoked, because the revoke/supersede distinction was never
-- stored and cannot be recovered; a pre-upgrade supersede reads as a revoke.
-- Streams of registered devices stay open. The instant is the migration's
-- own, as no earlier one was recorded.
UPDATE device_stream s
   SET closed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       closed_cause = 'device_revoked'
 WHERE NOT EXISTS (
   SELECT 1 FROM device d WHERE d.tenant_id = s.tenant_id AND d.device_id = s.device_id
 );

UPDATE outbox o
   SET state = 'expired'
  FROM device_stream s
 WHERE s.tenant_id = o.tenant_id AND s.device_id = o.device_id
   AND s.closed_cause IS NOT NULL AND o.state = 'pending';
