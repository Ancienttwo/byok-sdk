# Vendoring K8

K8 (`examples/bot-collaboration`) is a private workspace package and is not on
npm. A Host copies its source files into its own repository and owns the copy.
K4, the Host execution core, is not copied: it is published as
`@byok-sdk/server/execution-core` (see [K4](#k4)). This file lists what to copy,
in layers. A layer needs the layers above it.

`src/vendor-manifest.test.ts` walks the imports from each layer's roots and
checks each list below against that graph: the files, the packages, and the
names a list gives. So each list is complete for the commit it comes from.

How to read a list:
- A path line is a file to copy, relative to `examples/bot-collaboration`.
- Any other line is an import that the copy must resolve. Names after `:` are
  the only names that the layer imports from it.

## Record the source

Copy K8 from a release tag and install the SDK packages of that same version.
K8 is tested only with the `@byok-sdk/server/execution-core` of its own commit.
Record the tag and its commit in your repository, for example:

```text
byok-sdk v<version> <commit> examples/bot-collaboration
```

To update, read the diff of the folder between the recorded commit and the new
one, and the `Breaking (examples)` entries of `CHANGELOG.md` in that range:

```sh
git diff <recorded-commit>..<new-commit> -- examples/bot-collaboration
```

## Published SDK packages

The copy imports `@byok-sdk/protocol`, `@byok-sdk/core`, `@byok-sdk/server` and
`@byok-sdk/client` from npm. Layers 2 and 3 need all four, because they need
the K4 root entry, `@byok-sdk/server/execution-core`. Layer 1 needs only the packages
its list names. These packages are released
together under one version. Use exactly the version of the tag you copied. A commit between tags
can use package changes that are not on npm yet. K4 needs Node 24.15 or later,
because its ledger uses `node:sqlite`.

## Layer 1: rules

`src/rules/` holds the pure rules: no I/O, no ledger and no clock (#606 §5.5).
`src/rules-boundary.test.ts` also holds this layer to its imports.

The rules import `hash` and `canonical` from the K4 canonical entry,
`@byok-sdk/server/execution-core/canonical`, never the K4 root entry (#884).
That entry imports only `node:crypto`, so a copy of this layer alone needs no
`node:sqlite` or `node:async_hooks` (see [K4](#k4)).

```vendor rules
src/rules/cards.ts
src/rules/coalesce.ts
src/rules/commands.ts
src/rules/commit.ts
src/rules/compaction.ts
src/rules/context.ts
src/rules/delegation.ts
src/rules/due.ts
src/rules/frame.ts
src/rules/history.ts
src/rules/message.ts
src/rules/outcome.ts
src/rules/rooms.ts
src/rules/schema.ts
src/rules/sync.ts
src/rules/team.ts
src/rules/turn.ts
@byok-sdk/core
@byok-sdk/protocol
@byok-sdk/server/execution-core/canonical: canonical hash
```

## Layer 2: L Host

The roots are `src/host.ts` (`BotCollaboration`) and `src/index.ts`. The package
entries other than the vectors are in this layer too. `src/persona.ts` is the
daemon side of the persona projection. It is the only K8 file that imports
`@byok-sdk/client` directly.
`src/migration.ts`, the owner switch format, takes `validateJson` and K4
types from the K4 root entry, and `hash` and `canonical` from the canonical entry.
`src/switch.ts` is the L side of the owner switch: it reads an L ledger into
that format and writes the format into an L tenant.

```vendor host
src/channel.ts
src/coalesce.ts
src/commit.ts
src/compaction.ts
src/delegation.ts
src/delivery-routing.ts
src/delivery.ts
src/history.ts
src/home-projections.ts
src/host.ts
src/index.ts
src/migration.ts
src/model.ts
src/persona.ts
src/retention.ts
src/rooms.ts
src/routines.ts
src/schema.ts
src/switch.ts
src/team-model.ts
src/team.ts
src/toolset-policy.ts
src/topology.ts
@byok-sdk/client
@byok-sdk/core
@byok-sdk/protocol
@byok-sdk/server
@byok-sdk/server/execution-core
@byok-sdk/server/execution-core/canonical: canonical hash
node:crypto
```

## Layer 3: shared vectors

The roots are the package entries `./test-support`, `./retention-vectors`,
`./routine-vectors` and `./delivery-vectors`. Each runs the same cases against a
Host's own store, as the hosted example does on Postgres. The vectors need
layers 1 and 2: `CollaborationState`, the outcome schema and the routine rules
come from L files. They also import `hash` and `taskId` from the K4 root, and
they run on vitest.

The commit vectors import only `template` from K4 `test-support`, and the test
holds them to that one name. Do not copy K4 `src/test-support.ts`. It is the
SDK repository's real server and daemon smoke helper. It loads a test
enrollment store from `scripts/testing/`, whose types come from the client
package source, and a stub runtime adapter from the basic example. Resolve
`@byok-sdk/example-host-execution-core/test-support` to a module of your own
instead. Copy the `policy` constant and the `template(deviceId, agentId =
'main')` function from `examples/host-execution-core/src/test-support.ts` into
it. They need only `AgentEgressPolicy` from `@byok-sdk/client` and
`ExecutionTemplate` from `@byok-sdk/server/execution-core`, so the module
typechecks against the published packages. Keep the returned value the same as
the example's.

```vendor vectors
src/commit-vectors.test-support.ts
src/delivery-vectors.test-support.ts
src/retention-vectors.test-support.ts
src/routine-vectors.test-support.ts
@byok-sdk/core
@byok-sdk/example-host-execution-core/test-support: template
@byok-sdk/protocol
@byok-sdk/server/execution-core
vitest
```

## K4

K8 imports K4 from the published `@byok-sdk/server` package (#1106): the root
entry `@byok-sdk/server/execution-core` and the Worker-safe
`@byok-sdk/server/execution-core/canonical`. Nothing of K4 is copied. The
[execution core API](../../../docs/host-execution-core.md) describes both
entries.

## Not vendored

K8's own test helpers and the `submit_result` measurement runner. No layer
imports them.

```vendor unvendored
src/channel-contract.ts
src/cross-bot.test-support.ts
src/import-scan.test-support.ts
src/routines.test-support.ts
src/second-device.test-support.ts
src/team.test-support.ts
src/submit-result-measurement/
```
