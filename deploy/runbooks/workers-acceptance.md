# Workers 真实验收执行手册（#654 / #794）

状态：窗口准备材料；本文不声明任何云端或真机验收 PASS。owner 于 2026-11-14 批准重启 W1–W4 验收：总上限 **USD 10**，只用 `workers.dev`（无 zone / route），PlanetScale **development branch**，当天拆除。不阻塞 0.43.0。真实模型调用仍须逐次获批 model、次数和子预算；不能把部署预算当作模型授权。

角色：**owner** 创建/删除云资源、输入所有凭证、操作 GUI、比对批准码；**operator seat** 在 operator 机器 mini-cf 准备构建和非敏感材料、记录脱敏证据；**device seat** 通过 hc 操作专用设备 checkout；**t3** 固定窗口和逐行结论。本文中的带凭证命令由 owner 在私有 operator 终端运行，seat 可指导但不读取填好的环境或命令输出中的秘密。mac-pro 是另一个账号的机器：本次文档/代码交付的远端验证只允许 build、typecheck、纯单元测试；本文写出的配对、keychain、浏览器及其他验收命令留到 owner 的真实窗口，按每行指定的角色执行。

入口：[Worker example](../../examples/hosted-bot-collaboration-worker/README.md)、[W1/W4 操作与页面](../../examples/hosted-bot-collaboration-worker/src/fixtures/sealed-canary/README.md)、[现有 hosted 运维手册](hosted-operations.md)。标号保留旧执行单的 C、2.x、5.x、T，方便对照历史记录。W1=#1625（部署 canary），W2=#1624、W2b=#1630（设备），W3=#1628（向量），W4=#1629（页面），W5=#1638（provisioning）；均已合入 main。

## 边界、证据和停止规则

- 只建 `byok-p9-h`、`byok-p9-canary` 两个 Worker；H 使用 `HostClock` DO 和每分钟 cron。不要部署本地 fixture `src/fixtures/sealed-canary/worker.ts`、AgentDO 或 smoke Worker。`H_FAULT` 不设。
- PlanetScale：`aiphabee-staging` 的新 dev branch `byok-p9`，数据库 `postgres`，四个 `byok_p9_*` schema、两个同前缀 role；不连接 main。**Postgres 主版本必须为 18、ssl=on、可用连接 ≥13**。两个 Hyperdrive 各限 5 条 origin connection，留 3 条给迁移/检查；并发监视余量，不自行提高限制。
- AiphaBee 的三个 Hyperdrive 配置 `AIPHABEE_HYPERDRIVE`、`AIPHABEE_RELEASED_MARKET_DATA_HYPERDRIVE`、`AIPHABEE_AUTH_HYPERDRIVE` 不打开、不复用、不修改。seat 不创建云资源，不登录 Cloudflare/PlanetScale，不读写真实凭证。
- 所有跨机操作只走 `hc run|exec|file|send|read --on <machine>`，不用 raw ssh/scp、隧道或 Cloudflare Access 登录。hc 不通就报告 t3，不自行登录或重连。Windows 槽先由 t3 与 t8 协调；确认物理机还是 VM，VM 结果必须标明 VM。
- seat 只能停止能证明属于自己的进程：cwd/argv 指向自己的 worktree，或 ppid 链追到自己的 shell。记录 hc terminal、PID、cwd/argv；不明进程只报告给 t3。不得按名字批量杀 node/wrangler。owner 同样先核对自己的 runner 标识再清理。
- `_ops/p9` 只在 operator 机器，目录 700、私有文件 600；DSN、S3 key、bearer、原始 tail、成员私钥均不传设备。设备仅接收 Host URL、配对码、pv、public bundle、合成输入。不开 shell tracing；不打印 env、不 dump keychain、不读 `member-keys`。
- 每行记录：UTC 开始/结束、操作者、命令（隐去秘密）、`WINDOW_SHA`、SDK tag/SHA、overlay 文件 hash、部署 version id、OS/浏览器版本、计数/hash、PASS/FAIL/OPEN 和清理状态。结果分 Node / Worker / 跨进程 / 每台物理设备 / 每个浏览器引擎 / synthetic / real runtime；不汇总成一个 PASS。
- 不提交 token、密码、DSN、pairing/pv/批准码、presigned URL、canary 明文、对象原文、原始 tail。研究及运行证据放 `docs/researches/`，issue/PR 记录逐行结论；[VALIDATION](../../packages/bot-collaboration/VALIDATION.md) 的两行不能在缺证据时改 PASS。
- C5 任一句（尤其 GRANT）失败，或 C6 任一门失败，立即停止并报告，不修改数据库配置。P2 任一 smoke 失败不进入配对。验收行失败只继续无依赖行，不在窗口改代码重试；先停自己的 runner、记录 FAIL，再 P5。代码变化要新窗口 SHA 和重新构建。
- 发现秘密泄露：停止相关操作，owner 轮换/撤销，证据只记事件和处理结果。预算到 USD 10 或不足以覆盖余下操作时停止验收并保留 teardown 时间。无论失败、换机、hc 中断，都在当天完成 P5。
- 本轮不启用 CI 的 `test:browser` 或 `BYOK_TEST_WORKER_SEALED_CANARY`，不涉及 #1499、下游迁移或 #977。窗口内手动 W3 和远端 HTTPS W1 与这些 CI 开关分开。

## P0 — 固定版本、构建和设备预检（seat；约 20–40 分钟）

| 行 | 谁 / 命令或操作 | 通过条件 / 停止条件 | 验收映射 |
| --- | --- | --- | --- |
| C1 / 2.1 | t3 / operator seat：`git fetch origin main --tags`，在干净 checkout 固定下面的 `WINDOW_SHA`，记录 `git rev-parse HEAD`；`hc machine ls` | SHA 在 main，包含 #1663 的 sender 修正及本手册的 keychain 参数；否则停 | #794 D3，#654(d)(e) 共用 |
| C2 / 2.2 | device seat：`hc exec --on mac-pro 'uname -sm; sw_vers; node -v; bun -v; git --version'`；只检查 `~/byok-p9` 自己准备的目录和 checkout | Node 满足所选 tag 的 engines，Bun 按该 tag packageManager；不得复用 11-11 已配对 root | #794 设备 / #654(d)(e) |
| C11 | operator seat：窗口 SHA 上 `bun ci`、`bun run build`、`bun run typecheck`；在 example 目录确认 `bunx wrangler@4.158.0 --version` | 都 exit 0；失败停在 P0 | 全部 |
| 2.3–2.6 | device seat：最新已发布稳定 tag（至少 v0.42.0）+ 窗口 SHA 两文件 overlay，按下方命令 build/typecheck | overlay 仅两文件，编译 exit 0；不得混入未发布 SDK | #794 5.2/链、#654 5.11/5.15 |
| 2.8 | device seat：在独立窗口 SHA checkout `bun ci && bun run build`；owner 在窗口内安装浏览器：`PLAYWRIGHT_BROWSERS_PATH="$HOME/byok-p9/ms-playwright" bun node_modules/playwright/cli.js install chromium firefox webkit` | W3 用 main checkout；不把浏览器依赖装进 SDK tag checkout；失败该引擎 OPEN/FAIL | #654(e) 5.13 |

固定版本（operator / t3；后续所有步骤复用同一个变量，不能中途重取 main）：

```sh
git fetch origin main --tags
WINDOW_SHA="$(git rev-parse origin/main)"
# #1663 的实现由 #1705 合入；不是把 issue 号当作 commit。
git merge-base --is-ancestor 333a5ef9f53e12952613132d7bb94d7a35d1e48a "$WINDOW_SHA"
git merge-base --is-ancestor "$WINDOW_SHA" origin/main
git checkout --detach "$WINDOW_SHA"
SDK_TAG="$(gh release view --json tagName --jq .tagName)"
gh release view "$SDK_TAG" --json tagName,isDraft,publishedAt
# t3 确认：稳定发布、非 draft、>= v0.42.0；记录 tag 对应 commit。
git rev-list -n 1 "$SDK_TAG"
```

窗口 SHA 必须还包含本 PR 的 keychain CLI/W1 透传；选取时确认 `device-runner.ts` 有 `--macos-keychain-path` 的实现。#1663 使 outbox sender 每轮 pass 运行，projection/home/card/host_job 才有正确处理；D3 证据不得用此前的 head。记录 `send.steps / send.failed / send.synced` 和 `host_projection` 的去重结果；无 card/channel connector 时其显式失败不是发送成功证据。

设备独立 checkout 上（把 t3 给出的 **同一窗口 SHA** 和发布 tag 设为本地 `WINDOW_SHA` / `SDK_TAG`；不传 operator 环境）：

```sh
git fetch origin main --tags
git checkout --detach "$SDK_TAG"
git checkout "$WINDOW_SHA" -- \
  examples/hosted-bot-collaboration-worker/src/device-runner.ts \
  examples/hosted-bot-collaboration-worker/src/device-session.ts
git status --short
bun install --frozen-lockfile
bun run build
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker typecheck
shasum -a 256 examples/hosted-bot-collaboration-worker/src/device-{runner,session}.ts
```

不得从旧 SDK tag 开始再改 package manifest 补 API。runner 的 `daemon.whenTaskSettled` 来自 #1838，因此最低 v0.42.0。Windows PowerShell 等价命令见 example README；不传 macOS keychain 参数，安装 optional dependencies 并先验证 `koffi` 可加载。一个设备一个专用 OS user；mac-pro 11-11 曾获准用现有账号，本窗口由 owner 确认沿用账号，所有文件限制在本窗口目录和专用 keychain。

## P1 — owner 资源和私有配置（约 50–65 分钟）

这些步骤只由 owner 在 dashboard / 私有终端做。seat 的本文准备阶段不执行任何一个步骤。若接手时资源已经存在，先核对创建者、窗口和名字，向 t3 报告；当天仍须拆除。

| 行 | 谁 / 命令或操作 | 通过条件 / 停止条件 | 验收映射 |
| --- | --- | --- | --- |
| C3 | owner：Cloudflare → Workers & Pages → Plans → Workers Paid；核对 USD 10 总预算和当天 teardown | 返回 “Paid on”、计费起点；费用不符停 | 全部云端行 |
| C4 | owner：PlanetScale → `aiphabee-staging` → New **development branch** `byok-p9` | Connect 页面确认目标分支和独立 host/branch id；不是 main | 全部存储行 |
| C5 | owner：从仓库根运行 `pscale shell aiphabee-staging byok-p9 --role admin`，交互中 `\i deploy/runbooks/workers-acceptance/c5-roles.sql`，然后 `\password byok_p9_h`、`\password byok_p9_canary` | 两 role / 四 schema / 数据库限定 search_path；任一句失败停，尤其 `GRANT CREATE ON DATABASE postgres` | #794 H、#654(d)(e) |
| C6 | owner：同一 shell 中 `\i deploy/runbooks/workers-acceptance/c6-baseline.sql` | **major=18、ssl=on、available_connections≥13**；记录 version、连接计数、非 P9 schema/role 排序列表及 MD5。任一失败停，不改配置 | 全部云端行 |
| C7 | owner：新 Hyperdrive `byok-p9-h` / `byok-p9-canary`；origin 为 dev branch host:5432 / postgres，分别用 branch-qualified `byok_p9_h.<branch_id>`、`byok_p9_canary.<branch_id>`，TLS，各 max origin connections=5 | 两 Active；只把非秘密 config id 给 seat；不打开 AiphaBee 的三个配置 | #794 pooling，#654(d) |
| C8 | owner：R2 bucket `byok-p9-staging`；S3 token 仅该 bucket Object Read & Write | 私有 endpoint/key 留 operator；W4 走同源 `/member/ciphertext`，无需为本页开 R2 CORS | #794 5.7、#654(d)(e) |
| C9 | owner：当天到期部署 token，Account Workers Scripts: Edit + Workers Tail: Read，无 zone 权限；启用 workers.dev | account id / subdomain 可给 seat；token 不能给 seat。Hyperdrive/R2 由 owner 建，不给 deploy token 多余权限 | 共用 |
| C10 | owner：复制 [模板](workers-acceptance/p9.env.template) 到 ignored `_ops/p9/p9.env`，目录 700 / 文件 600，私有 editor 填写，使用自己的 env loader 装入当前私有进程 | DSN 直连5432、`sslmode=verify-full`、正确角色/schema；H/canary token key 不同；JSON一行。只返回“已填”，seat 不查看文件或 env | 共用 |

[c5-roles.sql](workers-acceptance/c5-roles.sql) 临时授予 H role 数据库 CREATE，只供迁移；C12 后 owner 撤销。[c6-baseline.sql](workers-acceptance/c6-baseline.sql) 是只读查询，排除 P9 名字，使 T4 能核对非 P9 名字/hash 不变。它不扫描业务数据。

## P2 — 迁移、部署和冒烟（owner 操作凭证命令；seat 核对脱敏结果，约 30–45 分钟）

| 行 | 谁 / 命令或操作 | 通过条件 / 停止条件 | 验收映射 |
| --- | --- | --- | --- |
| C12a | owner：私有 env 中分别运行 `DATABASE_URL="$P9_H_DATABASE_URL" deploy/scripts/migrate`、`DATABASE_URL="$BYOK_CANARY_POSTGRES_URL" deploy/scripts/migrate` | 读取**窗口 SHA** 的 `deploy/sql` 清单/checksum，不钉旧的最后一个 SQL 文件；checksum 或迁移失败停 | 共用 |
| C12b | owner：H Node DDL 见下方；然后 branch admin shell `REVOKE CREATE ON DATABASE postgres FROM byok_p9_h;` | H 表、`byok_p9_host.host_scope` 和 `host_projection` 存在；撤权失败停 | #794 / #1663 |
| C13 | operator seat：`bun examples/hosted-bot-collaboration-worker/src/build-member.mjs`；准备 `_ops/p9` 两份配置，按下方清单核对路径（只含非敏感配置） | assets 存在，`git check-ignore _ops/p9`，tracked 配置不变 | #654(e) / 共用 |
| C14 | owner：下方 `wrangler secret put` 七次，私有输入 | `secret list` 只核对名字，任何错误停；不把值传给 seat | 共用 |
| C15 | owner：`bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-h.wrangler.jsonc`；`GET /byok/capabilities` | 200，含 longpoll/batch/presigned，不含 contentproxy；binding BYOK_PG、HOST_CLOCK、cron；记录 version id | #794 Worker |
| C16 | owner：`bunx wrangler@4.158.0 tail byok-p9-h --format json > _ops/p9/h-tail.jsonl`；等待 ≤75秒；`POST /host/passes {}` 有/无 admin bearer | cron 自启动、不靠请求，至少两条约15秒间隔 alarm pass；有 bearer 200/无 bearer 401；失败停 | #794 clock/auth |
| C17 | owner：deploy canary；`GET /member`、`GET /member.js`、无 bearer `POST /probe/call`、`GET /member/ciphertext`，再 capabilities | 静态资源200；两个控制端点401；E2EE member capability 存在；缺 key 时503是失败，不能略过 | #654(d)(e) |
| C18 | owner：用下方 W5 scope CLI；owner session token 只向 owner 输出一次并私有保存 | scope entitlement + host_scope 存在；重跑会轮换 session token；不贴 stdout 给 seat | #794 5.1–5.8 |
| C19 | t3 / seat：汇总 H smoke、canary auth/static、版本和预算/teardown 时间，核对每项结果，go/no-go | 历史 handoff 将本阶段概称 C14–C22，但执行单只定义到 C19；本文保留可核对的 C14–C19，不虚构其余行。P2任一失败转P5 | 共用 |

H DDL：owner 在 repository root、私有 `DATABASE_URL` 已选 H role 后运行，所有 import 来自窗口 SHA。固定错误消息避免驱动错误输出 DSN：

```sh
DATABASE_URL="$P9_H_DATABASE_URL" node --import tsx --input-type=module <<'JS'
import pg from 'pg';
import { HostedCollaborationStore } from './examples/hosted-bot-collaboration/src/index.ts';
import { hostScopeDdl, hostProjectionDdl } from './examples/hosted-bot-collaboration-worker/src/host-scopes.ts';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const store = new HostedCollaborationStore(pool, 'byok_p9_h', { host: async () => ({ models: {} }) });
  await store.migrate();
  await pool.query(hostScopeDdl('byok_p9_host'));
  await pool.query(hostProjectionDdl('byok_p9_host'));
  console.log('H DDL OK');
} catch { console.error('H DDL failed; stop and report'); process.exitCode = 1; }
finally { await pool.end(); }
JS
```

C13 配置清单（operator seat 准备，owner 核对账号和 id）：

- H：复制 `examples/hosted-bot-collaboration-worker/src/wrangler.json` 到 `_ops/p9/byok-p9-h.wrangler.jsonc`；`name=byok-p9-h`，`main=../../examples/hosted-bot-collaboration-worker/src/worker.ts`，`workers_dev=true`；替换 Hyperdrive id。保留 compatibility date/flags、DO `HostClock` SQLite migration v1、cron `* * * * *`。
- H vars：`H_SCHEMA=byok_p9_h`、`HOST_SCHEMA=byok_p9_host`、`H_CLOCK_MS=15000`、`BYOK_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`、`BYOK_S3_BUCKET=byok-p9-staging`、`BYOK_S3_REGION=auto`；无 `H_FAULT`、无 secret vars。
- Canary：复制 `src/fixtures/sealed-canary/wrangler.deployable.template.json` 到 `_ops/p9/byok-p9-canary.wrangler.jsonc`，只填新 canary Hyperdrive id / owner account 配置。模板 main 相对该目录已正确；ASSETS 的 `./member-assets` 是 C13 输出。同源 member 页不需要 R2 CORS。

C14（owner 在 operator 私有终端输入；首轮若 CLI 要创建 Worker stub，只允许两个 P9 名字，失败停，不改成无秘密公开运行）：

```sh
bunx wrangler@4.158.0 secret put BYOK_TOKEN_SECRET -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_S3_ACCESS_KEY_ID -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_S3_SECRET_ACCESS_KEY -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_TOKEN_SECRET -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_CANARY_STORAGE -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-canary.wrangler.jsonc
```

C18：owner 先准备私有 `_ops/p9/host-config.json`（HostConfig，`models.default` 为所选 stub execution template、`readOnlyToolsets: []`；形状取窗口的 `examples/host-execution-core/src/test-support.ts#template`）。初始可用 pending device，配对后以实际 deviceId 更新模板，再重新 provision 并使用新 token。

```sh
cd examples/hosted-bot-collaboration-worker
# owner 的私有环境：DATABASE_URL=H直连DSN，HOST_SCHEMA=byok_p9_host
node --import tsx src/operator-provision-cli.ts scope p9-scope --owner p9-owner --config ../../_ops/p9/host-config.json
# W4 每个浏览器一轮用新 tenant；DATABASE_URL 改为 canary 直连 DSN
node --import tsx src/operator-provision-cli.ts entitlement p9-browser-tenant
```

HTTP 行的命令记法为 `METHOD /path JSON`，请求体和方法如表所列；由 owner 的私有客户端发送，Authorization 从内存/env 取，不拼进 curl argv。例如 `POST /host/passes {}`：

```sh
node --input-type=module <<'JS'
try {
  const r = await fetch(new URL('/host/passes', process.env.P9_H_BASE_URL), {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.HOST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}'
  });
  console.log('HTTP', r.status);
  if (!r.ok) process.exitCode = 1;
  // 只提取批准的计数给证据，不打印整份 response。
} catch { console.error('P9 request failed'); process.exitCode = 1; }
JS
```

## P3 — 不依赖 mac-pro keychain 的行（约 30–45 分钟）

| 行 | 谁 / 命令或操作 | 通过条件 / 停止条件 | 验收映射 |
| --- | --- | --- | --- |
| 5.9 / W1.1 | owner/operator：`bunx wrangler@4.158.0 tail byok-p9-canary --format json > _ops/p9/canary-tail.jsonl`，保持自己的 tail 进程存活，记录terminal/PID | 全程捕获日志；tail 中断则本行不能作为完整零命中证据 | #654(d) 日志 |
| 5.10 / W1.2 | owner/operator：私有 env 装入 canary URL、直接DSN、bearer、storage JSON、绝对 tail path；**不设 BYOK_CANARY_DEVICE**；运行下方 W1 命令 | sealed和plain twin都完成；sealedHits=0；inventory diff 的missing/unexpected均空；twin在outbox.body和对象中命中，成员解密成功。单独标 “operator-machine daemon (mini-cf)” | #654(d)，不替代物理设备 |
| 5.4 / W2.1 | owner/operator：用独立 SDK device 客户端打开 `GET /byok/board/stream`，收到headers后 `POST /host/board-item {"scope":"p9-scope","item":{"itemId":"p9-after-headers","channel":"worker","title":"synthetic"}}`（admin） | 新 `event: board` 到达；记录event id。需要设备bearer，不能拿admin bearer替代；无已授权客户端则等P4，不伪报无设备PASS | #794 SSE/pool生命周期 |
| 5.5 / W2.2 | owner/operator：使用窗口 `src/clock.test.ts` 的routine fixture通过Node `store.seed`/`bindDevice`设置未来slot；让cron/alarm自行执行，不调 `/host/passes` | `scheduled` 在60秒late bound内；一occurrence、一offer；未配对/未ready时留待P4 | #794 DO/cron |
| 5.6 / W2.3 | owner/operator：对ready Bot发10个并发 `POST /host/input {"botId":"main","key":"<distinct-id>","request":"synthetic"}`（owner session） | 各commit一次；tail无prepared statement/search_path错误；没有ready Bot则等P4 | #794 Hyperdrive pooling |
| 5.13 / W3 | owner 在mac-pro独立main checkout：`cd examples/hosted-bot-collaboration-worker`，`PLAYWRIGHT_BROWSERS_PATH="$HOME/byok-p9/ms-playwright" bun run test:browser` | Chromium/Firefox/WebKit全绿，记录每个userAgent及Playwright版本；任何一引擎失败单记FAIL，缺引擎OPEN | #654(e) Layer V |

W1 命令（operator owner；远端 HTTPS case 用 `BYOK_CANARY_BASE_URL` opt-in，**无需打开本地 canary CI 开关**）：

```sh
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test \
  src/sealed-zero-hit.test.ts -t 'owner-configured HTTPS canary'
```

5.4–5.6 的完整 fixture/断言分别在 `src/worker.test.ts`、`src/clock.test.ts`。它们的本地 suite 会自行建 role/schema 和 wrangler dev，**不能把本地测试的 POSTGRES_URL 换成 PlanetScale 后整套运行**。窗口只移用场景设置到既有 P9 role/schema，经已部署 URL 发送请求。准备好的 Node 场景命令/fixture hash 在 P0 由 t3 核对；不能用直接 SQL 写入结果行冒充 Worker 执行证据。

## P4 — mac-pro 专用 keychain、设备和浏览器（owner，约 60–90 分钟）

### 2.7 默认专用 keychain（owner；先 security 往返验证）

11-11 row 2.7 的 login keychain 在 GUI 终端仍写入 exit 36；解锁不能视为修复。本窗口 mac-pro 默认使用**新专用 keychain**，通过公开 `deviceCredentials.macosKeychainPath` 指定，runner 提供 `--macos-keychain-path`，W1 的 `BYOK_CANARY_DEVICE.macosKeychainPath` 透传同一参数。无需手改 checkout，不改系统默认 keychain 或全局 search list。

owner 在 mac-pro GUI 终端创建/解锁（系统提示交互输入密码，不用 `-p <password>` argv，不让seat查看）：

```sh
P9_KEYCHAIN="$HOME/Library/Keychains/byok-p9.keychain-db"
# 若已存在，先核对归属，禁止覆盖。
security create-keychain "$P9_KEYCHAIN"
security unlock-keychain "$P9_KEYCHAIN"
security set-keychain-settings "$P9_KEYCHAIN"
# 仅合成的公开往返值，无任何设备凭证。
security add-generic-password -s byok-p9-roundtrip -a byok-p9-probe -w p9-public-probe "$P9_KEYCHAIN"
test "$(security find-generic-password -s byok-p9-roundtrip -a byok-p9-probe -w "$P9_KEYCHAIN")" = p9-public-probe
security delete-generic-password -s byok-p9-roundtrip -a byok-p9-probe "$P9_KEYCHAIN"
```

用与runner相同的OS用户/启动上下文再验证一轮（owner操作，不把密码输入hc消息）。任一命令非零，包括exit36，**停止所有依赖keychain的行**，报告t3；不切换内存凭证或把密码写文件。回收时删除专用keychain。记录这是相对11-11 login-keychain流程的调整；#654证据注明公开配置路径（可隐去用户名）。

### 设备与跨设备行

| 行 | 谁 / 命令或操作 | 通过条件 / 停止条件 | 验收映射 |
| --- | --- | --- | --- |
| 5.1 / W2.5 | owner/operator：`POST /host/pairing-code {"scope":"p9-scope"}`（admin）；就近使用新code | code不入证据，过期重新配对 | #794 |
| 5.2 / W2.6 | owner/mac-pro：下方runner命令，root在 `~/byok-p9/`，runtime stub，带专用keychain参数 | ready事件；DB device.machine_id非null，记录device hash、SDK tag/SHA/overlay hash | #794 macOS |
| setup / 5.3 | owner/operator：用真实deviceId更新C18 HostConfig；按 `src/worker.test-support.ts#openHome.bot` 的Node设置 `store.seed`（seedCollaboration、初始t1终态、main.execution）和 `store.bindDevice`，不调用 `openHome`（它会创建本地substrate）。再 `POST /host/input {"botId":"main","key":"p9-turn-1","request":"synthetic"}` → pass → started → `hc send <owned-terminal> '{"type":"finish","taskId":"<id>","document":{"text":"synthetic"}}'` → pass | 一offer、一command/outcome，Turn settled；#1663 sender每轮运行，projection去重、home ready；失败不继续依赖行 | #794 单设备和sender |
| 5.7 / W2.8 | owner/mac-pro：通过SDK blob prepare/upload/commit路径上传合成artifact，再走presigned GET下载；W1物理设备行也覆盖artifact上传 | R2对象和manifest存在、size/hash吻合；记录hash/size不记录URL/bytes；没有下载证据不能借W1上传判PASS | #794 R2 |
| 5.8 / W2.9 | owner/operator：在in-flight场景redeploy同一窗口代码和配置，`wrangler deploy -c _ops/p9/byok-p9-h.wrangler.jsonc` | 下一alarm重读PG、一次完成；记录两version id/前后counts；redeploy只能证明版本切换恢复，不能冒充观测到平台自然eviction | #794 isolate恢复 |
| chain / W2.10 | owner：只有win-ci物理Windows槽可用且获批时，配对第二Bot/独立enrollment+home，按 `src/two-devices.test.ts` 的A→B→A场景执行 | 两个不同非null machine_id；每Turn只在所属设备一次、每outcome/reply一次；只有mac-pro则此行OPEN，第二Mac也不算macOS+Windows | #794 两物理设备 |
| real / W2.10 | owner逐次批准runtime/model、3 Turns预算后，用 `--runtime real` 重复链 | 记录model/runtime、usage/费用和同样counts，单独real行；没批准或Windows未到位则OPEN | #794 real runtime |
| 5.11 / W1.3 | owner/operator：设置下方BYOK_CANARY_DEVICE后重跑W1命令 | 自动比对50位code/MAC，sealed零命中、twin阳性、member解密；标“physical device (mac-pro)” | #654(d) macOS |
| 5.12 / W1.4 | owner：Windows独立root，用machine=win-ci，不给macosKeychainPath，重复W1 | 单独Windows证据；VM注明VM；不可达则OPEN | #654(d)(e) Windows |

runner 示例（owner 可通过 `hc run --bg --on mac-pro --cwd <device-checkout>/examples/hosted-bot-collaboration-worker` 启动同一命令；配对argv/hc历史私有）：

```sh
node --import tsx src/device-runner.ts \
  --server-url 'https://byok-p9-h.<subdomain>.workers.dev' \
  --pairing-code '<private-code>' --root "$HOME/byok-p9/device-root" \
  --runtime stub --macos-keychain-path "$HOME/Library/Keychains/byok-p9.keychain-db"
```

W1 operator 私有环境只设公开路径配置（用实际绝对路径，不把 `$HOME` 放在JSON里期待展开）：

```sh
export BYOK_CANARY_DEVICE='{"machine":"mac-pro","cwd":"<absolute-device-checkout>","root":"<absolute-fresh-canary-root>","macosKeychainPath":"<absolute-dedicated-keychain-path>"}'
```

W1 driver 从自身 `hc run` 返回的 terminal 操作、停止和移除自己的 runner；不能代为处理其他session。每次配对/绑定失败必须丢弃该root的anchor，不恢复；先清理这次root对应的keychain条目，再新root重新配对，保留失败行。用同一个keychain时不同root不能并行夺用同一product的enrollment。

### 5.3 的 Node 准备命令（owner/operator）

在operator仓库根，私有 `DATABASE_URL` 选择H role，`P9_DEVICE_ID` 为刚配对设备的公开id。此命令只设置初始场景，不写验收结果；随后重跑C18 scope CLI轮换owner token。与 `openHome.bot` 使用同一套fixture设置，避免把“provision scope”误当成“Bot已ready”：

```sh
DATABASE_URL="$P9_H_DATABASE_URL" node --import tsx --input-type=module <<'JS'
import pg from 'pg';
import { writeFile } from 'node:fs/promises';
import { HostedCollaborationStore } from './examples/hosted-bot-collaboration/src/index.ts';
import { seedCollaboration } from '@byok-sdk/bot-collaboration/testing';
import { template } from './examples/host-execution-core/src/test-support.ts';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  if (!process.env.P9_DEVICE_ID) throw new Error();
  const execution = template(process.env.P9_DEVICE_ID, 'main');
  const config = { models: { default: execution }, readOnlyToolsets: [] };
  const store = new HostedCollaborationStore(pool, 'byok_p9_h', { host: async () => config });
  await store.seed('p9-scope', state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    state.team.bots.main.execution = execution;
  });
  await store.bindDevice('p9-scope', process.env.P9_DEVICE_ID);
  await writeFile('_ops/p9/host-config.json', JSON.stringify(config), { mode: 0o600 });
  console.log('H scenario prepared; reprovision scope before input');
} catch { console.error('H scenario preparation failed; stop and report'); process.exitCode = 1; }
finally { await pool.end(); }
JS
```

### W4 浏览器成员页（#654(e) Layer M；owner；每引擎约15–20分钟）

| 行 | 谁 / 命令或GUI操作 | 通过条件 / 停止条件 |
| --- | --- | --- |
| 5.14 / W4.1–2 | owner/operator先以canary DSN运行C18的 `entitlement <fresh-tenant>`；owner在目标浏览器打开 `https://byok-p9-canary.<subdomain>.workers.dev/member`，输入bearer、tenant和product=`hosted-collaboration-worker`，生成keys | 只显示public bundle；bearer仅tab内存、不复制控制台或URL。每轮新tenant |
| 5.15 / W4.3 | owner：页面start fresh tenant，将私有pairingCode/pv给mac-pro runner，使用 `--verification-secret <pv> --runtime stub --stub-canary --macos-keychain-path <dedicated-path>` 和fresh root | paired事件；10分钟pair verification TTL，超时FAIL并新root |
| 5.16 / W4.4 | owner：页面输入deviceId并核验MAC；Copy public bundle；设备stdin `{"type":"member-bundle","bundle":<public-json>}`。两屏逐位比对全部50位approval code；匹配才给设备 `{"type":"approve"}` 并勾页面确认，不符 `{"type":"reject"}` | 设备anchor匹配后才ready；不把code传给页面或证据，不绕过人眼比较 |
| 5.17 / W4.5 | owner：active tab签C1/C3策略并发epoch1 scope keys；贴routing template `{deviceId,payload}`（字段见W4 README，省略instruction/sealing/sealed），submit → decrypt C3 | page PASS、hash=device canary-result sha256、chain length/task/epoch/userAgent；finished必须到达，只有digest不算完成 |
| 5.18 / W4.6 | owner：按W4 README双屏批准第二tab加入；移除其中一member；remaining tab签新epoch并发新task | removed tab=FAIL/member_revoked + scopeKey absent；remaining tab PASS/hash一致；旧epoch的失败不能代替新epoch撤销证据 |

Layer V 和 Layer M 各记一张矩阵：mac-pro Chromium、Gecko/Firefox、WebKit，以及真实GUI Chrome stable、Firefox release、系统Safari；Windows重复对应行。运行时采集版本/UA，不沿用11-11版本号；Firefox核对 `about:support` Update Channel=release，Store包版本不证明channel。mac-pro未装某引擎或Windows不可达，保持对应行OPEN。同一浏览器的向量PASS不代替成员e2e；一个macOS的三引擎PASS也不代替两物理设备。

## P5 — 当天 teardown T0–T9（预留约30–45分钟）

这是人工清单，**没有自动删除云资源的脚本**。owner核对资源归属后逐项删除云资源；device seat按窗口明确列出的名字删除设备侧runner条目、专用keychain、roots及checkout，不读取条目值。本次交付不执行这些清理命令。清理失败是未完成，不能写“已拆除”；t3当天跟进。

| 行 | 谁 / 命令或操作 | 完成证据 / 停止条件 | 对应验收 |
| --- | --- | --- | --- |
| T0 | **owner**：W4最后一轮后立即在两Worker上 `wrangler secret put HOST_ADMIN_TOKEN -c <P9-config>` 轮换；旧bearer测试H `POST /host/pairing-code`、canary `POST /probe/call` | 两端旧token均401；owner私有客户端验证，值不记录；失败停验收继续撤销/删资源 | #654(e) bearer进页面后的清理 |
| T1 | **owner**停止验收runner；seat仅能停止有cwd/argv/ppid归属证明的自己进程：先 `hc send <owned-terminal> '{"type":"stop"}'`，确认ended，再 `hc rm`；超时只有证明归属后才kill。device seat按下方清单删runner写入的keychain项、roundtrip项和专用keychain。seat检查自己checkout `git status -uall`，移除自己的 `~/byok-p9` checkout/roots/浏览器缓存和本轮enrollment数据 | 终端ended、自己的进程消失、root/checkout清完；无归属的进程/未知文件只报t3。Windows同理清Credential Manager指定targets | #794和#654设备清理 |
| T2 | **owner**：Cloudflare dashboard 删除Worker `byok-p9-h`（含本次HostClock DO/cron）与 `byok-p9-canary`；核对关联DO存储/绑定已移除，不留带cron的部署 | Worker/DO/cron名字列表确认无本窗口资源；不把修改现有Worker当teardown | 共用 |
| T3 | **owner**：删除两个Hyperdrive配置 `byok-p9-h`、`byok-p9-canary`；清空并删除R2 bucket **byok-p9-staging**；撤销该bucket的S3 token | dashboard确认两个新配置、bucket、token都不存在；不打开其他三个配置 | 共用 |
| T4 | **owner**：仍只连 `pscale shell aiphabee-staging byok-p9 --role admin`，撤CREATE、显式drop四schema和两role（见下方），重跑C6比较非P9列表/hash；再在dashboard删除dev branch **byok-p9** | baseline一致且dev branch已删；drop/对比失败报告t3，禁止改main或删除非P9对象 | 共用 |
| T5 | **owner**：撤销当天Cloudflare deploy API token | dashboard确认撤销；不能仅等TTL | 共用 |
| T6 | **owner**：决定Workers Paid是否保留；不保留则dashboard取消（period end生效），保留则在teardown记录原因及预计账单 | 明确owner决定，记录当日费用/无遗留P9计费资源；不擅自替owner取消其他用途的计划 | 预算 |
| T7 | **owner**：先保存脱敏counts/hash，再删除operator的 `_ops/p9`（含env、tail、私有config/token capture）；**seat**只删自己创建的额外worktree/无秘密临时文件，先 `git status -uall`，用 `git worktree remove <exact-owned-path>` | 私有目录不存在；不用 `/tmp/byok-sdk-wt-*` 通配删除，也不清其他seat目录 | 共用 |
| T8 | **owner**：关闭member tab，删除本轮专用browser profile/site数据；核对没有私钥/secret导出或保留的pairing clipboard/history | 本轮内存member keys失效，私有输入不流入交付证据 | #654(e) |
| T9 | **t3**：在#654/#794记录逐项teardown（名字、UTC、删除/保留Paid决定、费用、未完项）；验收结果逐行单记，后续缺口留在parent issue | owner亲做资源和凭证清理已确认，才记本窗口结束；缺Windows/real等行继续OPEN | 两issue独立 |

T1 keychain清理（device seat，不读值）：product `hosted-collaboration-worker` 对应service可从窗口的 `packages/client/src/daemon/device-credential-store.ts` 的 `serviceFor` 计算规则（SHA-256(productId)）核对；本product为 `com.byok.client.device.2b3d0f2634593b65f8264cc7b4eb57012017c0f066ba513317d7e641aa2fd498`。只查/删该service下四个account：`device-enrollment`、`device-member-p256-v1`、`device-member-pairing-v1`、`device-member-state-v1`；不使用 `-w` / `-g` 读取真实条目。逐项使用 `security find-generic-password -s <service> -a <account> <dedicated-keychain>`（元数据）和 `security delete-generic-password -s <service> -a <account> <dedicated-keychain>`。本窗口若有条目误写login keychain，owner按相同service/account核实归属后删除，不能“删除所有byok项”。然后：

```sh
# device seat：确认专用路径归属后运行，不能指向login.keychain-db。
security delete-generic-password -s byok-p9-roundtrip -a byok-p9-probe "$P9_KEYCHAIN"
# roundtrip正常已删：明确item-not-found可记录；其他错误不能忽略。
security delete-keychain "$P9_KEYCHAIN"
```

Windows由device seat删除本product service的enrollment target和 `<service>/device-member-{p256,pairing,state}-v1` 三个target，只核对名字不读密码；删fresh root及本轮checkout。不可达则T1为未完成，报告t3，不能用云端删branch代替设备清理。

T4人工SQL（owner；只在dev branch；先核对 `current_database()` 和连接目标，不用schema wildcard）：

```sql
REVOKE CREATE ON DATABASE postgres FROM byok_p9_h;
DROP SCHEMA byok_p9_h, byok_p9_host, byok_p9_sdk_h, byok_p9_sdk_canary CASCADE;
ALTER ROLE byok_p9_h IN DATABASE postgres RESET ALL;
ALTER ROLE byok_p9_canary IN DATABASE postgres RESET ALL;
DROP ROLE byok_p9_h, byok_p9_canary;
-- 重新运行c6-baseline.sql，对比非P9名字/hash；再由owner在dashboard删除byok-p9分支。
```

## 来源与恢复说明

本手册合并P9原计划、更新版n1 runbook、11-11 deploy-day-sheet/exec-log及[交接第6节](../../docs/releases/2026-11-11-coordination-handoff.md#6-部署日654794)。11-11执行记录仅证明C1/C2/C11预检/构建，**没有C3之后部署成功证据**，不能在新窗口复用PASS。后续路径以 `packages/bot-collaboration` 为准；旧计划中的W1–W4“待实现”和W5“无CLI”已由合入PR消除。

恢复来源（本地历史材料，只记录定位，不把transcript提交仓库）：

- P9计划与deploy-day-sheet/exec-log：`/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/20e86ea1-4e4b-4141-ad07-f1ed7e27e5bc/scratchpad/` 的同名文件。
- 更新版 `n1-runbook-794-654.md`：`~/.claude/projects/-private-tmp-byok-sdk-wt-n1-runbook/168de601-9100-48e3-88cc-3ea8ed80857e.jsonl` 第169行，Write调用的content。
- 三个SQL/env原件：`~/.claude/projects/-private-tmp-byok-sdk-wt-runbook/1ad10efe-9763-4cb9-b218-13d694c6b3ab.jsonl` 第1307行，Bash调用中三个 `cat > … <<'EOF'` 内容（并非Write调用）；用Python逐行JSON解析，只取这三段。
- 恢复后先用 `rg -n -i 'token|password|secret|postgres(ql)?://'` 检查：只有注释、变量名、空值和显式占位DSN，无真实token/密码/连接串。提交模板将所有赋值统一为 `<PLACEHOLDER>`，去掉旧seat的固定tail路径和可复制DSN形状；不从transcript其他输出读取凭证。SQL保留role/schema/GRANT意图，改成数据库限定search_path；baseline补ON_ERROR_STOP、主版本/可用连接和排序列表。

复核本地代码兼容性时，用临时worktree检出 `v0.42.0`（`14e0628d2`），只覆盖两个runner文件，`bun ci`、`bun run build`、example typecheck；最终SHA、文件hash、命令和结果见本PR验证记录。这只证明编译兼容性，P1–P5须在owner窗口另外取证。
