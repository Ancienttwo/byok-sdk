# Issue 637: await durable Agent-home projection completion

Baseline: b86f8ec1b6bb61bb07a4cd7890efbb115379ac99 (fresh origin/main).
Issue: https://github.com/Ancienttwo/byok-sdk/issues/637

The baseline facade exposes enqueue/read only, requiring downstream polling.
No overlapping open PR or assignee existed when this isolated branch began.
The new await API subscribes before durable readback and uses exact-key wake
hints after cloud completion commits. No timer or polling fallback is added.
Existing device authentication and completion matching remain unchanged.

Synthetic regression evidence:
- Server: 12 tests passed across projection HTTP and waiter suites. All four
  terminal outcomes, already-completed reads, missing identities, offline abort,
  close/future wait rejection, read-to-wait race, no timer reads, concurrent
  same-key abort isolation, different-key isolation, read-error cleanup and
  draining outstanding reads before storage close are covered.
- Cloud: five projection tests passed, including observer exceptions, no observer
  on refused completion, and exact replay after commit.
- Workspace build/typecheck, API golden update and version authority passed.
- No duplicate full suite was launched; CI remains required.

Independent source review: root approved subscribe/read/wake and abort/drain
ordering before commit, requesting the now-added multi-waiter regression and
local-instance limitation. Root accepted three exact +135-byte closure budget
updates for cloud/cloud-dataplane/ui-runtime; no dependency restrictions changed.
Initial sandbox dependency installation failed; authorized standard bun ci
succeeded. No real credentials, user homes, or operational servers were used.

The API does not promise distributed notifications: another process writing
shared storage cannot wake this instance unless completion/replay reaches its
cloud path. Unknown requests return undefined. Caller AbortSignal owns offline
policy. No restore, deployment, publishing, or merge is included.
