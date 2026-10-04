# Cloud 4e-2 implementation

This slice extends the private cloud-do session host. It changes no package
version and publishes nothing.

P1: AgentDO owns the consumer hooks and transcript RPC. SessionRuntime owns the
lease, send gate, recovery and settlement delivery. InvocationLedger owns model
usage and tool credits. CloudState owns inbox handoff, membership, revisions and
alarm deadlines.

P2: enqueue selects a batch, records immutable admission identity, claims the
remaining seqs and commits real native input. Model requests renew, pass the
budget gate and record dispatch intent before fetch. Checked usage is recorded
at ingestion. Tool dispatch renews before it takes a fetch slot. The terminal
transaction precedes consumer settlement and the atomic ack event.

P3: the ledger remains the only replay path. Paid model work is not rerun.
Settlement uses the existing alarm generation. Old text is recovered from real
native input. Unknown legacy clocks and current links stay unknown.

## Changes

- Instructions reach the pi system message through a protected hook.
- Execution rows record tokens, credits and dispatch intent. Fixed caps stop the
  next paid gate. The crossing tool result stays intact.
- Admission digest and selected seqs stay immutable. Membership records the
  smaller claimed batch and its real claim/requeue revisions.
- Settlement is terminal-first, bounded and idempotent by consumer identity.
  Submit and wake runs use the same ack rule. Repair blocks a new lease.
- Transcript pages use one horizon. Native input fills the captured SQL plan.
  Inbox text remains until durable handoff and stays on a possible requeue.
- A resumable legacy backfill preserves purged historical input text. Its rows
  do not invent clocks or a current run link.

## Assertion changes

Only four payloadJson expectations change in cloud-state.test.ts. They cover an
oversized unclaimed item, an exhausted fourth claim and two fixture-only terminal
paths without a native input. State, attempts, error and rejection assertions
stay intact. All other existing assertions stay unchanged.

## Verification

The package test, typecheck and build commands are the slice checks. Root
verification uses typecheck, API surface and version authority. The full root
suite remains a separate owner gate. The final execution report records command
exit codes and exact test counts. Real workerd tests cover the provider, ledger,
settlement, transcript and restart paths.

Observed slice verification:

- Package test: 852 Vitest passes and 3 native node passes. No test was skipped.
  Baseline: 737 Vitest and 3 native tests. Added: 115 Vitest tests.
- Package typecheck and build: exit 0.
- Root typecheck, API surface and version authority: exit 0.
- API surface: all 9 public-package goldens match.
- Baseline assertion audit: only the four approved payloadJson expectations
  changed. The 246 baseline wake assertion and wait lines are preserved.
- Independent read-only review completed. Owner-directed fixes follow its findings.

## Review fixes

- F1: delivery is isolated per run. A batch tries all unacked runs concurrently
  and reports any failure. The completed run releases its lease first. A stuck
  settlement does not block a later ack or a new wake. Per-run flights join
  concurrent callers without adding a retry timer.
- F2: the wake-trigger hook failure test observes a real alarm retry. The paid
  provider count and recorded usage stay unchanged. A later submit succeeds.
- F3: an unreadable legacy conversation stays pending. Other legacy runs finish
  backfill and ready succeeds. It retries on the next boot. Transactional write
  failures retain the original fail-closed recovery rule.
- F4: legacy recovered input can stay after requeue, expiry and purge. Released
  live membership is excluded from a new horizon. No current link is invented.
- F5: cloud-do remains private at 0.0.0. Its raw rows include internal fields:
  RunRow has membershipPending, admissionDigest, admittedSeqs as JSON text,
  settlementAck, revision and usage counters. InboxRow has inputDurable and
  revision. These fields remain part of the private row shape. Responses are not
  changed to hide them.
- F6: the default hook writes one run.settlement event for each terminal run.
- F7: a settlement hook deadline reports CLOUD_EXECUTION_TIMEOUT. No existing
  assertion pins the old timeout code.

For N unacked runs, consumer delivery has N concurrent hooks. The asynchronous
wait is at most 60 seconds plus local setup and ack work. Memory and local work
are O(N). The consumer owns any external connection limit. Backfill cost per boot
is one context read and at most 16 membership checks per pending legacy run.
Each pending run is visited at most once in that boot. Read failures stay pending.

Final verification ran with TMPDIR set to the permitted scratch directory.
The whole wake integration file passed all 128 tests in one run. The final package
script passed 852 Vitest tests and all 3 native wall-time tests. All requested
package and root commands exited 0. The owner will run the full root suite and
review recheck. No additional cross-model review request was sent after the fix.
