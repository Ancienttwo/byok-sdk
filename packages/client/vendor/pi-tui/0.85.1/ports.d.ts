import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Only the rendering port consumed by TodoOverlay; no TUI implementation. */
export interface TodoRenderPort { requestRender(force?: boolean): void; }
export type TodoShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
