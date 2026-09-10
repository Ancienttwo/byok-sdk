# RAFT 存储与计费参考：SaaS BYOK SDK

核对日期：2026-09-10。范围：官方公开页面及本地 RAFT 研究；不登录计费后台、不读取账单/凭证、不执行 RAFT。参考机制不等于我们的验收或计费批准。

## 结论

可借鉴 RAFT 的本地执行/记忆与云端协作记录分层，以及分别限制历史保留和新增上传量。**本次官方公开定价不支持“RAFT 按每周新增存储收费”的断言**；不能据此替 BYOK 冻结 weekly delta 公式。这不排除 RAFT 历史版本、特定套餐或后台有其它政策。

**Owner 实测补充（2026-09-10）：**用户明确报告：“100M文件上传就是由保存到服务端的对话记录与文档造成的，我测试过”。据此，不能将该额度解释成仅手动附件上传；服务端保存的对话与文档也在用户实测的消耗范围内。这是 owner-reported 实测，未提供本轮可独立复跑的账单/前后数值，不降格为猜测，也不升级为已验证服务器算法。它补足的是计量对象范围，不自动证明每周周期、删除抵扣或版本去重规则。

## 当前官方证据

| 来源 | 已确认 | 不能推出 |
|---|---|---|
| [官网 Pricing](https://raft.build/#pricing)，2026-09-10 读取 | Free：30 天 message history、100 MB file uploads/month；Pro：年付口径 $8.80/seat/month，人 1 seat、Agent 0.1 seat，unlimited message history、higher upload limits | 不是每周字节单价；没有解释删除抵扣、跨版本 hash 去重、失败上传或净增量计算。MB 单位保留官网写法，不擅自换为 MiB。 |
| [Privacy §16](https://raft.build/privacy/) | 公开声明区分本地 Agent working context 与显式发送到 channel/DM/workspace 的 messages、attachments、tasks、metadata | 公开声明不是远端数据库字段、存储压缩率或计费实现证明。 |
| [Terms §27](https://raft.build/terms/) | 服务还接收 activity metadata；列举 tool names、截断 tool input、thinking/text output | 不应把“本地执行”解释为没有任何活动文本上云；activity 也不自动等于聊天正文或收费项目。 |
| [Runtime 文档](https://docs.raft.build/features/agents/runtime/) | 模型成本由 runtime provider 订阅/API 决定；换 runtime 的 fresh session 保留 Agent identity/workspace/memory | 不证明所有 working memory 都存云，也不证明 memory cloud restore。 |
| [Computer 文档](https://docs.raft.build/zh-cn/features/server/computers/) | 本地 workspace 删除与移除 computer/服务分离；MEMORY.md、notes 属需要单独处理的工作文件 | 删除连接不等于本地文件已清除，也不能代替云端数据删除。 |

官方页面只说明产品政策；本次未对真实上传、删除、重复请求、账单周界做在线实验。搜索索引与页面正文有呈现差异时，不从缺失段落推断实现；本报告将公开声明与固定本地源码证据分开。

## P1 / P2 / P3：萃取到 BYOK 的边界

本地 [2026-08-26 memory 研究](../../../RAFT-study/docs/raft-cli-memory.md) 的 §1/§3/§6 显示：per-agent MEMORY.md/notes 保存在稳定 cwd，模型按需读；服务端 curated manual/knowledge 是另一层。这里只沿用固定历史样本的本地事实，不把它当当前 RAFT 服务端行为或 memory 计费证明。

本地有界复核：`docs/ plans/ tasks/` 及相关 Git 历史搜索未找到 weekly storage billing。当前静态 artifact `RAFT-study/_ref/raft-cli/current/extracted/computer-bundle.cjs:166809–166828` 的默认 week 是 managed usage window，`:739179–739207` 的 Current week 属 Claude local-session usage，不是 RAFT 新增存储账单；`:19417–19499` 的 plan 常量为月度 seat/upload。没有服务端计费代码或真实账单证据，不能从这些客户端词汇推出收费算法。

本地 `docs/architecture/local-cloud-projection.md:25–31,104–110` 区分云端 shared history 与本地 home，未发现 steady-state 全目录镜像；`docs/architecture/server-contract-boundary.md:197–202,223–226,268–270` 的 attachment size/clientRequestId/create/complete/cancel 仅证明客户端契约，删除抵扣、retry 去重和远端 retention 仍未验证。

**P1：**SaaS 拥有产品消息、任务/偏好/业务事实与计费政策；SDK 提供可靠传输及可选 hosted-memory 存储机制；设备负责 runtime、凭证、工作文件与本地记忆 authoring。RAFT 是协作产品，不能要求所有 SDK embedder 都复制完整渠道/聊天系统。

**P2：**有价值的可迁移路径是“本地工作 → 显式产品消息/成果提交 → 服务端成功持久化 → 幂等用量事实”，不是“扫描整个 home → 把字节全上传计费”。BYOK 已有 hosted memory projection 的完整 snapshot receipt，仍需 SaaS 明确将其转换为哪种计费口径；完整 redactedByteCount 不等于 delta。

**P3：**保留本轮已批准的存储分层；不新增 RAFT 风格后台或默认 telemetry 上传。十倍规模首先按 message/artifact、Summary/context 快照、activity/可靠传输、memory head/receipt 四类量化增长，各自预算/保留，而不是一个总 uploadBytes 同时代表产品用量和基础设施成本。

| 值得采用的规则 | 对当前 PRD / Sprint 的影响 |
|---|---|
| 上传额度与历史保留分开 | PRD §9.5/9.7、S0-05 同时记录 weekly new bytes 与 current retained bytes；不能靠新增量推断累计占用。 |
| 显式发布的数据上云、本地工作不全量镜像 | §9.6 的 SaaS 产品事实、用户成果、授权 memory projection 保持；本地 scratch/native session 不默认计费。 |
| 模型费用与平台容量分开 | SaaS 不从 SDK 内部字节直接推导 token 成本；价格与套餐由 embedder 决定。 |
| message、attachment、activity、memory 分类别 | S0 草表保留各自来源、配额与 retention；SDK 内部复制不自动变成用户新增收费。 |
| 公开产品限额不等于底层 storage 算法 | weekly 新增的三个候选仍待明确，不根据 RAFT upload cap 或客户端常量选定。 |

本轮不把 RAFT 席位价套用到 BYOK，也不将用户提出的 weekly 方向改成 monthly。可复用的是计量维度分离与数据归属；扣费公式仍是我们的产品契约。
