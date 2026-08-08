# S6 Device Proof、Truth Write 与 Memory CAS 设计

> 状态：Accepted for implementation
> 日期：2026-08-09
> 对应：platform sprint S6 / P4

## P1 · 系统地图

S6 横跨四个现有边界，但不改变 frozen protocol v1：

- `@byok/core` 已拥有 `DeviceProofEnvelopeV1`、restricted RFC 8785 canonicalizer、签名字节 golden、`TruthStore`、terminal immutable 与 snapshot CAS reference semantics。这里是 proof bytes 与 truth domain 的唯一断言源。
- `@byok/cloud` 持 HTTP device surface、WebCrypto seam、pairing/device row、tenant-bound facade 与 capability route inventory。S6 的 proof verifier 位于 HTTP 外层，不进入 protocol envelope。
- `@byok/cloud-postgres` 持 durable device row、truth/object/quota adapters 与 ordered forward-only migrations。生产 truth write 必须在一个 SQL transaction 内完成 proof receipt、truth row、object reference 与 accounting settlement。
- `@byok/client` 持 daemon Ed25519 private key 与下载执行面。它负责生成 proof、在本地选择 manifest entry、下载选中的 body，并按 daemon 声明的 canonical SHA-256 复核 bytes；cloud 不做 embedding、ranking、merge 或 distillation。

规模信号：现有 proof canonicalizer 与 golden 已在 core；现有 truth 语义已有 InMemory/Postgres 两套实现。缺口不是再造 domain model，而是把 device-row authority、HTTP proof、原子 receipt/write/accounting 与 daemon selector/fetch 串成一条生产路径。

明确不在 S6：修改 `packages/protocol/**`、引入 unsigned fallback、cloud semantic memory logic、为未来 checksum/rotation 预埋双模式、修改 `0001`/`0002`/`0003`。

## P2 · 一条具体路径

以 `PUT /byok/records/memory/:key` 为例：

1. daemon 将完整 snapshot 序列化为 bytes，计算 `sha256:<hex>` 与 byte size；小 body 以内联声明承载，大 body 先走 S4B reservation-bound blob upload/finalize。
2. daemon 用显式配置的 `tenantId`、`productId`，已配对的 `deviceId`，以及 identity proof key `keyId/keyEpoch` 构造 protected claims。claims 绑定 method、path、operation、resource、requestId、body hash/size 与时间。
3. daemon 对 core 定义的 `byok-device-proof-v1\n` + canonical JSON bytes 做 Ed25519 签名，并把 proof 放到专用 header；没有从 token/JWT 反推 tenant 的路径。
4. cloud 先做 schema/header/body size 上限，再对请求 method/path/body hash/size 做绑定校验；以 claim tenant/device 查 DB row，并用 row 的 product、public key、key id/epoch、revoked 状态做 authority check；随后检查 bounded clock skew/expiry，最后验签。任一失败统一 401。
5. verifier 产出由 DB row 构造的 authenticated proof principal。handler 不再信任原始 claims 选择 tenant。
6. write application port 以 `(tenant_id, device_id, request_id)` 查 receipt。完全相同的 operation/resource/body hash 返回首次结果；同 requestId 的任何绑定差异返回 conflict。
7. inline body：在同一事务内锁 tenant entitlement/usage，按 live truth hash reference 计算最终 logical usage、写 `attested_record`、更新 `storage_usage`、写 receipt。inline bytes 与 accounting 同属 Postgres transaction，不制造跨系统 reservation；同 tenant 同 hash 多 record 只计一次，最后一个 reference 移走才释放。object body：事务内确认 manifest 已 committed、写/替换 `object_reference`、写 truth row 与 receipt。snapshot 用 `expectedRev` CAS；terminal 首写不可变。
8. `GET /byok/records` 只返回 manifest metadata。daemon 的 `MemorySelector` 选 key 后才 fetch body；object 下载完成后本地 rehash，不匹配即 fail-closed，bytes 不进入 runtime context。

同步边界是 HTTP；数据库内 receipt/truth/reference/accounting 是一个 transaction。R2 upload/download 在 transaction 外，靠既有 committed manifest 与 content hash 连接。CAS conflict 返回当前 manifest entry，cloud 不合并。

## P3 · 设计裁定

### D1：已发布 core golden 是 proof bytes authority

采用 core 当前的小写 domain prefix `byok-device-proof-v1\n` 与 `DeviceProofEnvelopeV1` shape。早期 proposal 中的大写示例是被实现与 golden supersede 的研究文字，不形成第二种可接受编码。

### D2：device row 显式保存 proof key identity

新增 forward-only `0004`：在 `device` row 增加非空 `proof_key_id` 与 `proof_key_epoch`，并新增专用 proof receipt table。当前配对 identity key 的唯一值是 `identity` / `0`，由 pairing 写入并由 row 返回；verifier 不提供默认值或兼容分支。既有 row 在 migration 中一次性投影到同一值，因为已有的 `device_public_key` 就是同一 identity key。

不用现有 generic `device_request_receipts`：它只有 tenant/key/body，无法证明 device、operation/resource 与 body hash 的一致性，继续复用会把 proof replay authority 降格成 opaque string equality。

### D3：proof 路由使用 proof principal，不叠加 bearer 作为 tenant authority

record routes 以 request-bound proof 完成 device authentication；DB row 是 tenant/product/key authority。再要求 bearer 只会增加一个独立过期状态，且不会增强 body/resource binding。现有 bearer routes 不变。proof routes 无 unsigned/bearer-only fallback。

### D4：写入用高层原子 committer，不顺序拼 raw stores

保留 core `TruthStore` 作为 domain/conformance authority；新增 cloud application port 负责 receipt + truth + reference/accounting 的原子提交。生产 Postgres 实现使用一个 transaction。现有 InMemory stores 各自封装 state，无法在不另造第二套 authority 的前提下提供跨 store rollback，因此标准 InMemory composition 不声明 `truth.records`；handler suite 只使用明确标注的 deterministic route fake，不把它当 atomicity 证据。handler 不直接顺序调用 `TruthStore`、`ObjectStore` 与 `QuotaStore`，避免 crash window 让 GC 删除已被 truth 引用的对象，或让 inline bytes 已落库但未计费。

### D5：terminal + memory candidates 是一个 commit unit

terminal write DTO 可携带零个或多个 memory/profile snapshot candidates；一个请求只产生一个 proof receipt，Postgres 在同一 transaction 内提交 terminal 与所有 snapshot/ref/accounting。任一 CAS、manifest、quota 或 terminal conflict 使整批失败。这样 local execution truth 不会出现 terminal 成功而同次显式 memory snapshot 半成功。

### D6：MemorySelector 只在 daemon

`MemorySelector` 输入 metadata-only manifest，输出明确的 `(kind,key)` selector；cloud 只做 prefix/kind/limit。下载端按声明 hash 复核 bytes，再交给本地 filter/distillation。snapshot 超过 1 MiB 时记录 metric 并触发 schema/compaction revisit；它不是拒绝阈值，也不触发 delta 兼容路径。

## 安全与运维后果

- I3 必须覆盖 wrong tenant/product、revoked、old epoch、body/path/resource tamper、exact replay、mismatched replay、skew、missing key、malformed canonical input、key order、large object ref 与 terminal conflict。
- capability 在没有 atomic truth committer 与 content-hash keyed object download authority 的 composition 上构造失败或不声明；production 不存在测试-only 自动降级。
- proof clock skew 默认 60 秒，并受有界配置约束。`expiresAt` 不能晚于产品允许的最大 proof lifetime。
- 10x 首先失败的是大型 snapshot 的对象下载带宽与 manifest scan，不是 cloud CPU；1 MiB metric、bounded manifest page 与 local selection 是观察/控制面。若 conflict rate 或 >1 MiB 比例持续升高，再开新设计，不预埋 delta。
- 独立安全审查仍是 capability default-on 前置。Claude review 暂停期间使用独立 Codex review execution context；不得把 implementer self-review 记录为 external pass。

## 分刀

- **S6-a Proof authority**：migration/device row、cross-runtime golden、cloud proof verifier、I3、dedicated receipt contract。
- **S6-b Atomic truth write**：record routes、Postgres/InMemory atomic committer、inline/object accounting、terminal/batch CAS/replay。
- **S6-c Daemon memory path**：proof signer、explicit tenant config、MemorySelector、selected fetch/rehash/filter 与 end-to-end tests。

三刀都不修改 frozen protocol。S6 仅在三刀合入、security review 与全量门禁通过后标记完成。

## S6-c 实现裁定

- `@byok/client` 直接依赖 protocol-free 的 `@byok/core`，只读取已冻结的 `deviceProofSigningInput` 与 truth selector contracts；client 不依赖 `@byok/cloud`，也不复制 canonicalizer。
- `StoredDeviceProofSigner` 要求 host 显式传 `tenantId/productId/keyId/keyEpoch`，逐次从 `DeviceStore` 读取 paired private key。没有从 bearer/JWT 推导 tenant 的路径；unpair 清除本地 record 后，后续签名立即失败。
- `TruthMemoryClient` 的 public read path 是 manifest → local selector → selected GET → manifest equality → size/hash verify → local filter。它不把 verified raw records作为 runtime context返回；只有 host filter 的泛型结果离开该方法。
- list/get 之间若 rev/hash/size/label/time 任一变化即 fail-closed并要求 caller 重走 manifest decision。object download 用声明 size 做 bounded stream read，再按 daemon 声明摘要 rehash；同 size 字节替换不能进入 filter。
- client 提供 snapshot/terminal proof write，inline hash由 client从 exact bytes计算；object body只接受已经完成 reservation/finalize 的 canonical hash/size。write requestId 由 caller持有，重试不重新生成 id。
- 1 MiB 是 metric threshold而非 admission limit；metric sink失败只记本地固定错误，不拒绝已验证 snapshot。现有 daemon task loop没有正式 memory/prompt policy，因此本刀不猜自动注入或 terminal flush时机；这些仍由 host在公开 selector/filter/write seam上组装。
