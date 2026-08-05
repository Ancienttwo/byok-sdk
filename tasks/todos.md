# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-08-05 17:02
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Port the platform-selecting default secret-store factory (`createDefaultLocalAgentSecretStore`, `index.ts:712-740`) including its release-channel service-prefix selection | Named by neither the plan's K1 nor K2 entry. It also carries a branding decision — the source picks the prefix from a vendor-specific environment variable — that needs an owner before it can be ported. | Callers construct `MacOsKeychainSecretStore` / `WindowsCredentialManagerSecretStore` and branch on platform themselves. Nothing is blocked: `ProviderRegistry` takes its `SecretStore` by injection. | K4's aip-main-open swap, which needs a drop-in replacement for the source factory, or any consumer asking for one-call setup. |
| Port the scope data-directory manifest (`prepareLocalAccountDataScope`, `local-data-scope.ts:50-98`): the `0o700` profile directory plus its `scope.json` collision check | Named by neither the plan's K1 nor K2 entry. K1 ported the secret-side scope envelope; this is the filesystem-side partition, which only matters once a caller keeps per-tenant profile databases. | `SqliteProviderProfileStore` takes a path, so a caller partitions by passing a per-tenant path and forgoes the manifest's cross-tenant collision check. | A consumer running more than one tenant on one machine, or K4 if aip's existing profile directories must be honored. |
