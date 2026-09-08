# 下游 Agent 诊断与修复构建指引

本指引由 BYOK SDK 维护。SDK 负责交付可复用诊断、有限修复、接入方法及验收边界；下游负责将这些能力接入自己的身份、授权、安装方式和用户界面。缺少通用能力时，由 SDK 补齐接口与证据，不能要求每个下游自行实现 journal 修复或猜测 Agent 健康。

适用范围：当前仓库的 `@byok-sdk/client` CLI。本文不是已发布版本或下游上线证明；集成验收必须绑定下游实际打包的 SDK/CLI 版本。产品权威见 [spec](spec.md)，本地运维细节见 [self-hosted runbook](../deploy/runbooks/self-hosted-operations.md)，云端故障另见 [hosted runbook](../deploy/runbooks/hosted-operations.md)。

## 1. P1：能力与责任地图

| 层 | SDK 提供并负责维护 | 下游需要接入 |
| --- | --- | --- |
| 本地诊断 | `doctor --json`、runtime probe、health/journal/workspace 检查、authenticated control 查询 | 本地执行入口、结果展示、诊断时间与目标设备 |
| 有限修复 | health 隔离，以及从 OS enrollment 恢复缺失/有效但过期的登记投影；均使用独占 store lease | 显示实际作用与影响范围、用户确认、停止/恢复宿主服务、修复后复查 |
| 执行恢复 | SDK journal、terminal/recovery authority 与资源生命周期 | 展示 interrupted/未确认状态；按业务副作用决定是否提交新任务 |
| 产品身份 | SDK 消费明确绑定，不猜默认 Agent | 用产品权威选定 tenant、device、AgentRef 和相关 task |
| 凭证与配置 | 既有 credential custody、exact binding 与错误边界 | 进入该 Agent 的授权/配置界面；不把 secret 传进诊断报告 |
| 支持升级 | bounded/redacted `support-bundle`、SDK 缺陷定位与修复 | 本地导出、用户主动提交支持材料、关联受控 incident |

当前 doctor 是 **product/store/device 范围**，没有 `doctor --agent-id`。不能把某台设备的检查结果标成某个 Agent 的完整健康证明；同一个 daemon 可以服务多个 Agent。

公开入口是 `diagnoseDevice` 与 `repairDeviceEnrollmentMetadata`（package root export）；`DiagnosticsSnapshot` 现已导出为只读诊断结果类型。内部 `collectDiagnostics` 仍不应 deep-import。嵌入式宿主向 `diagnoseDevice` 提供实际使用的 adapters，避免用默认 bundled probe 冒充自定义 adapter 状态。单文件宿主直接调用 API；`runSdkReservedHelperCommand` 不接管 doctor。

```ts
import { diagnoseDevice, repairDeviceEnrollmentMetadata, DeviceMetadataRepairError } from '@byok-sdk/client';

// config 和 adapters 来自本地宿主实际配置。
const report = await diagnoseDevice(config, { adapters });
// 在用户明确选择“恢复设备登记信息”并确认影响范围后调用：
try {
  const receipt = await repairDeviceEnrollmentMetadata(config, {
    confirmed: true,
    expectedDeviceId: authorizedEnrollment.deviceId,
    expectedTenantId: authorizedEnrollment.tenantId,
  });
  // receipt.status 是 repaired 或 not-needed；随后独立诊断并按需验证 Agent。
} catch (error) {
  if (!(error instanceof DeviceMetadataRepairError)) throw error;
  // 按 error.code 显示固定处置文案，不解析 message 或自动重试。
}
```

普通诊断不访问 OS credential store。只有显式登记修复会读取现有 authority，OS 可能要求用户解锁；它不更新凭证、不续期 token，也不保证凭证仍被云端接受。

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

## 4.1 新增动作：恢复设备登记信息

适用：宿主已知准确 tenant/device，但本地非敏感 `device.json` 缺失或有效内容过期。SDK 从既有 OS enrollment 重建投影，复用启动恢复逻辑。不能从这份待修复文件获取预期身份，也不能从 hashed doctor 报告猜身份。

1. 展示设备范围和同 daemon 的影响，用户确认后停止服务，禁用 supervisor 自动拉起。
2. 用授权 enrollment 的准确目标调用公开 API，或运行：

```sh
byok-agent doctor --repair restore-enrollment-metadata --expected-device-id DEVICE_ID --expected-tenant-id TENANT_ID --yes --json --config /absolute/product-agent.json
```

3. 此命令 JSON 为 `{ "repair": { "action": "restore-enrollment-metadata", "scope": "device", "status": "repaired" } }`；无需写入时 status 为 `not-needed`。它不返回普通 doctor 的 diagnostics wrapper。动作失败时 `--json` 输出 `{ repair: { action, scope, status: "failed", code } }` 并以非零状态退出；解析失败/不支持的命令参数仍按命令失败处理，不能解析 stderr 猜 code。随后显式执行普通 doctor、恢复服务并按需验证 Agent，分别展示每一步。
4. `confirmation-required` / `invalid-target`：补齐确认和权威目标；`daemon-running` / `store-busy`：停止占用操作后由用户重试，禁止删锁；`authority-missing`：进入明确配对流程；`authority-unavailable`：检查 OS credential provider 可用性；`target-mismatch`：重新核对 enrollment/placement，禁止覆盖；`projection-unavailable`：保留文件并排查，不以修复替代认证配对；`repair-failed`：写入或回读未确认，保留状态并重新诊断。

畸形、legacy secret-bearing、symlink 等投影拒绝修复。此动作不恢复已过期的授权，不读取 provider key，不修改 Agent home/journal，不重跑任务；崩溃后必要时仍从 OS authority 再次重建投影。不要将 repair 参数与 `--fix` 混用。

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
| 登记投影缺失/过期、重复修复、错误 tenant/device、缺少 OS authority | 仅正确权威可恢复；重复为 not-needed；拒绝路径不替换投影、不写凭证 |
| bundle 导出及重复目标路径 | 脱敏材料本地生成；旧文件不覆盖，无后台自动上传 |

验收记录保存 SDK/CLI artifact 身份、宿主版本、OS、目标绑定、检查时间、脱敏结果与动作回执。源码检查成功不能替代实际分发版本验收。

## 6. 新增 embedded-host operator API（0.16.0 source candidate）

本节是未发布候选，不能以已有 0.15.0 registry pin 使用。package root 新增：

```ts
import {
  quarantineDeviceOperationalHealth, exportDeviceSupportBundle,
  archiveAgentTerminalMessages, DeviceOperatorError,
} from '@byok-sdk/client';

// Host 先取得用户确认，并通过其原 service manager 停止设备 daemon。
const healthReceipt = await quarantineDeviceOperationalHealth(config, { confirmed: true });
// 只读导出无需停服务；使用实际 adapters。输出 parent 必须已存在，文件不可存在。
const bundleReceipt = await exportDeviceSupportBundle(config, {
  adapters, outputPath: '/absolute/private/support.json',
});
// target 来自已授权的 enrollment/Placement；不是 hashed doctor 或待修复投影。
const archiveReceipt = await archiveAgentTerminalMessages(config, {
  confirmed: true,
  expectedDeviceId: target.deviceId,
  expectedTenantId: target.tenantId,
  agentRef: target.agentRef,
  archiveDirectory: '/absolute/private/new-agent-audit',
});
```

- Health 保留原 bounded quarantine 实现和 evidence/manifest/hash receipt；missing/valid 为 `not-needed`。只隔离确认的损坏 health，不能修 journal 或业务任务。API 自行验证 control offline，并由底层取得 device owner lease；offline 本身不是停机证明。
- Bundle 接收窄化的实际 adapters/probe timeout，拒绝内部 clock/connectControl/security DI seams。只输出 SDK allowlist-v1 脱敏结果，保留原子 no-overwrite/file sync；回执是 `written`，不证明设备或 Agent 健康，也不上传材料。
- Archive 需要 device owner 和 Agent-home writer lease。它从 config 唯一 root 选择已有 Agent home，不执行 projection hook、不初始化业务文件。设备 metadata 必须匹配 expected tenant/device；所有 outbox records 必须匹配同 tenant 与 Agent ID。`agentRef` 选择当前授权的 Agent；历史 profile revisions 原样保留，不被改成当前 revision。
- Archive 只退休 refused/locally revoked 终结证据，held/draft 仍 live。输出是**敏感完整审计材料**，不是 support bundle；目录必须是已有 parent 下的新目录，private ACL 在写正文前建立。原有 outbox 64 MiB 边界继续生效；先 sync 审计副本、后替换 live log。同步失败保留 live evidence，不自动删输出目录或重试。archive 不成为 replay 输入。
- 三个 API 不启动/停止 supervisor，不读取 OS/provider 凭据、不重跑任务。Host 必须分别展示 action receipt、服务恢复和独立 Agent 验证；释放 lease 失败也拒绝报告完整成功。
- `DeviceOperatorError.code` 是封闭的 `confirmation-required`、`invalid-input`、`daemon-running`、`store-busy`、`agent-busy`、`target-mismatch`、`source-unavailable`、`output-exists`、`operation-failed`。不解析 message，也不从错误反推成功。错误不附带任意 OS 文本、路径或 cause。

## 7. P3：SDK 后续能力缺口与实施边界

现状可交付 CLI 诊断页、有限 health 隔离和本地支持材料导出。尚不能交付通用的“单 Agent 自动修复”。SDK 需要承担的后续范围是：

- 已实现：`diagnoseDevice` 复用现有 collector，可使用宿主实际 adapters；公开 TypeScript 结果类型。跨进程消费方仍须校验其固定分发版本的 JSON 结构，不提供额外运行时 schema API。
- 建立精确 AgentRef/device 绑定的诊断证据组合，区分 device 故障、Agent 配置、runtime 与 task 结果；缺少证据保持未知。
- 对每项新增修复先定义影响范围、前置条件、用户授权、执行回执与复查标准，再开放动作；数据恢复不能通过泛化 `--fix` 隐式增加。

当前已实现公开诊断 API、显式登记投影修复，以及上述 source-candidate operator API；上述 AgentRef 级组合与其他新修复动作仍待实现，没有远程命令通道或自动重试策略。10 倍设备/Agent 数量下，首先承压的是逐设备本地探测和支持材料读取；下游应按需触发、限制并发并标示报告时间，不能把缓存报告或 lossy presence 升格为 readiness authority。

## 源码与 SDK 回归入口

- [CLI 路由](../packages/client/src/bin/byok-agent.ts)、[doctor 执行](../packages/client/src/bin/commands/doctor.ts)
- [diagnostics collector / fix](../packages/client/src/diagnostics/diagnostics.ts)、[support bundle](../packages/client/src/diagnostics/support-bundle.ts)
- [public exports](../packages/client/src/index.ts)、[package exports](../packages/client/package.json)
- [journal recovery contract](../packages/client/src/daemon/journal/journal.ts)
- [diagnostics tests](../packages/client/src/__tests__/diagnostics.test.ts)、[support bundle tests](../packages/client/src/__tests__/support-bundle.test.ts)
