import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

export default async function registerSubagentExtension(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	(await import("./src/extension/index.ts")).default(pi);
}
