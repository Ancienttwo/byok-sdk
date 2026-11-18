-- keys 0.3.9 (v0.12.0): released DDL, with catalog interpolations expanded.
CREATE TABLE IF NOT EXISTS provider_profile (
  provider_id  TEXT PRIMARY KEY CHECK (provider_id IN ('openai', 'deepseek', 'anthropic', 'custom')),
  kind         TEXT NOT NULL CHECK (kind = 'model'),
  adapter      TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  auth_mode    TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model        TEXT NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_one_enabled
ON provider_profile(kind)
WHERE enabled = 1;

-- keys 0.3.10 (v0.13.0): released DDL, with catalog interpolations expanded.
CREATE TABLE IF NOT EXISTS provider_profile (
  profile_ref   TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai', 'deepseek', 'anthropic', 'custom')),
  kind          TEXT NOT NULL CHECK (kind = 'model'),
  adapter       TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name  TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model         TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_one_enabled
ON provider_profile(kind)
WHERE enabled = 1;

-- keys 0.4.3 (v0.17.0): released DDL, with catalog interpolations expanded.
CREATE TABLE IF NOT EXISTS provider_profile (
  profile_ref   TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('ant-ling', 'baseten', 'cerebras', 'deepseek', 'groq', 'huggingface', 'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn', 'together', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn', 'anthropic', 'fireworks', 'kimi-coding', 'minimax', 'minimax-cn', 'vercel-ai-gateway', 'custom')),
  kind          TEXT NOT NULL CHECK (kind = 'model'),
  adapter       TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name  TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model         TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_one_enabled
ON provider_profile(kind)
WHERE enabled = 1;

-- keys 0.7.0 (v0.22.0): released DDL, with catalog interpolations expanded.
CREATE TABLE IF NOT EXISTS provider_profile (
  profile_ref   TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('ant-ling', 'baseten', 'cerebras', 'deepseek', 'groq', 'huggingface', 'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn', 'together', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn', 'anthropic', 'fireworks', 'kimi-coding', 'minimax', 'minimax-cn', 'vercel-ai-gateway', 'custom')),
  kind          TEXT NOT NULL CHECK (kind = 'model'),
  adapter       TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name  TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model         TEXT NOT NULL,
  pi_model      TEXT,
  capabilities  TEXT NOT NULL,
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_one_enabled
ON provider_profile(kind)
WHERE enabled = 1;
