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

export const RUNTIME_STATUS_META: Readonly<Record<RuntimeStatusKey, RuntimeStatusMeta>> = {
  "signed-in": { key: "signed-in", variant: "success", symbol: "✓", label: "signed in" },
  "signed-out": { key: "signed-out", variant: "warning", symbol: "○", label: "signed out" },
  "not-checked": { key: "not-checked", variant: "neutral", symbol: "?", label: "not checked" },
  "check-timed-out": { key: "check-timed-out", variant: "warning", symbol: "◷", label: "check timed out" },
  "untested-version": { key: "untested-version", variant: "warning", symbol: "!", label: "untested version" },
  "version-blocked": { key: "version-blocked", variant: "danger", symbol: "✕", label: "version blocked" },
  "not-installed": { key: "not-installed", variant: "neutral", symbol: "–", label: "not installed" },
  "cant-run": { key: "cant-run", variant: "danger", symbol: "✕", label: "can't run" },
  "rejected-during-turn": {
    key: "rejected-during-turn",
    variant: "danger",
    symbol: "!",
    label: "rejected during a turn",
  },
};

export interface RuntimeStatusOptions {
  /** Set when the runtime rejected credentials (`unauthorized`) while running a turn. */
  readonly rejectedDuringTurn?: boolean;
}

/** Returns the presentation metadata for an explicit status key (for example failure cards). */
export function runtimeStatusMeta(key: RuntimeStatusKey): RuntimeStatusMeta {
  return RUNTIME_STATUS_META[key];
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
  if (runtime.outcome === "not-found") return RUNTIME_STATUS_META["not-installed"];
  if (runtime.outcome === "timeout") return RUNTIME_STATUS_META["check-timed-out"];
  if (runtime.outcome !== "available") return RUNTIME_STATUS_META["cant-run"];
  if (runtime.verdict === "block") return RUNTIME_STATUS_META["version-blocked"];
  if (options?.rejectedDuringTurn === true) return RUNTIME_STATUS_META["rejected-during-turn"];
  if (runtime.authPresent === false) return RUNTIME_STATUS_META["signed-out"];
  if (runtime.verdict === "warn") return RUNTIME_STATUS_META["untested-version"];
  if (runtime.authPresent === true) return RUNTIME_STATUS_META["signed-in"];
  return RUNTIME_STATUS_META["not-checked"];
}

export type RuntimeSignInGuidance =
  | { readonly kind: "command"; readonly command: string; readonly note: string }
  | { readonly kind: "byok"; readonly note: string }
  | { readonly kind: "cli-unknown"; readonly note: string };

const SIGN_IN_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude auth login",
  codex: "codex login",
};

export const UNKNOWN_SIGN_IN_NOTE = "Sign in with the CLI's own command";

/** Per-runtime sign-in guidance. Only Claude Code and Codex expose known terminal login commands. */
export function runtimeSignInGuidance(runtimeId: string): RuntimeSignInGuidance {
  if (runtimeId === "pi") {
    return { kind: "byok", note: "Configure provider keys in the Keys section." };
  }
  const command = SIGN_IN_COMMANDS[runtimeId];
  if (command !== undefined) {
    return {
      kind: "command",
      command,
      note: "Run this command in a terminal, then press Check again.",
    };
  }
  return { kind: "cli-unknown", note: UNKNOWN_SIGN_IN_NOTE };
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
