# Implementation Notes: skill-pack-delivery-channel

> **Status**: Active
> **Plan**: plans/plan-20260813-0023-skill-pack-delivery-channel.md
> **Contract**: tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md
> **Review**: tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md
> **Last Updated**: 2026-08-13
> **Lifecycle**: notes

## Design Decisions

- **`SkillPackStore` 进 port 契约表，但不进 `CoreStores`。** 这是 Phase 1 唯一的结构性裁定。`core` 的 `constraints.test.ts` 会扫描 shipped source 里所有 `export interface *Store {`，要求这个集合恰好等于 `CORE_PORT_INTERFACES` 的值集，所以新 port 不登记就直接挂测试；而 `CORE_PORT_INTERFACES` 原本以 `CoreStoreName` 为键，登记就意味着进 `CoreStores`，进而要求 `packages/cloud-postgres` 的 `createPostgresCoreStores` 同 slice 补实现——那在 contract 的 allowed_paths 之外（Phase 2 才做），触发 Stop Condition。裁定形状：新增 `CORE_NON_COMPOSITION_PORT_NAMES = ['skillPacks']` 与 `CorePortName = CoreStoreName | …`，端口表以 `CorePortName` 为键。`CORE_STORE_NAMES` 与 `stores.ts` 零改动，`conformance` 的 port-inventory 维度仍按 `CORE_STORE_NAMES` 迭代，因此 cloud-postgres/conformance 都不受影响。两个备选都更差：把成员做成 optional 是稳态兼容回退（禁止），把 port 留在契约表之外则等于豁免它的 tenant-first 扫描——那恰恰是最值得留的规则。Phase 2 把 `skillPacks` 挪进 `CORE_STORE_NAMES` 后这个常量归空。
- **hash 归 caller，canonical 字节形归 core。** core 不许 `node:` import，所以它拿不到 sha256。折中不是「core 不管完整性」，而是 core 独占 `skillPackContentHashInput()`（唯一 canonical 字节形）与全部比较逻辑，publisher 与 installer 各自算摘要。两端若各写一份 canonical 形，安装要么全过要么全废，这正是必须只有一个权威的地方。字节形里带 description 的长度前缀，防止把描述内容挤进下一个字段位置伪造同一个地址（有对应测试）。
- **frontmatter 自己写解析器，不引 YAML 引擎。** 这是一个封闭的双键文法（`name` / `description`）。通用 YAML 会照单全收 anchor、alias、嵌套 map、多文档、block scalar——每一个都是这个格式决定不要的表达能力。手写解析器对文法外的任何东西 fail-closed，不是「跳过不认识的行」。这不属于「用本地规则重derive上游语义」：这里没有第二个权威，SKILL.md 的 frontmatter 就是原始输入。
- **cap 判在实测字节上，不判 manifest 自称。** `checkSkillPackFileContent` 先判 observed size 是否超 per-file cap，再判是否等于 declared。顺序是有意的：只量声明值的检查，会放过「4KB 声明 + 40MB 响应」。client 侧另外累计整包实测字节，因为逐文件都合规仍可能整包超限。
- **capability 判定在 fetch 之前。** `installSkillPacks` 第一件事是 `hasCapability`，抛 `capability_unavailable`。不是因为请求会失败（未声明的部署根本不挂载路由，会 404），而是把 404 读成「没有技能包」正是 ADR-010 要消灭的 status sniffing。测试用 `vi.spyOn(globalThis, 'fetch')` 断言零次调用。
- **cloud 侧不走 tenant-closed facade，走 `principalTenant`。** `TenantStores` 由 `CloudRootStores{core, cloud}` 构造，而 skillPacks 两者都不属于；给 facade 加可选成员是更差的形状。改用 `handlers/truth.ts` 已有的先例：composition-bound handler 自带 tenant-first authority，认证后用 `principalTenant(device)`。cloud 的 constraints test 禁止 handler 里出现 `TenantId` 字面量，这条路径不出现。
- **file 路由用单段 percent-encoded path。** `:path` 收 `encodeURIComponent(path)`，嵌套路径里的 `/` 编码成 `%2F`，不会被 Hono 当路由分隔符切开；handler 不做任何解码后的归一化——store 只对自己 manifest 声明过的路径应答，那些路径发布时已过 core 的路径文法。handler 再「清理」一次就是给「包里有什么」造第二个更弱的权威。已有测试覆盖嵌套路径与 4 种穿越形态。
- **审计另开一条 `skill-packs/audit.jsonl`。** 不复用 `bin/audit-log.ts`：那是 `DaemonEvent` 的 task 生命周期读模型，加一个 kind 会波及 observer / tasks-view / format 三处，而技能安装不属于任何 task。新文件同样 0600、append-only、chmod 在 append 之前。
- **投影拷贝并重新校验。** `projectSkillPack` 拷字节（不 symlink），拷出前按 lock 重算 sha256。store 和别的进程在同一台机器上，上周装的时候验过不构成对今天那个文件的证据；symlink 还会让 runtime 脚下的内容随 store 变化而变。
- **lock 最后写。** revision 目录先写满，`lock.json` 才落。中断的安装留下的是没人指向的目录，上一个版本仍然权威。

## Deviations From Plan Or Spec

- plan 写的 `SkillPackStore` port「含契约表登记」已完成，但 Phase 1 未把它纳入 `CoreStores`（理由见上）。plan 的 Phase 2 项因此多一条隐含动作：迁移时同时清空 `CORE_NON_COMPOSITION_PORT_NAMES`。
- plan 提到「fetch→验证→store→lock→审计」的管线由 daemon 在 capability 发现后触发。Phase 1 交付的是可被 host/daemon 调用的 `installSkillPacks(declaration, …)`，未接进 `create-daemon.ts` 的启动序列——contract 的 Exit Criteria 未要求，接线会扩大 daemon 生命周期的改动面。daemon 侧的触发时机（connect 时 / capability version bump）留给后续 slice。
- 研究 §3.1 里 hermes 的 quarantine 目录、regex 安全扫描器、信任分级矩阵均未实现——contract 的 Non-scope 明确排除，此处只记录未做，不是遗漏。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| `skillPacks` 直接进 `CoreStores` | 拒绝 | 需同 slice 改 cloud-postgres（allowed_paths 之外），触发 Stop Condition |
| `CoreStores.skillPacks?:` 可选成员 | 拒绝 | 稳态兼容回退，仓库规则禁止；且会让 conformance 的「恰好这些 port」断言失去可证伪性 |
| `SkillPackStore` 完全不进契约表 | 拒绝 | 会豁免 tenant-first / async 源码扫描，且直接挂 `constraints.test.ts` 的 port 集合断言 |
| 包内容走 base64 / 归档字节 | 拒绝 | 纯 UTF-8 文本让「只传声明式内容」成为格式自带的性质，而不是靠检查维持 |
| 复用 `bin/audit-log.ts` 的 DaemonEvent 流 | 拒绝 | 波及 observer/tasks-view/format，且技能安装不属于任何 task 的生命周期 |
| `fullCapabilityDeclaration()` 默认含 `skills.pack` | 拒绝 | 既有 in-memory 部署没有 store，会在构造期全部失败 |

## Open Questions

- daemon 何时触发安装（connect 时 / capability version bump / host 显式调用），以及失败是否要进 `OperationalHealthSnapshot`。Phase 1 只交付可调用的管线。
- pack 的 tenant 归属粒度仍是 plan 里那条延迟项：v1 tenant-scoped；product-global 共享包等第二个真实分发场景再裁。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- 本轮验证：`pnpm -r run typecheck`、`pnpm -r run test`、`pnpm -r run build` 全绿；`packages/protocol` 零 diff（`git status --short -- packages/protocol` 为空）。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- 「新 port 跨 merge unit 引入时，契约表键集与 composition 契约键集必须分开」这条，如果 Phase 2 迁移顺利、且再有第二个跨 slice 引入的 port 复用同一形状，再考虑提 `tasks/lessons.md`。目前只有一例，留在本文件。
