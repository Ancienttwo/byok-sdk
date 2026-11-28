import type { SupervisedHostState } from "../../../src/bridge/protocol.ts";

/** Joins truthy class strings cleanly without emitting `undefined` or extra spaces. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

export type HostStateKey = SupervisedHostState["state"];

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "hostStarting"
  | "hostRunning"
  | "hostRestarting"
  | "hostStopped"
  | "hostFailed";

export interface HostStateMeta {
  readonly badgeVariant: BadgeVariant;
  readonly symbol: string;

}

/** Semantic + non-color presentation metadata for every Host lifecycle state. */
export const HOST_STATE_META: Readonly<Record<HostStateKey, HostStateMeta>> = {
  starting: { badgeVariant: "hostStarting", symbol: "◐" },
  running: { badgeVariant: "hostRunning", symbol: "●" },
  restarting: { badgeVariant: "hostRestarting", symbol: "↻" },
  stopped: { badgeVariant: "hostStopped", symbol: "■" },
  failed: { badgeVariant: "hostFailed", symbol: "▲" },
};

/** Focus-visible ring shared across interactive controls. */
export const FOCUS_RING_CLASS =
  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

/** Shared elevated surface chrome for Popover, Menu, and Tooltip. */
export const POPOVER_SURFACE_CLASS =
  "rounded-(--radius) border border-border bg-popover text-popover-foreground";
