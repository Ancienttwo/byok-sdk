> **Archived**: 2026-08-07 02:01
> **Related Plan**: plans/archive/plan-20260807-0145-sdk-architecture-consolidation.md
> **Outcome**: Completed
> **Source Plan**: (none)
> **Parent Run ID**: run-20260807-0201

# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-08-06 10:05
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Port the platform-selecting default secret-store factory (`createDefaultLocalAgentSecretStore`, `index.ts:712-740`) including its release-channel service-prefix selection | Named by neither the plan's K1 nor K2 entry. It also carries a branding decision — the source picks the prefix from a vendor-specific environment variable — that needs an owner before it can be ported. | Callers construct `MacOsKeychainSecretStore` / `WindowsCredentialManagerSecretStore` and branch on platform themselves. Nothing is blocked: `ProviderRegistry` takes its `SecretStore` by injection. | K4's aip-main-open swap, which needs a drop-in replacement for the source factory, or any consumer asking for one-call setup. |
| Port the scope data-directory manifest (`prepareLocalAccountDataScope`, `local-data-scope.ts:50-98`): the `0o700` profile directory plus its `scope.json` collision check | Named by neither the plan's K1 nor K2 entry. K1 ported the secret-side scope envelope; this is the filesystem-side partition, which only matters once a caller keeps per-tenant profile databases. | `SqliteProviderProfileStore` takes a path, so a caller partitions by passing a per-tenant path and forgoes the manifest's cross-tenant collision check. | A consumer running more than one tenant on one machine, or K4 if aip's existing profile directories must be honored. |
| Add a generic `ProviderRegistry.testConnection()` (test-before-save at the registry level) | K3 dropped the settings-page server, and with it the only in-package caller. aip's equivalent routes through `createNarrativeProvider().testConnection()`, a §4.5 symbol that stays in aip, so this would be new design rather than a port — and K3 was authorized as a docs-only slice, so adding a registry API was out of scope. | Hosts verify a key today by resolving a client and calling `testConnection()` on it, which is two calls instead of one and requires the host to know the client types. | K4.1's aip-side adapter, or the first host UI that needs test-before-save without reaching for the client. |
