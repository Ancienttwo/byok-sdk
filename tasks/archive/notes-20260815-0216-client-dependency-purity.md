> **Archived**: 2026-08-15 02:16
> **Related Plan**: plans/archive/plan-20260815-0205-client-dependency-purity.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260815-0216

# Implementation Notes: client-dependency-purity

> **Status**: Active
> **Plan**: plans/plan-20260815-0205-client-dependency-purity.md
> **Contract**: tasks/contracts/20260815-0205-client-dependency-purity.contract.md
> **Review**: tasks/reviews/20260815-0205-client-dependency-purity.review.md
> **Last Updated**: 2026-08-15 02:05
> **Lifecycle**: notes

## Design Decisions

- The rule lives in `scripts/release/check-package-graph.mjs` next to the other `packages/client` manifest checks, pushing into the shared `errors` array so it inherits the script's `[release-graph] <message>` reporting and single `process.exit(1)`.
- Scope is `packages/client/package.json` `dependencies` only. `devDependencies` never reach an end user's install, and the transitive closure is red today through `@earendil-works/pi-coding-agent@0.84.1` (native addons plus `@google/genai` preinstall and `protobufjs` postinstall), so transitive scope would have required an allowlist — a steady-state compatibility layer the contract rules out.
- `resolvePackageDir` walks the `node_modules` chain upward and `realpathSync`s the hit, so pnpm's symlink farm and the workspace links (`@byok-sdk/core`, `@byok-sdk/protocol`) resolve to the real package directory.
- `findNativeAddon` skips nested `node_modules` and dotfiles: a nested package is a different graph node and out of direct scope.
- The negative control is a `--self-test <dir>` mode in the same file, auditing one installed package directory through the same `auditPackagePurity` function the rule uses, and exiting nonzero on any violation. A separate fixture would have tested a copy of the logic rather than the shipped path.

## Deviations From Plan Or Spec

- None.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Transitive closure scan | Rejected | Red today through the pinned pi subtree; only an allowlist could green it |
| Separate unit test with a temp fixture | Rejected | Adds a fixture and a second entrypoint; `--self-test` exercises the shipped code path against real installed packages |
| `--self-test` mode in the script | Chosen | Same function as the rule, same exit-code convention, no new test surface |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

### Negative control (required by the contract Falsifier)

Both violation branches proven red against real installed packages:

```
$ node scripts/release/check-package-graph.mjs --self-test node_modules/.pnpm/@earendil-works+pi-tui@0.84.1/node_modules/@earendil-works/pi-tui
[release-graph] self-test .../@earendil-works/pi-tui ships a native addon (native/win32/prebuilds/win32-x64/win32-console-mode.node)
exit=1

$ node scripts/release/check-package-graph.mjs --self-test node_modules/.pnpm/@google+genai@1.52.0/node_modules/@google/genai
[release-graph] self-test .../@google/genai declares a preinstall script
exit=1

$ node scripts/release/check-package-graph.mjs --self-test packages/client/node_modules/ws
[release-graph] self-test OK: .../packages/client/node_modules/ws is pure JavaScript
exit=0

$ node scripts/release/check-package-graph.mjs
[release-graph] OK: 7 dispatch manifests at 0.4.0, keys at 0.1.0; umbrella has 6 dispatch namespaces and no keys edge
exit=0
```

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
