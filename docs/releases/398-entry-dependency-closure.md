# Entry dependency contract (#398)

This source change is unreleased. No registry publication is performed by this PR.

The schema-free public entry is `@byok-sdk/protocol/constants`. The former
preparation-version subpath is removed in the same cut. Migrate the version
import to `/constants`; there is no alias. Protocol root re-exports the same
single definitions, plus `PREPARED_AGENT_MEMORY_MODES` and
`isPreparedAgentMemoryMode`. Schema enum values and frozen wire v2 bytes do not
change. Separately bundled entries have distinct object identities for arrays
and transition maps; compare their values.

The root README projects the committed entry contract. Policies are authored
manually; budgets are measured workspace static bytes plus 10 percent. Facts
follow relative and workspace exports-map edges and third-party modules.
Literal lazy edges are reported separately. Zod's protected Function probe is
reported for assertion-client via core; this change does not replace assertion
parsing. UI runtime's existing cloud/Hono/Zod closure is recorded without adding
a cloud API subpath.

`nodeBuiltins` separates workspace and third-party policies. The Worker dataplane
keeps first-party Node-only code forbidden while recording pg's existing
nodejs_compat requirements. Opaque references, missing optional dependencies,
conditional CJS branches and UMD factories are disclosed in the entry contract
and README. A strict codegen/builtin policy cannot claim safety for unresolved
source. This static report is not a CSP sandbox or a complete runtime execution
proof.

Test migration moves codegen, specifier, dependency and budget assertions into
shared fixtures and per-entry policies; the client retains its own splitting
and private lazy-edge pins. Cloud-do declaration checks remain; runtime builtin
fixtures now exercise the centralized policy, including transitive edges.
Freeze goldens remain unchanged.
