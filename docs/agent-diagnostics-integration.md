# 下游 Agent 诊断与修复构建指引

本指引由 BYOK SDK 维护。SDK 负责交付可复用诊断、有限修复、接入方法及验收边界；下游负责将这些能力接入自己的身份、授权、安装方式和用户界面。缺少通用能力时，由 SDK 补齐接口与证据，不能要求每个下游自行实现 journal 修复或猜测 Agent 健康。

适用范围：当前仓库的 `@byok-sdk/client` CLI。本文不是已发布版本或下游上线证明；集成验收必须绑定下游实际打包的 SDK/CLI 版本。产品权威见 [spec](spec.md)，本地运维细节见 [self-hosted runbook](../deploy/runbooks/self-hosted-operations.md)，云端故障另见 [hosted runbook](../deploy/runbooks/hosted-operations.md)。

## 1. P1：能力与责任地图

| 层 | SDK 提供并负责维护 | 下游需要接入 |
| --- | --- | --- |
| 本地诊断 | `doctor --json`、runtime probe、health/journal/workspace 检查、authenticated control 查询 | 本地执行入口、结果展示、诊断时间与目标设备 |
| 有限修复 | `doctor --fix --yes` 对确认损坏的 health 文件保全证据并隔离，独占 store lease | 显示实际作用与影响范围、用户确认、停止/恢复宿主服务、修复后复查 |
| 执行恢复 | SDK journal、terminal/recovery authority 与资源生命周期 | 展示 interrupted/未确认状态；按业务副作用决定是否提交新任务 |
| 产品身份 | SDK 消费明确绑定，不猜默认 Agent | 用产品权威选定 tenant、device、AgentRef 和相关 task |
| 凭证与配置 | 既有 credential custody、exact binding 与错误边界 | 进入该 Agent 的授权/配置界面；不把 secret 传进诊断报告 |
| 支持升级 | bounded/redacted `support-bundle`、SDK 缺陷定位与修复 | 本地导出、用户主动提交支持材料、关联受控 incident |

当前 doctor 是 **product/store/device 范围**，没有 `doctor --agent-id`。不能把某台设备的检查结果标成某个 Agent 的完整健康证明；同一个 daemon 可以服务多个 Agent。

`collectDiagnostics` 与 `DiagnosticsSnapshot` 是内部实现，当前没有 public package export。不要 deep-import `src/diagnostics` 或 `dist` 内部文件。普通 CLI 分发使用随产品固定安装的 `byok-agent`；自定义 adapter、嵌入式 daemon 或 Bun/SEA 宿主如果需要进程内诊断，公开接口尚有缺口。基础 CLI 的默认 adapter 探测不能证明该宿主自定义 adapter 的状态，也不能假定 `runSdkReservedHelperCommand` 会接管 doctor 命令。

## 2. P2：从“检查问题”到结果展示

1. 用户从 Agent 详情进入“检查问题”。产品后端按当前授权和 placement 取得准确目标，记录 AgentRef、deviceId 及相关 taskId；这些是下游上下文，不是 doctor 的返回字段。
2. 已授权的本地宿主选取该设备安装的 CLI 和同一 daemon 配置，运行只读 doctor。浏览器不能直接执行 shell；远程产品若没有既有的授权本地操作通道，应提供本地操作指引，不能虚构一个 SDK 远程 doctor API。
3. 本地宿主解析 JSON wrapper `{ diagnostics, fix? }`，校验当前消费版本的结构，读取 `diagnostics.version`、`generatedAt`、`checks` 及对应原始结构化字段。未知版本、缺失必需字段、畸形结果、超时或进程失败显示“诊断未完成”，禁止默认健康或解析人类文本兜底。
4. 页面分开显示“设备诊断”和“此 Agent 最近一次任务/授权结果”。诊断中的 product/device/runtime 标识经过 hash，不能用它们反查身份、跨租户关联，或替代当前 placement。请求期间 placement/AgentRef 改变时，旧报告保留原目标上下文，拒绝以其授权新修复。
5. 用户选择允许的处置动作。动作结束后重新诊断；涉及该 Agent 的可用性验证，需要另行运行经授权、无业务写入的最小探测任务，并读取其真实结果。

CLI 命令模板如下，路径由可信本地安装配置提供，替换为绝对路径：

```sh
byok-agent doctor --json --config /absolute/product-agent.json
byok-agent support-bundle --output /absolute/new-support-bundle.json --config /absolute/product-agent.json
```

配置必须来自该安装的 daemon 配置 authority，不能根据 UI 输入重新拼造 product/store 路径。通过进程 API 调用时，用固定 executable 与独立 argv，禁用 shell；设置有限 timeout 和输出预算，超限即报告失败。`support-bundle` 输出路径必须不存在，不能覆盖旧证据。

**exit code 0 仅代表命令完成，不代表所有检查通过。** 当前 doctor 即使产生 fail/warn 检查也可以正常返回；必须读取 `checks[].status`。同样，checks 全 pass 不是 Agent ready：runtime 检查只要求至少一个 runtime present；目标 runtime、模型权限、provider 请求和业务能力不因此得到验证。`authPresent` 缺失表示未提供事实，不能解释成已登录或未登录。

## 3. 故障到用户动作的映射

下表是 UI 处置指引，不是新的调度或 admission authority。只使用结构化字段或真实 task/provider 结果；不要从 stderr 文本、超时或静默推导根因。

| 观察事实 | 展示与动作 | 成功标准与限制 |
| --- | --- | --- |
| runtime `not-found` | 引导安装产品要求的 runtime | 重新探测该 runtime；其他 runtime available 不能替代 |
| runtime `not-executable` | 检查安装或执行权限 | 重新探测；不自动提升权限或放宽 sandbox |
| runtime `timeout` / `probe-failed` | 显示探测失败，允许用户重新检查或导出材料 | 新探测提供新证据；不宣称 runtime 崩溃，不自动更换 runner |
| control `offline` | 显示“无法连接本地服务”，引导检查服务 | control online 只证明可连接；offline 不能证明进程已退出 |
| health `corrupt` | 提供“隔离损坏的健康记录” | 仅适用下一节流程，不宣称修复 Agent、journal 或业务任务 |
| health/journal `unavailable` | 显示“无法完成检查”，导出材料并排查访问条件 | 不等同 corrupt，不启用破坏性修复 |
| journal `corrupt` | 停止继续派发相关工作，保留证据并升级处理 | 无 doctor rebuild；需要明确的数据恢复方案，不能删库重配 |
| workspace 缺失/不可访问、存储压力 | 引导检查产品配置、磁盘与访问权限 | 恢复后读回；不得清空 Agent home、未确认消息或 recovery 记录 |
| 真实请求返回凭证/权限失败 | 进入该 Agent 的授权/配置流程 | 更新原 authority 后做明确验证；不借用其他 Agent 的 key |
| task interrupted 或执行结果不确定 | 显示中断及当前可信终态，提供受控重试入口 | 先核对外部副作用；daemon 重启和 terminal 补报不等于重跑成功 |
| 等待 approval 或仅缺 activity | 展示等待/观测不足 | 不从静默推断卡死，不自动取消、重启或重试 |

## 4. 有限修复交互

按钮应叫“隔离损坏的健康记录”，而非“修复 Agent”。确认界面说明：需要停止该设备本地服务，可能影响同 daemon 的其他 Agent；保留损坏证据，移除损坏 health 原文件，不恢复业务任务，也不重建数据库。

1. 先保存只读报告；确认目标未变，并展示同 daemon 影响范围。正常任务停止策略由产品已有 lifecycle 处理，不以杀进程代替完成通知。
2. 经用户确认，通过产品实际使用的 service manager 停止该服务；防止 supervisor 自动拉起。不要只因 control offline 就断言停止成功。
3. 运行以下命令；CLI 还会检查 offline，并获取 SDK 独占 store lease、重新确认 bounded corruption。拒绝或失败时停止流程，不删除锁、不重复强制操作。

```sh
byok-agent doctor --json --fix --yes --config /absolute/product-agent.json
```

4. 检查 `fix.status`：`quarantined` 表示证据已隔离；`not-needed` 表示没有修复发生。保留结果中的 manifest/evidence 标识。health 此时可能为 missing，不能伪造 healthy。
5. 通过原 service manager 恢复服务，重新运行只读 doctor；如需证明 Agent 可工作，再验证原 AgentRef 的最小任务。分别展示“隔离完成”“服务恢复”“Agent 验证结果”，不能用一项成功代替全部成功。

stop/start 的命令取决于产品安装的 launchd/systemd/WinSW 或嵌入式 lifecycle；SDK doctor 不管理这些 supervisor。日志、原始 quarantine 和凭证文件不自动上传；支持材料使用 SDK bundle，由用户明确选择提交。

## 5. 下游交付验收

使用隔离目录、测试凭证和产品实际打包的 binary，至少覆盖以下场景。SDK 维护底层回归，下游验证真实 UI/本地桥接/安装流程，无需复制 SDK 的存储实现。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 正常设备、一个 runtime 可用而目标 runtime 缺失 | 展示目标问题；不把汇总 pass 当 Agent ready |
| daemon offline、探测超时、JSON 畸形或不支持的版本 | 诊断未完成/观测不足，不出现假成功 |
| 同 device 两个 Agent、跨租户请求、检查后 placement 改变 | 拒绝越权/过期动作，设备问题不冒充单 Agent 问题 |
| health corrupt，用户取消确认 | 文件不变，没有 fix 调用 |
| health corrupt，daemon 仍运行或 lease 被占用 | fix 拒绝，不能清锁强行修复 |
| 服务停止后确认 health corrupt | evidence/manifest 保留，fix 结果与后续服务/Agent 验证分别显示 |
| journal corrupt 或 health unavailable | 不出现 rebuild、删库或“全部修复”按钮 |
| Agent 凭证失效、任务执行后断连/中断 | 授权入口准确绑定；无自动重跑导致重复业务写入 |
| bundle 导出及重复目标路径 | 脱敏材料本地生成；旧文件不覆盖，无后台自动上传 |

验收记录保存 SDK/CLI artifact 身份、宿主版本、OS、目标绑定、检查时间、脱敏结果与动作回执。源码检查成功不能替代实际分发版本验收。

## 6. P3：SDK 后续能力缺口与实施边界

现状可交付 CLI 诊断页、有限 health 隔离和本地支持材料导出。尚不能交付通用的“单 Agent 自动修复”。SDK 需要承担的后续范围是：

- 公开适合嵌入式宿主消费的诊断接口与校验契约，复用现有 collector，覆盖真实自定义 adapter，避免下游 deep import 或自建诊断 authority。
- 建立精确 AgentRef/device 绑定的诊断证据组合，区分 device 故障、Agent 配置、runtime 与 task 结果；缺少证据保持未知。
- 对每项新增修复先定义影响范围、前置条件、用户授权、执行回执与复查标准，再开放动作；数据恢复不能通过泛化 `--fix` 隐式增加。

这些是待实现能力，本次指引不新增 API、远程命令通道或自动重试策略。10 倍设备/Agent 数量下，首先承压的是逐设备本地探测和支持材料读取；下游应按需触发、限制并发并标示报告时间，不能把缓存报告或 lossy presence 升格为 readiness authority。

## 源码与 SDK 回归入口

- [CLI 路由](../packages/client/src/bin/byok-agent.ts)、[doctor 执行](../packages/client/src/bin/commands/doctor.ts)
- [diagnostics collector / fix](../packages/client/src/diagnostics/diagnostics.ts)、[support bundle](../packages/client/src/diagnostics/support-bundle.ts)
- [public exports](../packages/client/src/index.ts)、[package exports](../packages/client/package.json)
- [journal recovery contract](../packages/client/src/daemon/journal/journal.ts)
- [diagnostics tests](../packages/client/src/__tests__/diagnostics.test.ts)、[support bundle tests](../packages/client/src/__tests__/support-bundle.test.ts)
