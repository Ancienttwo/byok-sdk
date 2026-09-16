# C07 Pi runtime launch and provenance review

Verdict: PENDING — registration only. No implementation exists yet, so no acceptance verdict is claimed and no AcceptanceReceipt is projected.

This slice registers the plan, contract and Track B report on base `4fe4ad6f`. Product source, dependencies and build artifacts are unchanged. Probes p1-p6 gate P1 and have not been run; the verification matrix in the contract has not been executed.

## Acceptance criteria to be reviewed later

- The falsifier holds: no Pi child starts whose interpreter, entry, argv, cwd or env differ from the attested description without a pre-spawn refusal, on each of the three lanes (ordinary, prepared, keys).
- One launch description authority, consumed identically by resolve, admission and pre-spawn; no dual read, no argv0 fallback, no compiled-only alias, no mutable wrapper, no reduction of the supported surface.
- The Pi process cwd is the sealed launch cwd and the session cwd is passed explicitly, on all three lanes.
- With an authority configured, an unattested runtime subject declines the task; `resolver_unconfigured` keeps the dev path. Both assertions must exist.
- Provenance is derived from the single exact pin, `byokFork` and build inputs; a HOME `package.json` never changes execution identity.
- keys secret injection rules are unchanged and no wildcard exemption is added; keys does not import the whole client.
- Owner-stated completion conditions are met: photon cwd WASM fallback closed, package provenance bound, keys final env reverified, full daemon plus Pi running under the interpreter.

## Out-of-scope for this review

Salesko O1 wiring (P4) is cross-repo with its own contract. The §75 closure work package (P6) is a prerequisite for full bundle closure and is not owned here; a green candidate check is not a closure pass, and no feature may be disabled to turn a check green. Push, merge, publish, real installation and F numbers are not authorized.


## P1-M independent boundary review (2026-09-16)

Reviewer report: `_ops/c07-identity-workspace/independent-review.md`. Extraction invariants have scoped approval; aggregate acceptance is **FAIL**, because a fourth client timeout appeared beyond the three expected baseline guards and actual clean-candidate pack has not run yet. One authorized isolated diagnostic passed13/13; literal path-disjointness cannot be claimed because daemon env construction consumes relocated loader constants. Parent retains FAIL pending disposition; no retry-to-green or speculative production fix. See notes and `cancel-diagnosis.md` for exact evidence. This is not a review of or acceptance for P2.
