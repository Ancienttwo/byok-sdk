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
- Targeted：2 files / 13 tests green；client full suite：98 files / 948 tests green。
- Hard env/full workspace：core 112、keys 330、protocol 189、cloud 130、server 217、client 948、conformance 117、cloud-postgres 200；full typecheck/test/build green。
- Deploy SQL order、architecture sync（advisory，blocking=0）、task sync、strict workflow green；相对 `7f26b5c` 的 `packages/protocol/**` 与 `deploy/sql/**` 零 diff。
- Packaging：Bun single-file smoke green；`npm pack --dry-run` green（client tarball 82 files，包含两份新 d.ts）；本机 Node 26.5.0 报 `Single executable application is disabled`，因此 SEA 由 PR CI 的 Node 20/22/cross-platform legs作为 authority。
- Contract verifier 第一次重跑因 handoff resume 早于 `tasks/current.md` 被 strict workflow 拒绝；刷新 resume 后该 gate green。第二次只撞到既有 `long-poll-validation-stall.test.ts` wall-clock flake（期望第二次 fetch 尚未发生，实际已发生），同轮 hard-env 全仓 test green；该单文件随后连续 5/5 green，未改无关产品代码。
- Claude review remains paused；independent Codex exact-SHA security acceptance 尚未执行。
