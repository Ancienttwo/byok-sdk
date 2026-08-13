-- Device-local logical toolset inventory projected through presence.
--
-- Nullable is intentional: NULL means a legacy daemon or an inventory that
-- has not yet been observed, while [] means a current daemon explicitly
-- reports no configured toolsets. Executable definitions and credentials
-- never enter this table.
ALTER TABLE device_presence
  ADD COLUMN configured_toolsets jsonb;

ALTER TABLE device_presence
  ADD CONSTRAINT device_presence_configured_toolsets_shape
  CHECK (
    configured_toolsets IS NULL
    OR (
      jsonb_typeof(configured_toolsets) = 'array'
      AND jsonb_array_length(configured_toolsets) <= 64
    )
  );
