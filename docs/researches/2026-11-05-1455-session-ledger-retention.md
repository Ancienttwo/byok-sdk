# Custom runtime ledger retention (#1455)

Issue and pre-implementation design: [#1455](https://github.com/Ancienttwo/byok-sdk/issues/1455).
Baseline: `6ae713bcb0a294a8e6223b9d3f416d3612cec508` (main).

## Reproduction

The new `retention.test.ts` case writes a real `custom-task` session handoff
under an Agent home's execution lease, releases the lease, and stamps the
ledger with the injected retention clock. Configuration accepts terminal
evidence TTL 0 alongside session-ledger TTL 30 days. Before a sweep,
`requireMatch` succeeds. After advancing one day and running the real
`RetentionSweeper`, baseline `requireMatch` throws
`AgentSessionHandoffMismatchError`: the session does not exist on this device.
The baseline test failed at that second lookup, before any implementation edit.

Command (from `packages/client`):

```sh
node ../../node_modules/vitest/vitest.mjs run src/__tests__/retention.test.ts -t 'keeps a custom-task resume authority'
```

The baseline probe used Linux, Node 24.19.0 and Vitest 4.1.12. Final checks used
the repository's Node 24.22.1 and Bun 1.4.2; `bun ci` found the lockfile's 559
installs already satisfied. No user homes, credentials, provider calls or
running services were involved.

## Fix and checks

Ambiguous filenames keep their existing measurement class but deletion waits
for both TTLs. This intentionally retains some actual terminal evidence longer;
it neither parses contents nor changes the disk format. The new cases cover
successful handoff lookup before the session window expires, deletion at the
exact boundary, the opposite TTL ordering, and terminal runtime prefixes of
59/60 characters on either side of the ambiguity boundary. A review follow-up
also creates a real ordinary `pi` session with session TTL 0 and terminal TTL
30 days: lookup succeeds before the sweep, then the very first sweep deletes
the ledger without advancing time and lookup fails. The ambiguity guard thus
does not lengthen an unambiguous session's configured retention window.

- New regression: baseline RED, fixed GREEN. All six new cases pass.
- Full affected files: `retention.test.ts` 63 passed after the review follow-up;
  `agent-home-contract.test.ts` and `agent-home-readers.test.ts` 73 passed together
  before that test-only addition. Total 136 distinct passing cases, not a single
  all-136 run. Client typecheck also passed after the addition.
- Root `bun run build`, `bun run typecheck`, `bun run check:version-authority`
  passed. Cloudflare build was `--dry-run`, not a deployment.
- API declarations are unchanged (nine goldens). The new runtime logic adds
  exactly 417 bytes to each of `@byok-sdk/client` (2,181,511 → 2,181,928) and
  `bin:byok-agent` (2,141,177 → 2,141,594). The two proposed policy budgets equal
  measured size, with no headroom, and the generated README table is synchronized.
- No existing test assertion was removed or relaxed. The fixture only gained
  optional TTL inputs; the existing filename-contract comment was corrected.

Two setup failures are excluded from product evidence: the first root build
could not create Wrangler's default config directory, then passed with a fresh
`XDG_CONFIG_HOME` under `/tmp`; an initial concurrent test start overlapped
dependency rebuilding, so the retention suite could not resolve protocol's
build output. Its complete file passed after the build finished. The other two
files had already passed and were not repeated.

## Limits

The actual reproduction covers store → idle sweep → `requireMatch`. The
non-retryable offer decline is source-traced in `task-runner/offer-workspace.ts`,
not a custom-runtime cloud-offer execution. Existing reader/writer daemon tests
exercise missing-ledger declines. No native Windows/macOS, real provider,
deployment, release or full test matrix was run. The PR remains Draft for
independent review and hosted CI, including review of the conservative retention
tradeoff and the two exact-size budget changes.
