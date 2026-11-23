# Host upgrade to 0.46.0

This checklist covers the 0.45.0 or 0.45.1 → 0.46.0 upgrade. Hosts on an earlier
release first follow the [0.45.0 checklist](host-upgrade-0.45.0.md) and its
predecessors.

0.46.0 keeps wire v8. Existing 0.45.0 and 0.45.1 server databases, daemon journals,
provider stores, and device pairings carry forward in place. The breaking
migrations are [`pi-160-closure`](#pi-160-closure) and
[`dsh-session-log-upload-off`](#dsh-session-log-upload-off).
The [archived upgrade manifest](../../packages/client/upgrade-history/0.45.1-0.46.0.json)
records the Host-visible changes in this release.

## pi-160-closure

- Drain queued and in-flight Pi preparations before moving to 0.46.0. The official Pi 1.6.0 closure changes `closureDigest`. Inputs prepared with 1.5.2 fail with `preparation_runtime_identity_mismatch`. Prepare them again with 1.6.0 before dispatch.
- Pi-ai removed 48 chat model entries, including 40 from vendors and APIs in the keys catalog. Lookups for removed entries return `not_in_catalog`. Select a current catalog model or supply an explicit manual `pi_model` configuration.
- Pi-durable 1.6.0 opens replicas from SDK 0.45.x and Pi 1.5.2 without a SQLite schema migration. The downgrade boundary is one-way. Replicas with `pi.tool` v4 or `pi.generation` v3 fail to resume on 0.45.x and Pi 1.5.2 with `task_too_old`. Preserve a pre-upgrade copy if you need to roll back.
- Pi 1.6.0 pins `undici` 8.12.4. Hosts on 0.46.0 can remove the `package.json` override added for #2098. Refresh the lockfile and check that Pi resolves `undici` 8.12.4.
- MCP toolset search is qualified for SDK-built Pi 1.6.0 in the ordinary lane on macOS arm64 with `agentUserContext: 'inherit'`, the default SDK launcher, the bundled Pi entry, the Node distribution helper and SDK authorization `auto` or `all`. Admission matches this exact combination. [Pi 1.6.0 qualification receipt](../researches/2026-11-19-mcp-search-runtime-qualification.md#pi-160)

## dsh-session-log-upload-off

- DSH sessions opened by `DshAdapter` or `DaemonConfig.runtimes.dsh` now run with `sessionLogUpload: 'off'`. This covers root sessions, native child sessions, and resumes. Official DeepSeek requests no longer carry `dsh_session_log`, and the saved session gets no delivery-accepted watermark. The SDK adds no Host option to turn the upload back on.
- The change covers only the session-log uploader. DSH's separate `dsh_plugin_packages` request field and other provider metadata are unchanged, so this does not turn off all DSH telemetry.
- If DSH cannot confirm that the uploader is off, the open fails non-retryably before any model request. The failure's cause is an `UnsupportedOptionError` with `option: 'sessionLogUpload'`. Use a qualified DSH build that honors the setting, such as `0.2.2-rc.1`.
- Do not rely on SDK tasks to upload DeepSeek session logs. [#2446](https://github.com/Ancienttwo/byok-sdk/issues/2446)
