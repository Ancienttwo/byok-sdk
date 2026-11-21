# Host upgrade to the next MINOR

This checklist starts after the published 0.45.0 release. Hosts on an earlier release first follow the
[0.45.0 checklist](host-upgrade-0.45.0.md) and its predecessors.

## pi-160-closure

- Drain queued and in-flight Pi preparations before moving to 0.46.0. The official Pi 1.6.0 closure changes `closureDigest`. Inputs prepared with 1.5.2 fail with `preparation_runtime_identity_mismatch`. Prepare them again with 1.6.0 before dispatch.
- Pi-ai removed 48 chat model entries, including 40 from vendors and APIs in the keys catalog. Lookups for removed entries return `not_in_catalog`. Select a current catalog model or supply an explicit manual `pi_model` configuration.
- Pi-durable 1.6.0 opens replicas from SDK 0.45.0 and Pi 1.5.2 without a SQLite schema migration. The downgrade boundary is one-way. Replicas with `pi.tool` v4 or `pi.generation` v3 fail to resume on 0.45.0 and Pi 1.5.2 with `task_too_old`. Preserve a pre-upgrade copy if you need to roll back.
- Pi 1.6.0 pins `undici` 8.12.4. Hosts on 0.46.0 can remove the `package.json` override added for #2098. Refresh the lockfile and check that Pi resolves `undici` 8.12.4.
- MCP toolset search admission is version-specific. The existing Pi receipt covers 1.5.2. Hosts using search exposure on Pi need a 1.6.0 qualification before enabling it on the new pin.
