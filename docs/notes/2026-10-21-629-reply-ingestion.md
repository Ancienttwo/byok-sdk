# Issue 629: common Host reply transaction

Initial inspection baseline: d0350c6bf6c36dafd303179e3f1e5cef71b20ef9. The exact baseline core lacks consumeMessage; all eight initial new admission tests fail at that missing entrypoint. K8 previously reimplemented binding and acceptance directly in its application transaction.

This branch is stacked on PR623 at b09a42d01b2cbf2b5951c54ee7fb9e5486afc97a so receipt migration can use explicit permanent retirement evidence instead of guessing that missing records were compacted. PR623's main-sync commit already includes the readonly-toolset and ignored-wake changes; those were retained when resolving the import conflict. Only the #629 diff is intended for this PR.

K4 owns frozen binding, first acceptance and replay. Host callback business writes and projections share its SQLite transaction; synchronous hook and revoked publish closure prevent escaped write authority. K8 retains delegation rules and reply bodies but delegates admission. Legacy receipts lack a separate original device/context snapshot; promotion validates retained turn/execution identity, and incoming messages still match the frozen binding. Unknown or conflicting orphan state fails closed; exact permanent intent retirement is the only orphan exception and creates no receipt.

Validation includes new and legacy receipts, old-generation replay versus first stale delivery, transaction rollback, rejected asynchronous callbacks, exact binding refusal, file-backed close/reopen between Host acceptance and SDK disposition, projection acknowledgment followed by replay, and actual PR623 compaction preserving K8 business receipts. Reopen tests simulate the crash window deterministically; they do not claim a new process SIGKILL qualification. Real K4/K8 server-daemon tests use fake runtimes and no provider credentials.

Original dependency install encountered sandbox tempdir EPERM and then succeeded with authorized escalation. Initial test fixture type errors were corrected; they are not represented as passing runs. Full workspace tests remain assigned to coordinated CI; no per-issue matrix push is authorized while the user's resource hold is active.

Final local checks: root build, typecheck, API/entry-closure and version authority passed. K4 message/core/retention: 38 passed. K8 receipt/delivery/cross-Bot/readonly-toolset suites: 35 passed. Independent source/docs/test review approved, including explicit PR623 retirement integration. No full workspace suite or CI push was run for this slice under the shared resource hold.
