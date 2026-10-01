# Pi FFF dispatch notes

> **Status**: Active
> **Plan**: plans/plan-20261001-1237-pi-fff-local-search.md
> **Contract**: tasks/contracts/20261001-1237-pi-fff-local-search.contract.md

## Dispatch

- User authorization: “落plan派工吧”, after tools-only ordinary Pi RPC recommendation.
- Base: 708ed45b275d7d0cceeb6b61eb392c7d7b4efed9; branch codex/pi-fff-local-search; worktree /Users/chris/Projects/byok-sdk-wt-pi-fff-local-search.
- WP1: /root/fff_probe_worker, custom deep-worker, temporary independent real npm/native fixture proof only.
- WP2: /root/fff_policy_explorer, custom explorer, read-only policy/identity trace.
- Initial default-role children rejected by injected native-role-routing; no commands or edits ran there. Reassigned to explicit custom roles. This is routing evidence, not a package incompatibility.
- WP3 waits on WP1/WP2; WP4 independent acceptance waits on WP3. No completed integration or shipping claim.

## Open Evidence

Exact public API/native compatibility, negative authorization cases, owned configuration, installed identity closure and concurrent native database behavior await worker readback.

## Verification

Contract brief preflight, workflow check and diff check are planning checks only. Implementation required checks are specified in the contract.

## Preliminary worker readback

- WP1: exact isolated install, bundled extension, real grep/find and ignored file negative test passed; empty registry and explicit allow/deny passed; explicit shutdown + dispose + same database reopen passed. Evidence root /tmp/byok-fff-probe.NystnG. Strict upstream TS source typecheck failed with optional-string errors; runtime/schema test passed. Concurrent session proof pending.
- WP2: exact Pi 0.99.1 registry applies allow/exclude to all extensions, so upstream setActiveTools cannot activate a name absent from the registry. Current readonly does not grant FFF names; retain that boundary for this slice. Implementation identity does not attest generic native/transitive dependency graphs. Plan narrowed to ordinary installation readback; Prepared/identity changes excluded.
- WP3 remaining gate: SDK-owned tools-only mode/configuration and restored-mode control through public extension API; no production edits until proven.

- WP2 COMPLETE; authoritative findings captured in tasks/notes/pi-fff/wp2-policy-identity.md. WP3 dispatched to /root/fff_integration_worker, feasibility-only before production edits; expected artifact tasks/notes/pi-fff/wp3-feasibility.md.

## WP1 final preliminary results

Concurrent two real sessions sharing the same FFF database both searched and shut down with bounded child exit 0. Restored upstream fff-mode override supersedes startup tools-only and switches to builtin-named grep/find, confirmed by reproducer exit 0. Default published extension exposes two tools; third multi-grep is conditional on PI_FFF_MULTIGREP=1. Unbundled Node node_modules TS import fails ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING (exit 1); bundled TS works. Strict upstream schema typing fails (exit 2), while real runtime schema validation passes. Observed platform: macOS arm64 / Node 26.10.0; SDK minimum Node 22.22 remains an unverified runtime target. Source: /root/fff_probe_worker, evidence /tmp/byok-fff-probe.NystnG.

## User approval and production dispatch

User approved continuation (2026-10-01). Parent authorized the public-API composition documented in wp3-feasibility.md, including no-await documented env redirect/finally restore and ephemeral per-instance databases. WP3 /root/fff_integration_worker owns client source/dependencies/build/tests; WP4 /root/fff_pack_smoke owns release-pack script and native installed smoke. No implementation-identity expansion, Prepared change or shipping action is authorized.

## Final stable verification and acceptance

- Frozen Git candidate: 6beed8152d839b1f9263145519e6699f3bc716ed (temporary verification checkout only); real work branch remains codex/pi-fff-local-search at base 708ed45. Manifest: /tmp/byok-fff-snapshot-manifest.json, 23 matched files.
- Actual runtime: Node 22.22.0 / macOS arm64; explicit BYOK_REQUIRE_BUN=1 and BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun; fresh short TMPDIR.
- Canonical report: _ops/pi-fff-verification.json; log /tmp/byok-fff-verification-stable.log; snapshot_changed_during_execution=false; seven checks passed, only release-pack failed.

| Check | Exit | Outcome |
| --- | --- | --- |
| `build` | 0 | PASS |
| `typecheck` | 0 | PASS |
| `test` | 0 | PASS |
| `api-surface` | 0 | PASS |
| `version-authority` | 0 | PASS |
| `task-workflow` | 0 | PASS |
| `release-pack` | 1 | FAIL |
| `diff-check` | 0 | PASS |

- FFF installed native binary/addon readback, runtime search, ignored-file negative case, TUI 0.99.1 bundled provenance and shutdown all passed before release-pack failure. Native dependency graph is not attested by implementation-identity.
- Failure: existing pi-launcher-smoke hits official Pi package identity mismatch: @earendil-works/pi-telemetry. Original clean main control failed identically; consumer root TUI 0.99.2 and coding-agent nested TUI 0.99.1 already appear without FFF. Evidence: wp3-baseline-pack.md and /tmp/byok-fff-baseline.x8MPid/.
- Independent /root/fff_acceptance_review covered complete source/test/build/pack/docs scope, no FFF policy/lifecycle code finding; overall BLOCKED on release closure and CodeGraph/typed acceptance.
- Independent /root/pi_peer_boundary_judgment recommends a separate Pi closure repair at current 0.99.1. Existing transitive-only authority forbids adding chord/telemetry/codemode/mcp direct pins; peer fields must not be used to evade the native/direct boundary.
- Parent testing corrections: ordinary CLI helper 120-second wrapper interrupted its first full-suite run; verified owner PID was dead and no task test process remained before removing only that stale task lock. Subsequent strict CI Bun variables resolved the environment-only missing-interpreter failure. A generated verification report was briefly written to the reserved latest run-trace filename; this self-created wrong-schema file was removed and report redirected to ignored _ops. A baseline evidence note created during a run changed its virtual tree; final stable rerun included it. All earlier failures and immutable run records are retained, not relabeled green.
- Final workflow edits after the frozen verification are limited to this delivery note, plan/contract state and review report; production and test hashes remain unchanged. Focused workflow/diff checks verify those metadata edits without another expensive full rerun.

## 0.99.2 continuation

The user corrected the current baseline to Pi 0.99.2 and requested continuation. Parent captured and composed 23 primary upgrade files into the isolated FFF worktree, excluding OAR and separate context planning. Original primary WIP is not mutated. client package JSON merged structurally, spec/todos merged three-way; original primary lock is the generation seed, and bun install restores FFF entries on the new closure. Previous 0.99.1 tests/blockers are not claims about this candidate. Import hashes and pre-composition backups: /tmp/byok-fff-0992-baseline-import.json.

WP5 source/note freeze: client build/typecheck, targeted29/29, actualNode22 native4/4 and pack unit5/5 passed on0.99.2. Pack readback sees44 TUI2sources, zeroactive1; all8 official resolverpackages2. DormantBunstorecache1 is notactive and is preserved. Source and all worker evidence are frozen before canonical.

## Final Pi0.99.2 result

- User corrected runtime baseline and authorized continuation. Primary23-file upgrade was inherited; original primary was not edited. ExcludeOAR/context plan. Primarytodos subsequently changed elsewhere and was deliberately not overwritten.
- Frozen candidate 9f9d69cd31b50622b7f62db0d8f13c4dabb1fd6f; source45files matched /tmp/byok-fff-0992-snapshot-manifest.json.
- Node22.22/macOSarm64, CI Bun flags and fresh shortTMPDIR: all8 canonicalchecks actualexit0, no source drift. Report _ops/pi-fff-0992-verification.json, log /tmp/byok-fff-0992-verification.log. No old0.99.1 result reused as0.99.2 acceptance.
- release-pack passed installed FFF native/addon/provenance/realfindgrep/ignorednegative/shutdown and retained existing officialPi launcher/all-installedclosure assertions; oldtelemetry mismatch disappeared.
- Independent /root/fff_acceptance_review verdictPASS covered baseline provenance, FFF implementation/tests/build, package smoke and full45file scope.
- Remainingformal gate: architectureprojection codeFactsrequired with noCodeGraphindex, oneunresolvedcandidate and zeroacceptance receipts; typedAcceptanceReceipt unavailable. No index was silently created under the userindexing rule. StatusReview is intentional; no ship-ready or publication claim.
- Later deliverymetadata edits are plan/review/mainnotes only; production/test/docs hashes remain identical to the passedfrozen candidate. Focused workflow/diff checks validate this statusdelta without repeating fulltests.

## CodeGraph/typed closeout approval

User approved the remainingcloseout. codegraphinit exited0 (1155files,33607nodes,106349edges). Publicarchitectureapply exited0; proof-only signal407cba56... reconciledafter its staleprojectionmanifest was refreshed. Current architecture unresolvedCandidates=0. Baseline-with-delta explicitly keeps old0992 actualexecutions distinctfrom current metadata checks. Reports: /tmp/fff-codegraph-init.log, /tmp/fff-codegraph-proof.txt, /tmp/fff-architecture-apply.json, /tmp/fff-architecture-reconcile.json.
