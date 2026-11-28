import { t } from "../../i18n.ts";
import type { RuntimeView } from "../../../../src/host/settings/types.ts";
import type { BadgeVariant } from "../../ui/tokens.ts";

/**
 * Shared runtime status vocabulary for Agents settings, first run, Bot editor, sidebar, and failure cards.
 * Note: "sign-in held (Grok)" (`grok_login_preserved`) is intentionally omitted because it is emitted as a
 * daemon retention-failure event rather than a `RuntimeObservation` refusal (#2543).
 */
export type RuntimeStatusKey =
  | "signed-in"
  | "signed-out"
  | "not-checked"
  | "check-timed-out"
  | "untested-version"
  | "version-blocked"
  | "not-installed"
  | "cant-run"
  | "rejected-during-turn";

export interface RuntimeStatusMeta {
  readonly key: RuntimeStatusKey;
  readonly variant: BadgeVariant;
  readonly symbol: string;
  readonly label: string;
}

const RUNTIME_STATUS_META: Readonly<Record<RuntimeStatusKey, Omit<RuntimeStatusMeta, "label">>> = {
  "signed-in": { key: "signed-in", variant: "success", symbol: "✓" },
  "signed-out": { key: "signed-out", variant: "warning", symbol: "○" },
  "not-checked": { key: "not-checked", variant: "neutral", symbol: "?" },
  "check-timed-out": { key: "check-timed-out", variant: "warning", symbol: "◷" },
  "untested-version": { key: "untested-version", variant: "warning", symbol: "!" },
  "version-blocked": { key: "version-blocked", variant: "danger", symbol: "✕" },
  "not-installed": { key: "not-installed", variant: "neutral", symbol: "–" },
  "cant-run": { key: "cant-run", variant: "danger", symbol: "✕" },
  "rejected-during-turn": {
    key: "rejected-during-turn",
    variant: "danger",
    symbol: "!",

  },
};

export interface RuntimeStatusOptions {
  /** Set when the runtime rejected credentials (`unauthorized`) while running a turn. */
  readonly rejectedDuringTurn?: boolean;
}

/** Returns the presentation metadata for an explicit status key (for example failure cards). */
export function runtimeStatusMeta(key: RuntimeStatusKey): RuntimeStatusMeta {
  return { ...RUNTIME_STATUS_META[key], label: t(`runtime.${key}`) };
}

/**
 * Projects one `RuntimeView` (and optional live turn rejection) onto the single shared status vocabulary.
 * Unmeasured fields are never guessed: `authPresent === undefined` maps to `not-checked` unless a stricter
 * state applies, and `outcome === 'timeout'` stays distinct from `signed-out`.
 */
export function runtimeStatus(
  runtime: Pick<RuntimeView, "outcome" | "verdict" | "authPresent">,
  options?: RuntimeStatusOptions,
): RuntimeStatusMeta {
  if (runtime.outcome === "not-found") return runtimeStatusMeta("not-installed");
  if (runtime.outcome === "timeout") return runtimeStatusMeta("check-timed-out");
  if (runtime.outcome !== "available") return runtimeStatusMeta("cant-run");
  if (runtime.verdict === "block") return runtimeStatusMeta("version-blocked");
  if (options?.rejectedDuringTurn === true) return runtimeStatusMeta("rejected-during-turn");
  if (runtime.authPresent === false) return runtimeStatusMeta("signed-out");
  if (runtime.verdict === "warn") return runtimeStatusMeta("untested-version");
  if (runtime.authPresent === true) return runtimeStatusMeta("signed-in");
  return runtimeStatusMeta("not-checked");
}

export type RuntimeSignInGuidance =
  | { readonly kind: "command"; readonly command: string; readonly note: string }
  | { readonly kind: "byok"; readonly note: string }
  | { readonly kind: "cli-unknown"; readonly note: string };

const SIGN_IN_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude auth login",
  codex: "codex login",
};

/** Per-runtime sign-in guidance. Only Claude Code and Codex expose known terminal login commands. */
export function runtimeSignInGuidance(runtimeId: string): RuntimeSignInGuidance {
  if (runtimeId === "pi") {
    return { kind: "byok", note: t("runtime.signInKeys") };
  }
  const command = SIGN_IN_COMMANDS[runtimeId];
  if (command !== undefined) {
    return {
      kind: "command",
      command,
      note: t("runtime.signInCommand"),
    };
  }
  return { kind: "cli-unknown", note: t("runtime.signInUnknown") };
}

const RUNTIME_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  grok: "Grok",
  agy: "Antigravity",
  opencode: "OpenCode",
  dsh: "dsh",
};

/** Human-readable display label for known runtime ids, falling back to the raw id. */
export function runtimeDisplayName(runtimeId: string): string {
  return RUNTIME_DISPLAY_NAMES[runtimeId] ?? runtimeId;
}

const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  app_server_unavailable: "runtime.refusal.app_server_unavailable",
  acp_unavailable: "runtime.refusal.acp_unavailable",
  platform_unsupported: "runtime.refusal.platform_unsupported",
  runtime_environment_unavailable: "runtime.refusal.runtime_environment_unavailable",
  agent_user_context_unavailable: "runtime.refusal.agent_user_context_unavailable",
};

export function runtimeOutcomeText(runtime: Pick<RuntimeView, "outcome" | "reason">): string {
  const reason = runtime.reason;
  if (runtime.outcome === "refused" && reason !== undefined && Object.hasOwn(REFUSAL_KEYS, reason)) {
    return t(REFUSAL_KEYS[reason]!);
  }
  return t(`runtime.outcome.${runtime.outcome}`);
}
