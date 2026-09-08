# Embedded operator APIs acceptance contract

Plan: plans/archive/plan-20260908-embedded-operator-apis.md
Allowed paths and commands: see plan.
Require three public client root exports with narrow types and closed error codes. Confirm before mutation; fail closed on live owner/unsafe input; exact archive identity; audit durability before removal; no-overwrite export; no secret/path/error leakage in errors; real configured adapters; no service start or replay. New source version is an unpublished minor train.
Verify required root build/typecheck/test/API/version/workflow checks plus focused public import tests. Preserve and report unrelated failures, maximum three fix/reverify rounds per issue.
