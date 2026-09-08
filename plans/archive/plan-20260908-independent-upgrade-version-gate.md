# Plan: independent upgrade protocol admission

> **Status**: Completed
> **Spec**: docs/spec.md
> **Base**: 62e83ae9ac76e38b5448307fec02850f780d7347

## Authority and scope

User requests SDK responsibility verification using the Salesko independent
upgrade Handoff, repair and acceptance of proven SDK defects, and no Salesko or
production changes. Preserve all existing worktrees. Local source and disposable
candidate artifacts are in scope; publication, deployment and data migration are
not. Existing R7–R13 repairs are reused from the base, not reimplemented.

## P1 / P2 / P3

- P1: protocol owns envelope validation; client long-poll parsing precedes
  dispatch and durable receive cursor; cloud request parsing and its exported
  inbound gate precede lifecycle mutation and acknowledgement. Application
  release identity and host task requirements remain separate authorities.
- P2: test an otherwise valid known message carrying an unsupported wire major
  through actual client receive and cloud admission, with a v1 positive control.
  Assert no execution delivery, cursor retirement, lifecycle mutation or accepted
  receipt for unsupported work. Record pre-fix failure before implementation.
- P3: if the bypass is proven, reject unsupported majors against the existing
  protocol authority at validation/admission boundaries. Preserve every supported
  v1 payload, public TypeScript shape and exact ACK identity. Do not add v2,
  synthesize fields, downgrade tasks or add a migration. At 10x traffic, repeated
  invalid entries exert existing bounded retry/backpressure rather than gaining
  permission to execute or disappear.

## Task Breakdown

- [x] Prove the version bypass on the frozen base with real boundary regressions.
- [x] Apply the smallest owning-layer correction and verify the regression.
- [x] Freeze the source; run required checks and disposable package smoke.
- [x] Return the seven-row responsibility matrix, source/artifact evidence,
  lifecycle usage and specific cross-version evidence gaps in docs/researches.

## Evidence boundary

The requested previous Local Agent artifact is not specified. Synthetic older
release labels are observability tests, not real cross-release upgrade evidence.
The existing consumed artifact subject is 2752ffe; baseline/new main facts and
the repair candidate must remain separately identified in the return report.
