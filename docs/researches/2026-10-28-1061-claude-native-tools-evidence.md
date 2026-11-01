# #1061 Claude native allowlist: contract and qualification

Scope: D6-approved Claude-only slice, based on `bab2993840814a6f2732cfb7df71612dec92cdbd`. Grok/OAR changes are excluded. This note records actual native CLI evidence separately from the adapter fixture tests, which the implementation agent did not run.

## Public option and ownership

`ClaudeAdapterOptions.agentBuiltinTools` is `inherit` (default) or a readonly array of exact `ClaudeBuiltinToolName` values. Only operations whose sealed manifest has `agentRef` receive `--tools`; non-Agent operations retain their existing native defaults. An empty array emits one actual empty argv element. `inherit` is an SDK option value, not a tool name.

The constructor validates and freezes a copy before any binary resolution, process spawn or model request. Unknown names, permission patterns, MCP names, duplicates, sparse arrays and malformed values are rejected. Caller mutation cannot change fresh/resume/followUp policy. Fresh/resume use the same startup path; followUp reuses the process. A new adapter may deliberately narrow a resumed session's policy.

MCP stays independent: existing task/SDK `--mcp-config` projection and `--strict-mcp-config` behavior are unchanged. This option does not change user settings, hooks, skills, plugins, user-context exclusions, permission modes or session persistence. It is not a filesystem sandbox or an exhaustive list of all code the runtime/user hooks/Host MCP can execute. Native subagents were not separately exercised; their error-message wording is not evidence of every subagent mode.

Only `adapters/claude/claude-adapter.ts` changes product behavior. No root types/index/spec/README, other runtime, vendor, API golden, budget or version changes are included.

## Naming authority: actual 2.1.302 requests

Binary: Darwin arm64 Claude **2.1.302**, SHA256:

```text
5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37
```

The same binary was used throughout. Source was `/Users/chris/.bun/install/global/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude`; byte-identical executable copy ran under `/private/tmp/byok-1061-claude-probe.bA8f7e` so the sandbox could deny the entire real user home.

Three additional naming cells, each exit 0 with one local Messages request:

| Input | Actual `system/init.tools` / model tools | Decision |
| --- | --- | --- |
| `--tools Read,DefinitelyNotAClaudeTool1061` | Only Read in both; the CLI silently ignored the unknown name and still called the model endpoint | Do not delegate name validation to the CLI or wait for post-request init/readback |
| `--tools default` | Observed native set below; init calls the first tool Task, while the model schema calls it Agent | Author names from model schemas, not display labels |
| Explicit comma-separated list of the 24 model names | Same 24 model schemas, including Agent; no added tools | Freeze this bounded exact-name SDK contract; no local alias or permission-pattern parser |

Qualified name contract:

```text
Agent Bash CronCreate CronDelete CronList Edit EnterWorktree ExitWorktree
ListAgents NotebookEdit Read ReportFindings ScheduleWakeup SendMessage Skill
TaskCreate TaskGet TaskList TaskStop TaskUpdate WebFetch WebSearch Workflow Write
```

`Task` is not an accepted SDK alias for `Agent`. Neither `default`, `Bash(git *)`, comma-containing elements nor `mcp__server__tool` is a native name in this API. Tool names not in the observed set require a new qualification and explicit contract extension; they are not guessed from older documentation. Enumeration qualification proves exact names reach the model registry, not that every listed tool's side effect was executed. The adapter's existing version-detection behavior is unchanged; the native guarantees here are qualified only for this binary/OS, not every future or other-platform CLI build.

## Isolation and protocol evidence

All native cells used explicitly constructed synthetic HOME/config/key environments, never an inherited environment merge. A local HTTP server bound to 127.0.0.1 implements Anthropic SSE; all captured requests are `POST /v1/messages?beta=true` with the synthetic key. Claude/MCP children run inside macOS sandbox-exec: deny network except localhost, deny real `/Users/chris`, system keychains and managed Claude config reads/writes, and deny securityd mach lookups. A security shim returns item-not-found; update/telemetry/nonessential traffic are disabled. No cloud endpoint, real token or paid model call is used.

Before the first native invocation, an isolation canary proved external connect and real-home read return EPERM while loopback works. One initial profile syntax failure was fixed before any Claude process started. A same-sandbox write canary proved the sentinel directory writable. No subsequent fixture failure loop occurred.

CLI cost fields are arithmetic over synthetic endpoint-reported token usage; they are not provider charges. Originals retain those values rather than replacing them with zero.

## Real fresh/following-request/resume cells

| Cell | Actual observation |
| --- | --- |
| Fresh empty native set | init and model tools both empty; one request, normal completion |
| Fresh Read + hostile unadvertised Bash | Both requests show only Read; native emits `No such tool available: Bash`; sentinel absent |
| Fresh empty + explicit Host MCP | Only `mcp__probe__ping`; real stdio tools/call returns MCP_LOCAL_OK |
| Normal resume, Read narrowed to empty | Exact saved session ID; empty model tools; new hostile Bash rejected, sentinel absent |
| Normal MCP resume | Exact saved session ID; MCP remains advertised and real call succeeds |
| Read + acceptEdits/stdio permission mode | initialize handshake succeeds; all three requests have Read + MCP. Bash rejected before any permission callback; the sole can_use_tool is MCP, allowed once with unchanged input, and executes successfully |
| Legitimate interrupted Bash, then empty-set resume | Initial allowed native Bash executes once. CLI transcript persists tool_use without tool_result before interruption. Resume synthesizes an interrupted/unknown result for that old ID instead of rerunning it; model tools empty; new hostile Bash also rejected |

For the pending cell, the harmless command wrote independent initial/resume counters inside the probe directory and self-terminated after 8 seconds. Only the owned Claude process group was signalled. The native-spawned command used a separate group: it was not signalled; the probe waited for its bounded natural exit and verified its exact PID gone before resume. Before/after-interruption native transcripts were byte-identical and lacked the pending tool_result. No transcript was fabricated or edited.

The resumed first request retained the old tool_use and the CLI-generated result:

```text
[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]
```

Final counters: initial **1**, resume **0**; no resume started/finished markers. Thus native denial is not a file/network-sandbox false positive. It does not imply cancellation rolled back initial side effects, nor qualify every background/subagent/multiple-pending resume shape.

Previous cells made 15 local Messages requests; the three naming cells add 3, total **18**. Raw artifacts live under the probe root: `{empty,read-hostile,mcp,resume-hostile,resume-mcp,stdio,pending,pending-resume,unknown,native-catalog,explicit-native-catalog}.{launch,requests,responses,summary}.json`, stdout JSONL, `pending.*transcript.jsonl`, `mcp.calls.jsonl`, isolation and cleanup receipts. Human-readable full run record: main checkout `_ops/issue-lanes/1061-s3-claude-probe.md`. Local artifact paths are evidence locations, not shipped runtime inputs.

## Fixture changes and assertion accounting

No existing test assertion is changed or removed. New `claude-native-tools.test.ts` covers defaults, Agent-only scope, exact empty/Read arguments, malformed/unknown/pattern inputs rejected before binary resolution or spawn, constructor snapshot, hostile rejection, followUp/resume, initial-write versus denied-resume sentinels, and actual local MCP call preservation.

Changes to `fake-claude.mjs` are limited to:

1. Accept the new `--tools` argv flag (otherwise valid adapter launches would be rejected by the fixture).
2. Expose the selected native set in init; omitted flag retains the old fixture defaults.
3. Return the observed native disabled-tool error for unselected Bash/Write before permission or write behavior; selected/default tools retain existing paths. MCP execution is not filtered by this native set.

The fake does not implement native session persistence/pending recovery. Those assertions belong to the real CLI cells above; the unit resume tests prove adapter wiring only. The real stdio permission cell likewise qualifies the CLI; existing native-interaction tests remain the product callback coverage.

## Parent verification (not run by implementation agent)

```sh
bun run build
bun run --filter @byok-sdk/client test -- src/__tests__/claude-native-tools.test.ts src/__tests__/claude-adapter.test.ts src/__tests__/claude-native-interactions.test.ts src/__tests__/claude-agent-user-context.test.ts
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

Parent owns integrated-head checks, public API review and any deliberate golden/budget updates; none are preemptively changed here. This new option/type may require an API-surface update at that boundary. Only diff inspection and `git diff --check` are performed in the implementation lane.

## Parent acceptance

Root build/typecheck/version-authority pass; four focused files pass 132 tests. Independent Codex source/test review passes. A separate real SDK probe imports the built public client entry and runs ClaudeAdapter.prepare → operation.start on Claude 2.1.302: Read fresh, empty fresh, and Read→empty resume all reject hostile Bash, leave their sentinels absent and successfully call Host MCP (nine local Messages requests total). Source/dist hashes were unchanged during that probe; sessions, scratch and child processes were cleaned up. This SDK evidence is distinct from the earlier direct-CLI permission/pending-resume cells.

Recovery candidate #1071 is integrated without product-source conflicts; build/typecheck and the same 132 tests pass on the combination. Coordinator wB:p4 signs the new local option/type and four measured +1160 B closures under #1008 authority. Current client/CLI limits also include #1071's signed +20 B: client 1846179 B, adapters 329661 B, testing 315147 B and byok-agent 1790830 B. No other budget expansion. Final API readback and PR CI remain separate from publication, S2 filesystem authority and Grok support.


Composition with the preceding reviewed SDK candidates preserves the signed +1160 B increment in each of the four entries. Measured limits: client 1852142 B, adapters 333737 B, testing 319223 B and byok-agent 1796784 B; no additional headroom. Both Pi and Claude tool-selection descriptions remain in the client README, and generated entry facts are rebuilt from the combined source.
