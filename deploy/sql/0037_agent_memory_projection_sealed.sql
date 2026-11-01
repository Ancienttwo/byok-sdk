-- 0037_agent_memory_projection_sealed.sql — sealed hosted memory projection (#1045 C4).
--
-- A grant with `sealing` makes the device send its snapshot sealed under the
-- Agent's memory scope. The head then stores the sealed member as received,
-- and the receipt keeps its `contentMac` and padded length; neither keeps a
-- plaintext hash or byte count of sealed content. Each row holds exactly one
-- form. Every existing row is plaintext, so this migration only adds nullable
-- columns, relaxes NOT NULL and adds checks: it rewrites no data.

ALTER TABLE agent_memory_projection_head
  ADD COLUMN sealed_member jsonb,
  ALTER COLUMN redacted_hash DROP NOT NULL,
  ALTER COLUMN redacted_snapshot DROP NOT NULL,
  ALTER COLUMN redacted_byte_count DROP NOT NULL,
  ADD CONSTRAINT agent_memory_projection_head_one_form
    CHECK (
      (sealed_member IS NULL
        AND redacted_hash IS NOT NULL AND redacted_snapshot IS NOT NULL AND redacted_byte_count IS NOT NULL)
      OR (sealed_member IS NOT NULL AND jsonb_typeof(sealed_member) = 'object'
        AND redacted_hash IS NULL AND redacted_snapshot IS NULL AND redacted_byte_count IS NULL)
    ),
  -- An inline member pads to at most 256 KiB, which base64url encodes to
  -- about 342 KiB; 512 KiB bounds the member with its header.
  ADD CONSTRAINT agent_memory_projection_head_sealed_bounded
    CHECK (sealed_member IS NULL OR octet_length(sealed_member::text) <= 524288);

ALTER TABLE agent_memory_projection_metering_receipt
  ADD COLUMN content_mac text,
  ADD COLUMN padded_length integer,
  ALTER COLUMN redacted_hash DROP NOT NULL,
  ALTER COLUMN redacted_byte_count DROP NOT NULL,
  ADD CONSTRAINT agent_memory_projection_metering_one_form
    CHECK (
      (content_mac IS NULL AND padded_length IS NULL
        AND redacted_hash IS NOT NULL AND redacted_byte_count IS NOT NULL)
      OR (content_mac IS NOT NULL AND padded_length IS NOT NULL
        AND redacted_hash IS NULL AND redacted_byte_count IS NULL)
    ),
  ADD CONSTRAINT agent_memory_projection_metering_content_mac_shape
    CHECK (content_mac ~ '^hmac-sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_memory_projection_metering_padded_bounded
    CHECK (padded_length > 0 AND padded_length <= 262144);
