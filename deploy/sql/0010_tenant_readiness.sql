-- U3 tenant readiness observation facts.
--
-- The row remains one lossy, TTL-bounded projection per (tenant, device). These
-- fields are optional because older daemons cannot report them; absence is
-- unknown, never a host-derived default.
ALTER TABLE device_presence
  ADD COLUMN client_version text;

ALTER TABLE device_presence
  ADD COLUMN protocol_versions jsonb;

ALTER TABLE device_presence
  ADD COLUMN runtimes jsonb;

ALTER TABLE device_presence
  ADD CONSTRAINT device_presence_protocol_versions_shape
  CHECK (protocol_versions IS NULL OR jsonb_typeof(protocol_versions) = 'array');

ALTER TABLE device_presence
  ADD CONSTRAINT device_presence_runtimes_shape
  CHECK (runtimes IS NULL OR jsonb_typeof(runtimes) = 'array');
