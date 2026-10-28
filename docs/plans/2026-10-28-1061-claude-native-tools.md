# #1061 S3 Claude native tools

> 已被 [2026-10-28-1061-auth-auto-all.md](2026-10-28-1061-auth-auto-all.md) 取代：工具白名单与 `inherit` 默认路径已删除，产品只保留 `auto` | `all`。以下为历史记录。

状态：Claude-only 实施切片；父方验收待执行。Base `origin/main` = `bab2993840814a6f2732cfb7df71612dec92cdbd`。

授权：D6 已批准 runtime 独立选项；owner 本轮批准 Claude-only 实施。真实零费用资格与命名合同见 `docs/notes/2026-10-28-1061-claude-native-tools-evidence.md`；Grok 不在本切片。

## P1 / P2

ClaudeAdapter 自有 stream-json 路径：constructor options → prepare/start 的 sealed manifest.agentRef → 统一 fresh/resume argv → 原生工具 registry/executor；followUp 复用同一 process。task MCP 由独立 mcp-config 投影，nativeInteractions 只切换 permission transport。无需修改 root types、events/control-channel 或 vendor。

2.1.302 的 unknown-name cell 表明 CLI 静默忽略未知名字并发请求，不能依赖 CLI 拒绝。新增精确模型工具名字合同，由真实 `--tools default` 和显式完整列表请求交叉验证；constructor 在任何 spawn 前校验并复制冻结名单。`Task` 是 init 展示名而模型名为 `Agent`，本 API 只接收 `Agent`，不新增 alias/permission-pattern parser。

## P3 / 固定合同

- `ClaudeAdapterOptions.agentBuiltinTools`: 默认/显式 `inherit` 不加参数；readonly 名单仅对 manifest 有 agentRef 的操作生效。空名单传真实空 argv element。
- fresh/resume 使用同一冻结策略，followUp 不改变进程策略；原生拒绝未公布工具，pending transcript 不恢复工具能力。SDK 不在首个模型请求之后补救无效配置。
- MCP 不列入 native 名单，继续独立保留；settings/hooks/user-context/permission 语义不变，不承诺 filesystem 或全部可执行能力隔离。
- 仅修改 Claude adapter、专用 Claude tests/fake fixture、此计划及独立 notes。现有测试断言不修改。
- 10 倍规模仍是固定 24 名字集合与每 adapter 一次校验/复制，无每 turn 的扫描或运行时额外 probe。新工具需显式重新资格并扩合同；不猜测新名字。

## 验证分工

实施 agent 只做 diff 自审和 `git diff --check`；不运行 build/typecheck/tests。父方：先 build，再局部 `bun run --filter @byok-sdk/client test -- src/__tests__/claude-native-tools.test.ts src/__tests__/claude-adapter.test.ts src/__tests__/claude-native-interactions.test.ts src/__tests__/claude-agent-user-context.test.ts`，然后按集成范围执行 required checks/API surface review（本切片不更新 goldens/budgets）。fixture 证明 wiring/回归，真实 CLI 资格证明 native 行为，二者不能互相替代。
