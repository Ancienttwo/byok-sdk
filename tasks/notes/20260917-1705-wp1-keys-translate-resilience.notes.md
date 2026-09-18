# Notes: wp1-keys-translate-resilience (2026-09-17)

## Delivery

- 6105f7cf `fix(wp1): tolerate untranslatable ACE identities in projection ACL script` (+2/-1, single file).
- Rules loop now: `$sid = if ($_.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) { $_.IdentityReference.Value } else { try { $_.IdentityReference.Translate($sidType).Value } catch { $null } }`; `sid = $sid` in the ordered hash. Script otherwise untouched; Node validator untouched.
- No pin tests existed for the script text (verified by grep across packages/keys *.test.ts); no test files changed.

## Verification (fast-worker, pasted output; orchestrator re-checked diff + vendored + branch delta)

- typecheck: 15 packages Done, no errors.
- keys tests: 22 files passed | 1 skipped (the darwin-self-skip windows file), 494 passed | 4 skipped, exit 0.
- check:api-surface: 10 package goldens match. check:version-authority: agree with byok-sdk@0.18.0 / keys@0.5.0.
- VENDORED_OK (d4dcf961); git diff --check clean; attribution clean (git log -1 --format=full: Ancienttwo only).

## Pre-fix failure artifact (round-4, job 105133623925)

`refuses the real Windows directory owner rather than the current token`: expected `pi_projection_owner_mismatch`, received `Pi projection ACL query failed: ... MethodInvocationException: Exception calling "Translate" ... "Some or all identity references could not be translated."` at the rules loop (script line 7) — eager translate died before the owner check was reportable.

## Residual

- PS 5.1 runtime behavior unverifiable on darwin (no pwsh 5.1); [inferred] syntax legality from PS 3.0+ documented features (assignment from if/else with try/catch statement block). Behavioral proof = round-5 CI lowpriv lane, 4/4 expected green.
- Local grep alias caveat: contract's resilient-sid-present check must run under /usr/bin/grep (BRE literal parens); ugrep misparses `(` as grouping and false-zeros.
