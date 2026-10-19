# WO-10 local follow-up

当前范围：跨 Bot 委派推迟到 K8b，安排在 #530 和 #531 合入后的第一张工单。
本轮跨 Bot 代码与测试已撤除（尚未写入，无需 revert）。

## P1 map

The ordinary main merge is `04d18bdc`. Its main parent is `433deced`.
The branch includes `a1c1226e`. It does not merge #531 head `23132486`.
K4 owns the execution FIFO, frozen task input, and device-terminal settlement.
K8a owns ContextPack admission, routine operations, and card decisions.

## P2 trace

A turn selects a declared recent history window. Schema composition and the
UTF-8 byte check occur before K4 enqueue. Rejections are reserved in the same
commit as frozen input. A pre-submit failure leaves that exact input in the
ledger. A new HostLedger connection and recover reuse the task id and payload.

## P3 decisions

- Keep the prior per-routine outbox backoff and independent routine progress.
- Use at most 12 recent turns and a 32 KiB selected ContextPack by default.
  Keep the current request mandatory. Remove only older history, report its
  omitted count, and block irreducible overflow with a readable reason.
- Pass current routine definitions and action-name outcome summaries only.
- Keep the 30-second connector deadline, abort signal, and failed conclusion.
- Use K4 package exports instead of relative src imports.
- Retry checked schema overflow once with flat schedules. Block repeated schema
  overflow. Propagate invalid-schema and outcome-bound errors as Host defects.
- Test only self-continuation crash recovery. Do not add cross-Bot data or code.

K4 already has Draft #532. No restack, new PR, push, gh edit, deployment, or
packages/ source change is part of this local-only work.
