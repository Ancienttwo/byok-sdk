# Prelaunch SDK integration review

Status: pending final acceptance; not ship-ready.

Independent reviewer: native Claude, read-only Read/Grep/Glob invocation against `c678548b05bf8e2d705f745b303c993d852a0339`. Review output retained at `/tmp/astra-sdk-integration-claude-review.md`; prompt and frozen diff retained beside it. No waiver or self-review substitution.

Confirmed source invariants: atomic original terminal bytes/hash/recovery marker; admission before claim; startup replay without runtime rerun; hash-bound transport confirmation; immutable task/device/Agent identity; cancellation outcome without rewriting original receipt; orderly close and unknown executable cursor refusal.

Blocking finding: a terminal exceeding the journal record cap is currently only logged, leaving the cloud attempt running until restart. The canonical outcome must explicitly fail with a bounded typed reason and remain durable/replayable; arbitrary I/O failures must not trigger semantic substitution. Fix and targeted independent recheck required.

Verification gap: predecessor hash-only SQLite schema must have an explicit refusal/preservation oracle. Darwin SIGKILL coverage remains platform-specific; Linux source CI is not native crash acceptance.

Root source build/typecheck/API/version/full tests passed before this finding. Exact packed artifacts, final native downstream CI and PR delivery are still pending; no registry publication or deployment is claimed.
