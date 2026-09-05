# deepseek-harness / pi-ai provider catalog 移植到 @byok-sdk/keys

Captured 2026-09-06。

## 来源快照

- `deepseek-ai/deepseek-harness@47f9438` `packages/llm/llm-deepseek/src/index.ts`：`PUBLIC_BASE_URL = 'https://api.deepseek.com'`、`DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'`、`BASE_URL_ENV = 'DEEPSEEK_BASE_URL'`，provider route 名为 `deepseek-official`。
- 同仓 `packages/llm/llm-pi-ai/src/{index,provider,catalog}.ts`：route 的 `baseURL` / `api` / `apiKeyEnv` / `displayName` 全部从 pi-ai 的 catalog 解析出来，override 里只允许指名 `openai-completions`、`openai-responses`、`anthropic-messages` 三种 API。
- `@earendil-works/pi-ai@0.84.2` `dist/providers/*.js`。harness 自己 pin 的是 `^0.82.1`，而本 SDK pin 的 `@earendil-works/pi-coding-agent` 0.84.2 解析到 pi-ai 0.84.2，所以取 0.84.2 为准。0.84.2 与 0.84.4 之间唯一有差异的 provider 文件是 `xai.js`：0.84.4 去掉了 `openai-completions`。
- harness 的 `deepseek-official` 与 pi-ai 的 `deepseek` 条目在 base URL 和 credential env 上完全一致，两个来源在所有被移植的端点上不冲突。

## URL 映射规则

SDK 的 `openai_compatible` client 往 `base_url + /chat/completions` 发请求，pi-ai 的 `openai-completions` 把 `baseUrl` 交给 OpenAI SDK，后者拼的也是 `chat/completions`——所以 OpenAI 方言的 URL 逐字照抄。

SDK 的 `anthropic` client 往 `base_url + /messages` 发请求，而 pi-ai 把 `baseUrl` 交给 Anthropic SDK，后者拼的是 `/v1/messages`——所以 anthropic 方言的条目在移植时补上 `/v1` 段。

`auth_mode` 由 SDK 现有的 legality 规则决定：`openai_compatible` 用 `bearer`，`anthropic` 用 `x_api_key`。kind id 直接沿用 pi-ai 的 provider id，这样 profile 的 `provider_kind` 指的就是 harness 会走的那条 route。

## 收录条目（27）

| id | display name | SDK base_url | adapter | api_key_env |
|---|---|---|---|---|
| `ant-ling` | Ant Ling | `https://api.ant-ling.com/v1` | openai_compatible | `ANT_LING_API_KEY` |
| `baseten` | Baseten | `https://inference.baseten.co/v1` | openai_compatible | `BASETEN_API_KEY` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | openai_compatible | `CEREBRAS_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | openai_compatible | `DEEPSEEK_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | openai_compatible | `GROQ_API_KEY` |
| `huggingface` | Hugging Face | `https://router.huggingface.co/v1` | openai_compatible | `HF_TOKEN` |
| `moonshotai` | Moonshot AI | `https://api.moonshot.ai/v1` | openai_compatible | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | Moonshot AI CN | `https://api.moonshot.cn/v1` | openai_compatible | `MOONSHOT_API_KEY` |
| `nvidia` | NVIDIA | `https://integrate.api.nvidia.com/v1` | openai_compatible | `NVIDIA_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | openai_compatible | `OPENAI_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | openai_compatible | `OPENROUTER_API_KEY` |
| `qwen-token-plan` | Qwen Token Plan | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | openai_compatible | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-cn` | Qwen Token Plan CN | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | openai_compatible | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `together` | Together | `https://api.together.ai/v1` | openai_compatible | `TOGETHER_API_KEY` |
| `xai` | xAI | `https://api.x.ai/v1` | openai_compatible | `XAI_API_KEY` |
| `xiaomi` | Xiaomi | `https://api.xiaomimimo.com/v1` | openai_compatible | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan AMS | `https://token-plan-ams.xiaomimimo.com/v1` | openai_compatible | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan CN | `https://token-plan-cn.xiaomimimo.com/v1` | openai_compatible | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan SGP | `https://token-plan-sgp.xiaomimimo.com/v1` | openai_compatible | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `zai` | Z.AI | `https://api.z.ai/api/coding/paas/v4` | openai_compatible | `ZAI_API_KEY` |
| `zai-coding-cn` | Z.AI Coding CN | `https://open.bigmodel.cn/api/coding/paas/v4` | openai_compatible | `ZAI_CODING_CN_API_KEY` |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | anthropic | `ANTHROPIC_API_KEY` |
| `fireworks` | Fireworks | `https://api.fireworks.ai/inference/v1` | anthropic | `FIREWORKS_API_KEY` |
| `kimi-coding` | Kimi For Coding | `https://api.kimi.com/coding/v1` | anthropic | `KIMI_API_KEY` |
| `minimax` | MiniMax | `https://api.minimax.io/anthropic/v1` | anthropic | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax CN | `https://api.minimaxi.com/anthropic/v1` | anthropic | `MINIMAX_CN_API_KEY` |
| `vercel-ai-gateway` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | anthropic | `AI_GATEWAY_API_KEY` |

`openai` 和 `xai` 记为 `openai_compatible`，尽管 pi-ai 0.84.2 给 `openai` 默认选的是 `openai-responses`；`xai` 在 0.84.2 同时提供两种方言，0.84.4 只剩 responses。SDK 只有两种方言，取 completions 这一支。

## 排除条目与理由

- `amazon-bedrock`、`google-vertex`：走云厂商 credential chain，没有单一 API key。
- `azure-openai-responses`、`cloudflare-ai-gateway`、`cloudflare-workers-ai`：endpoint 里必须带 account / resource 段，不存在可静态声明的 base URL。
- `google`：`google-generative-ai` 方言，SDK 不支持。
- `mistral`：`mistral-conversations` 方言，SDK 不支持。
- `github-copilot`、`openai-codex`：OAuth，不是 API key。
- `opencode`、`opencode-go`：没有 provider 级别的 base URL，按 model 逐个解析。
- `radius`：`pi-messages` 方言，SDK 不支持。
- `faux`、`openrouter-images`：不是 chat 端点。
- `qwen-token-plan-individual`：endpoint 与 credential env 都和 `qwen-token-plan` 相同，SDK 没有 per-vendor model catalog，两者无法区分。

## 没有移植的东西

harness 的 `DEEPSEEK_BASE_URL` 环境变量 override、per-route retry policy、thinking / reasoning 开关、model catalog、`streamIdleTimeoutMs` 都不在移植范围内。SDK 的 profile 显式携带 `base_url`，请求期不做任何环境变量解析。

## 对既有 SQLite store 的影响

`provider_profile` 的 CHECK 约束现在由 `MODEL_PROVIDER_KINDS` / `MODEL_PROVIDER_ADAPTERS` / `PROVIDER_AUTH_MODES` 生成。早先版本建出来的 store 里存的是旧 DDL，打开时会以 `PROVIDER_STORE_SCHEMA_STALE` fail closed，必须删掉库文件重建。plan 里已裁定不做 in-place migration。
