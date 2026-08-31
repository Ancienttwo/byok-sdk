-- 0016_mailbox_delivery_watermark.sql — server-owned mailbox delivery bound.
--
-- Client acknowledgement is allowed only through the highest cursor the
-- server has returned to that exact tenant/device. Enqueue allocation is not
-- delivery authority: next_seq may be far ahead while no response has exposed
-- those rows. Existing acknowledged rows are the one safe backfill fact — an
-- acknowledgement already persisted before this migration necessarily came
-- from the historical delivery path.

ALTER TABLE device_stream
  ADD COLUMN delivered_seq bigint NOT NULL DEFAULT 0;

UPDATE device_stream
   SET delivered_seq = acked_seq;

ALTER TABLE device_stream
  ADD CONSTRAINT device_stream_delivery_nonnegative
  CHECK (delivered_seq >= 0),
  ADD CONSTRAINT device_stream_ack_within_delivery
  CHECK (acked_seq <= delivered_seq);
