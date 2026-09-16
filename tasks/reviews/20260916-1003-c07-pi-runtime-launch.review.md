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


## P1-M terminal acceptance (2026-09-16, frozen e1cc484c)

Supervisor Fable: **PASS**. This supersedes the earlier pending/FAIL migration status only; P2 and later slices remain open. Frozen client suite: 3 failed / 2556 passed / 11 skipped, exactly the three pre-existing P1 guards; the cwd control passes, and cancellation passes in 888 ms. Earlier WIP cancellation timeout remains an unproven load/timing report-only finding, not proven flaky or conclusively excluded as a regression.

Evidence: `_ops/c07-identity-workspace/frozen-client-e1cc484c.log`, `frozen-client-summary.json`, `release-pack-e1cc484c.log`, `pack-e1cc484c/release-manifest.json`, `frozen-packed-edges.json`. Actual pack exits 0, manifest sourceGitSha is e1cc484c9d1cdb328751d0b4b9a226008b17e1e2, all 11 package hashes verified. Packed client and keys both depend exactly on implementation-identity 0.18.0; physical wrong-version tarballs are rejected. Packed implementation bundle is the scanned 24472-byte object (0 hits), not a re-export barrel. Remaining 13 package suites passed. Client root identity export names remain unchanged; attribution matches 0. No push or publication.

P2 is now released by the supervisor. Before product edits, handoff §88 records Owner notice for same-train piEntrypoint/argv0 retirement and contract:729 supersession; Salesko authoring/removal remains P4. Keys final-environment handoff and the minimal executable entry prerequisite are being traced before interface selection.
