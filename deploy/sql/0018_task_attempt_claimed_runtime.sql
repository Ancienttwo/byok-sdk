-- The claim-time runtime snapshot on the task attempt.
--
-- Two columns, one fact: what the daemon that WON the ownership CAS reported
-- about itself on its own `task.claim` — its runtime id and that adapter's own
-- capability block. Both are written by the guarded claim UPDATE and by nothing
-- else, so they are set exactly once, at the `offered -> claimed` transition,
-- and a redelivered or losing claim can never restamp them.
--
-- They are ATTRIBUTION, not execution state: they stop changing the moment
-- ownership is decided, which is what keeps them inside what ADR-028 allows the
-- coordination plane to hold. `ByokCloud.steerTask` reads
-- `claimed_runtime_capabilities` as the single input to its steer gate; the
-- connection-level capability snapshot on the device row is deliberately not an
-- input, because it describes a device build rather than the adapter that took
-- this task.
--
-- Additive and nullable with NO backfill, deliberately. A task claimed before
-- this migration has no snapshot to reconstruct — the claim that carried it is
-- long gone — and inventing one would open the steer gate on a guess. NULL
-- means "unknown", and the gate refuses an unknown.

ALTER TABLE task ADD COLUMN claimed_runtime text;
ALTER TABLE task ADD COLUMN claimed_runtime_capabilities jsonb;
