# Plan: Explicit macOS Keychain Path

> **Status**: Executing
> **Created**: 20260822-0415
> **Slug**: macos-keychain-path
> **Artifact Level**: work-package
> **Verification Boundary**: `@byok-sdk/keys` custody selection, Pi launcher argv, `@byok-sdk/client` config projection, packed release artifacts
> **Rollback Surface**: revert the additive config field and launcher flag before release; after release consumers remain compatible because the field is optional
> **Task Contract**: `tasks/contracts/20260822-0415-macos-keychain-path.contract.md`
> **Task Review**: `tasks/reviews/20260822-0415-macos-keychain-path.review.md`
> **Implementation Notes**: `tasks/notes/20260822-0415-macos-keychain-path.notes.md`

## Goal

Let an operator bind the macOS credential store to one explicit absolute
keychain file even when the launcher runs under an isolated `HOME`. Preserve
default-keychain behavior when the option is absent; never search two
keychains, synthesize credentials, or expose the secret in argv.

## P1 — Architecture Map

- `packages/keys/src/macos-keychain.ts` owns the `/usr/bin/security` boundary.
- `packages/keys/src/pi-provider-launcher-core.ts` owns the closed launcher CLI
  contract; `packages/keys/src/bin/pi-provider-launcher.ts` constructs the OS
  secret store.
- `packages/client/src/adapters/pi/pi-adapter.ts` projects daemon config into
  launcher argv; `packages/client/src/daemon/create-daemon.ts` validates that
  public config and protects reserved flags.
- `@byok-sdk/keys` is independently versioned; the public client config change
  also requires a patch of the aligned dispatch train.
- Salesko consumption and its local device config are downstream and out of
  this worktree until the registry artifact is frozen and read back.

## P2 — Concrete Trace

Salesko Local Agent config -> `DaemonConfig.piByokLauncher` -> `PiAdapter`
argv -> `byok-pi-provider-launcher` parser -> `MacOsKeychainSecretStore` ->
`security find-generic-password`. Today the final command omits a keychain
operand, so `security` resolves the default search authority from the isolated
launcher `HOME`; that HOME has no default keychain and the known item appears
absent. Supplying the exact login keychain path to the same lookup finds the
same service/account item without changing the Pi child environment.

## P3 — Design Decision

Add one optional `macosKeychainPath` datum and carry it unchanged through the
existing boundaries. Validate it as an absolute, non-empty, single-line path.
When present on macOS, use that path for availability, get, set, and delete;
when absent, keep the existing default-keychain commands. Reject the macOS-only
flag on other platforms rather than silently ignoring operator intent. This is
explicit authority selection, not a fallback or compatibility read.

At 10x provider/profile count the pressure point remains serial OS credential
lookups; this change adds no extra lookup and no new persistent authority.

## Task Breakdown

- [x] keys: explicit-path store semantics, launcher parser and store creation
- [x] client: public config validation, reserved flag, exact argv projection
- [x] regression evidence: capture pre-fix focused failure and post-fix focused pass
- [x] docs/release: document the option; patch dispatch train to `0.6.1` and keys to `0.2.2`
- [ ] canonical verification: build, typecheck, test, strict task workflow, pack-and-smoke (all except clean-commit pack complete)
- [x] acceptance: read-only gate review against the frozen diff
- [ ] ship: clean commit, push, merge, canonical publish + registry readback + GitHub Release
- [ ] downstream: consume exact registry versions in Salesko and run the approved external-agent smoke

## Stop Conditions

- Stop if implementation requires forwarding the parent `HOME` to Pi.
- Stop if an operation would read, print, rotate, or copy credential values.
- Stop if release artifacts do not resolve one exact internal version closure.
- Stop before any unrelated package or downstream production mutation.
