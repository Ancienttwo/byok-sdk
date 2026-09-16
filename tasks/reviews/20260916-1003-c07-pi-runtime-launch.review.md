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


## P2 terminal acceptance and P3 entry (2026-09-16)

Supervisor independent gate **PASS**, frozen source eff16ae45943a9d2d741396b8eccc2bcab4e5b5b. Product P2 is complete; this does not accept P3 containment or the complete C07 train. Client 2628 passed / 11 skipped / one known P3 containment failure; keys 490 passed / four Windows ACL tests not run; identity 13 passed; targeted guards 23 passed. Build/typecheck/API10/version/graph/workflow/diff/attribution pass. Actual release-pack exits 0, manifest sourceGitSha is eff16ae4, all 11 tarball SHA256 values checked. No-auth direct refusal requests=0 and authenticated synthetic direct positive both pass; no real credentials used.

Evidence: `_ops/c07-identity-workspace/independent-eff16ae4/` and `p2b-eff16ae4-gate.md` (unaltered supervisor report). No duplicate full/pack run. Earlier timeout remains unproven load/timing report-only; SystemRoot input hardening and sourcemap warnings remain unchanged.

P3 begins with the actual remaining resolution path and immutable native 1005 boundary. SDK-side containment, release asset selection, export_html path validation and closure prerequisites are in scope. Fork 1006 implementation/publication, scanner-boundary changes, photon feature reduction and Salesko P4 edits are not authorized by this entry. No push/merge/publish.

## P3c frozen candidate

Product00c5529a is pending independent frozen gate. Local scoped checks recorded in notes; no full C07/P3 containment PASS. Registry attempt guard remains a hard failure, not waived. Supervisor owns the sole full/pack run after registration freeze.


## P3c independent gate and r1 candidate

8b016495 FAIL, only blocker helper config-digest usage returns1/stack instead of78/prefixed single line; known S2 guard separately remains RED36registry attempts. Both actual Pi lanes now reach get_state, prepared lookup failure closed. Product87d9b5f9 is the bounded five-file correction; pre-fix red and post-fix40targeted passes plus build/typecheck are recorded in notes. Final frozen client full and independent re-gate (including real pack with stricter smoke) remain pending. Keys/identity/API/graph unaffected, prior subject evidence reusable per supervisor. No terminal PASS yet.


## P3c terminal partial acceptance; P3d entry

Supervisor PASS89e323b4, copied original `_ops/c07-identity-workspace/p3d/p3c-terminal-gate.md`. HIGH digest usage closed; build/typecheck/71targeted/API10/version/graph/strict and real release-pack pass (sourceGitSha89e323b4). Fullclient2660passed/11skipped/one knownS2 tripwire36failure; bothlanes get_state; not complete containment. Keys494/4skipped andidentity13 reused on unchanged surfaces.

P3d activated by supervisor: static/build-time closure of SDK extension jiti/rpiv-i18n, remaining launcher/team/daemon discovery, and existing RPC non-digest CLI renderer inconsistency/recomputation. Three report-only entries now tracked in this bounded scope: pi-rpc-host fail/expected parse and create-daemon constructor native lookup. Clipboard12 belongs to1006 and hard tripwire zero assertion stays unchanged. Read-only two-part trace is in progress; design decisions must preserve async subagent/i18n functionality and runtime authority, not merely remove startup attempts. No product edit yet; no external action. `.ai/context/capabilities.json` absent in this worktree; existing context-map loaded, no scoped context added.


## P3d partial progress / design hold

35f04583 registers P3d;21ab3c86 usage renderer has build/typecheck/23targeted pass and supervisor bounded diff acceptance. Overall P3d pending, no terminal gate. §96 Decision Packet awaits review; supervisor explicitly holds runner implementation until Salesko P4 multi-kind record shape is defined. Existing S2 RED36 remains intact; no dependency/extension/record edits or functionality removal. No full/pack rerun or external action.

## P3d helper-lookup candidate

Product f73431cf, registration separate. Author targeted build/typecheck pass; compiler+strict RPC12/12 and team7/7; earlier focus reserved-helper/control/closure files passed with one new malformed fixture failure subsequently corrected. No timeout/closure assertion relaxed. Evidence `_ops/c07-identity-workspace/helper-lookup/`; complete frozen gate pending supervisor, includes prior renderer21ab3c86. No new full/pack claim. Node MCP launcher lookup, runner/i18n and native closure remain open as recorded in notes.

Supervisor requested author first frozen client full run before independent re-gate; both will be sequential. Shared client-manifest is not globally dev-only because trusted-launch-cwd remains a production caller. Final full evidence will bind the post-registration head recorded in handoff.
