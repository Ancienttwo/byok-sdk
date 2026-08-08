# Notes: S6-c Daemon Proof and Memory Path

- Worktree: `/Users/ancienttwo/Projects/byok-sdk-wt-s6c-daemon-memory`
- Branch: `codex/s6c-daemon-memory`
- Base: `7f26b5c` (S6-b, Draft PR #35)
- Claude review: paused; do not invoke.

## Evidence

- `StoredDeviceProofSigner` 直接调用 `@byok/core` 的 `deviceProofSigningInput`，显式要求 tenant/product/key id/epoch；每次签名都重新读取 `DeviceStore`，unpair 后无 cached signing authority。
- `TruthMemoryClient`：proof-only list/read/write；manifest/top-level/metadata strict decode；local selector 全量预验证后才 fetch；selected GET 必须与 manifest metadata 全等；inline/object 都验证 byte size + SHA-256，object 按 declared size bounded stream read。
- filter 是 raw verified body 离开 client 的唯一 seam；unknown/duplicate selector、manifest body smuggling、list/get race、same-size byte replacement、bad object size/hash 都在 filter 前 fail-closed。
- snapshot/terminal write 由 caller 持有 requestId；inline digest 从 exact UTF-8 bytes 计算，object input 只接受 canonical hash + safe byte size。没有 bearer fallback或 cloud dependency。
- >1 MiB snapshot 发 `truth.snapshot.large` metric，不拒绝、不切 delta；metric sink throw 被固定本地告警隔离，已验证 record 继续进入 local filter。
- Targeted：2 files / 16 tests green；client full suite：98 files / 951 tests green。
- Hard env/full workspace：core 112、keys 330、protocol 189、cloud 130、server 217、client 951、conformance 117、cloud-postgres 200；full typecheck/test/build green。
- Deploy SQL order、architecture sync（advisory，blocking=0）、task sync、strict workflow green；相对 `7f26b5c` 的 `packages/protocol/**` 与 `deploy/sql/**` 零 diff。
- Packaging：Bun single-file smoke green；`npm pack --dry-run` green（client tarball 82 files，包含两份新 d.ts）；本机 Node 26.5.0 报 `Single executable application is disabled`，因此 SEA 由 PR CI 的 Node 20/22/cross-platform legs作为 authority。
- Contract verifier 第一次重跑因 handoff resume 早于 `tasks/current.md` 被 strict workflow 拒绝；刷新 resume 后该 gate green。第二次只撞到既有 `long-poll-validation-stall.test.ts` wall-clock flake（期望第二次 fetch 尚未发生，实际已发生），同轮 hard-env 全仓 test green；该单文件随后连续 5/5 green，未改无关产品代码。
- Draft PR #36 首个 head `42632c0` 的两组 GitHub CI 共 32/32 green。独立 Codex exact-SHA review（OpenAI provider、read-only、session `019fe317-20e8-72b2-bf60-b22c6c79a142`）拒绝该 head：HIGH-1 任意 object `downloadUrl`/redirect 可形成 daemon SSRF；HIGH-2 write response 未绑定本次 primary/snapshot selector/hash/size。两条均确认是 S6-c 新路径，不是基线问题。
- 本地修复：`allowedObjectDownloadOrigins` 成为 required 显式配置；只接受 credential-free HTTP(S) exact origin，下载固定 `redirect: manual`，relative/wrong-origin/credentials/unsupported scheme 在网络访问前拒绝。write success receipt 逐项校验 primary 与 ordered snapshots 的 selector、next revision、content hash、byte size，并在签名/发送前拒绝 duplicate selectors。两文件 targeted 16/16、client 951、machine contract 16/16、hard-env full workspace gates 全绿。
- 修复 head `ead8a8746188b8f480c0115ad556b766dfbd73fa` 的 Draft PR #36 两组 GitHub CI 32/32 green；PR #34/#35 亦各 32/32 green。
- Independent Codex exact-SHA review（OpenAI provider、`gpt-5.6-sol`、read-only、session `019fe324-7ce7-7311-87a9-349184499800`）审查完整 `2a1c4a7..ead8a87` S6 stack，明确复核两个先前 HIGH 已关闭，最终 receipt 为 `ACCEPTED: ead8a8746188b8f480c0115ad556b766dfbd73fa`。只读 sandbox 的 workspace test 因 Vitest 无法在系统 temp 建目录而 `EPERM`；同一 head 的本地 hard-env 全仓与 GitHub CI 是执行权威。Claude review remained paused and was not invoked。
- Closeout：PR #36 retarget `main` 后维持 32/32 CI green，merge `68b6020921cd5a104d8df071599b6cac2226a387`；`origin/main` readback 同 SHA，S6 三刀完成。
