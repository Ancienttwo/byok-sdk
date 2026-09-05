# Pi notification interaction authority

Selected boundary: owned RPC child and GUI JSONL interaction, explicitly approved
by the user. Exact package-local subject: @earendil-works/pi-coding-agent 0.85.1.
Source base: 5af5c5c; isolated branch codex/team-pi-relay. No native TUI adoption.

## P1: authority map

TeamWorkspace owns grants, messages and delivered/acknowledged receipts. The
shared notification relay owns only a process-local watermark and finite attempt
budget. Codex receives an exact-thread native queue request. Pi is a fresh owned
RPC process with explicit provider/model/cwd/session directory and Team MCP grant.
The existing TaskRunner retains its unattended UI cancellation policy; the new
host explicitly selects hold/GUI response. tmux remains an observation surface.

Pi 0.85.1's public ui_prompt_start/end events coalesce overlapping prompts into a
single span. runner.js setUIContext wraps the public UI methods and schedules
lifecycle events in microtasks. These are best-effort notifications, not awaited
admission decisions. The first-loaded SDK extension synchronously observes them
and holds input and before_provider_request hooks. --no-extensions suppresses
ambient extensions; explicit loading order is guard, MCP, operator allowlist.
There are no private Pi-field patches or local guesses at external UI semantics.

## P2: concrete path and tested pressure point

Codex post → authenticated snapshot → Pi readiness → native prompt preflight →
input/provider gate → Pi Team MCP read/post/ack → peer snapshot → Codex queue.
The host requires matching session UUID, monotonic gate revision, no outstanding
GUI request and idle/noncompacting state. Only a native prompt receipt advances
the notification watermark; it never advances a durable message receipt.

The hook yields a microtask on entry and after each span-end wake, then rechecks
state. This catches an immediately following dialog opened by a continuation.
Normal run abort can leave a hold; fatal state stays held until the owned child
is stopped. Native RPC processes GUI replies independently while a hook waits.
Already admitted provider requests cannot be recalled by opening a later dialog.

Real 0.85.1 CLI probes found that direct extension stdout is redirected to stderr.
The guard therefore projects its JSON through public ctx.ui.setStatus using the
reserved key byok_team_gate. This stays within native RPC serialization and order.
The host validates the payload and never interprets terminal output as authority.

## P3: selected tradeoffs

Native pendingExtensionRequests can expire without emitting an exact-ID close
receipt. Host IDs are GUI inventory, not the native admission authority. Never
infer expiry, clear all IDs on a span end, or call clear_queue to retract work.
The GUI explicitly answers/cancels exact session/request IDs. A response receipt
means sent, not native acceptance; an expired ID may be ignored by native Pi.
This deliberately retains a stale GUI item until explicit dismissal.

Busy Pi notifications wait; no new automatic admission occurs during the span.
A preflight race can hold a submitted prompt; a 30-second RPC deadline stops the
owned child if delivery remains unresolved. Rejection and unknown delivery both
stop the epoch without automatic retries. Budget exhaustion stops admission and
allows accepted Pi work up to 120 seconds to reach agent_settled. Explicit stop
or GUI stdin EOF tears down the owned child. Session replacement/reload is not
supported; identity/revision discontinuity fails closed. Extensions must not open
a UI prompt before session_start; startup without established authority fails.

At 10x traffic, finite notification budget and coalesced watermarks bound relay
work; GUI inventory and concurrent commands cap at 32. This is a two-member local
integration, not a cloud dispatcher or general GUI application.

## Independent review and evidence

Existing tmux Claude %6 (77947b83-8e45-4dfd-9cbe-eedecf893af6) independently verified
the dispatcher ordering, wakeup race and RPC response path. Tests use the exact
native package with synthetic handled input, avoiding provider calls for admission
proofs. Final source review/checks and bounded actual Codex↔Pi results belong in
tasks/reviews/20260906-0311-team-pi-relay.review.md and
docs/researches/evidence/2026-09-06-pi-relay/results.json.

The older 0.84.2 native TUI counterexample remains historical evidence against
isIdle-only gating. Its source fingerprints are not current-source acceptance.
Main's runtime-event-spill work, global Pi installs, merge and release are outside
this worktree's scope.


Review disposition: the 30-second command deadline and 120-second settlement
limit are explicit host lifetime budgets, not deductions of native dialog expiry.
They intentionally continue during GUI waits. A readiness/send race that changes
host admission state stops conservatively; it does not retry or consume an
unbounded session. GUI inputs are tracked through a subsequent native get_state
receipt so budget drain cannot miss their preflight/start transition.
