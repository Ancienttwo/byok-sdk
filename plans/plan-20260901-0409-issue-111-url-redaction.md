# Plan: Issue 111 secret-safe server URL validation errors

> **Status**: Executing
> **Created**: 20260901-0409
> **Slug**: issue-111-url-redaction
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #111
> **Artifact Level**: work-package
> **Promotion Reason**: The transport-security gate interpolates credential-bearing raw URL input into user-visible errors.
> **Verification Boundary**: Audit-baseline secret sentinel failure, focused URL behavior, client/root checks, strict workflow, and independent acceptance.
> **Rollback Surface**: Revert the structural diagnostic formatter and focused tests together.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0409-issue-111-url-redaction.contract.md`
> **Task Review**: `tasks/reviews/20260901-0409-issue-111-url-redaction.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0409-issue-111-url-redaction.notes.md`

## Agentic Routing

- Selected route: regression-first security bugfix with exact-scope acceptance.
- P1 map: `assertServerUrlAllowed` is the synchronous client entry gate; parsed transport helpers already use structural URL projection elsewhere.
- P2 trace: raw configured string -> WHATWG `URL` parse -> scheme/loopback decision -> `InsecureServerUrlError`; current parse/insecure/unsupported branches interpolate `rawUrl`.
- P3 decision rationale: successful parses format only protocol, host, and pathname; parse failures emit a generic diagnostic without input. Never scrub or reparse secrets with regex, and preserve allow/deny ordering.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| Structural projection | selected | Sensitive URL components are omitted by construction while actionable endpoint context remains. |
| Regex/redaction scrub | rejected | It creates a shadow parser and cannot safely classify malformed credential-bearing input. |
| Echo bounded malformed input | rejected | Bounded secrets are still secrets; malformed input has no trustworthy projection. |

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/url.ts` | modify | Replace raw URL interpolation with one secret-safe parsed projection and generic parse error. |
| `packages/client/src/__tests__/url.test.ts` | modify | Assert sentinels absent for insecure, unsupported, and malformed URLs while behavior remains unchanged. |

## Task Breakdown

- [x] Freeze the audit-baseline secret leak with a non-zero artifact.
- [x] Remove raw URL interpolation from every validation error branch.
- [x] Preserve loopback, TLS, unsupported scheme, and escape-hatch behavior.
- [ ] Run focused/client/root checks, strict workflow, and independent acceptance.

## Evidence Contract

- **State/progress path**: this plan, contract, notes, and review.
- **Verification evidence**: pre-fix artifact, deterministic sentinel guards, package/root checks, and typed AcceptanceReceipt.
- **Evaluator rubric**: no userinfo/password/query/fragment or malformed raw input in messages; scheme/host/path context remains after successful parsing.
- **Stop condition**: all task rows pass and strict state is accepted.
- **Rollback surface**: one formatter plus focused URL tests.

## Promotion Gate

- **Merge/PR unit**: #111 diagnostic redaction only.
- **Rollback surface**: structural diagnostic projection and focused sentinel tests.
- **Verification boundary**: exact isolated diff and strict acceptance.
- **Review/acceptance boundary**: one independent gatekeeper and one protocol-2 AcceptanceReceipt bind the normalized source subject.
- **High-risk surface**: credential exposure through logs/CLI/telemetry.
- **Why not checklist row**: security-sensitive diagnostics require explicit pre-fix leakage evidence and semantic review.
- **Not authorized**: merge, push, PR, issue close, publish, deploy, migration, or production mutation.
