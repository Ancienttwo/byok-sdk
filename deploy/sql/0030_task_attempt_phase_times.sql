-- #980: the phase instants of a task attempt.
--
-- Four write-once instants, each set by the statement that makes its
-- transition and never written again:
--
--   offered_at       the offer INSERT that creates the attempt;
--   claimed_at       the guarded claim UPDATE that wins ownership, the same
--                    statement that writes claimed_runtime (0018);
--   first_output_at  the first Agent message after the claim, in the
--                    transaction that reserves it;
--   terminal_at      the first entry into complete, failed or cancelled,
--                    including a cancellation of an unclaimed attempt.
--
-- They are ATTRIBUTION, not execution state: each stops changing at the
-- transition that sets it, which keeps them inside what ADR-028 allows the
-- coordination plane to hold. No column defaults to now(); every instant comes
-- from the injected clock, in the same timestamptz form as updated_at.
--
-- Additive and nullable with NO backfill, deliberately. A task stored before
-- this migration has no record of when its transitions happened, and
-- updated_at is overwritten by every status change, so any backfill would be a
-- guess. NULL means "not recorded"; readers report no duration for it.
-- Migrations are forward-only. Roll back the application; these stay.

ALTER TABLE task ADD COLUMN offered_at timestamptz;
ALTER TABLE task ADD COLUMN claimed_at timestamptz;
ALTER TABLE task ADD COLUMN first_output_at timestamptz;
ALTER TABLE task ADD COLUMN terminal_at timestamptz;
