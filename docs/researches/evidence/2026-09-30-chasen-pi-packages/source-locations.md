# Published-source evidence

Snapshot: 2026-09-30. These are selected source locations, not runtime acceptance. Exact tarballs and integrity are in npm-inventory.json.

## pi-subagents@0.73.1

- `src/agents/runtime-agent-registry.js:44`: `if (typeof pi.on !== "function" || typeof pi.registerTool !== "function")`
- `src/extension/fanout-child.js:219`: `pi.registerTool(tool);`
- `src/extension/fanout-child.js:227`: `pi.on("session_start", (_event, ctx) => {`
- `src/extension/fanout-child.js:228`: `supervisorChannel.registerTools();`
- `src/extension/herdr-pi-bridge.js:94`: `pi.registerTool({`
- `src/extension/herdr-pi-bridge.js:133`: `api.sendUserMessage(request.text ?? "");`
- `src/extension/herdr-pi-bridge.js:136`: `api.sendUserMessage(request.text ?? "", { deliverAs: "steer" });`
- `src/extension/index.js:777`: `pi.registerTool(tool);`
- `src/extension/index.js:778`: `pi.on("before_agent_start", async (event, ctx) => {`
- `src/extension/index.js:791`: `pi.on("agent_end", async (_event, ctx) => {`
- `src/extension/tool-activation.js:13`: `if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function")`
- `src/extension/tool-activation.js:95`: `pi.setActiveTools([...new Set(next)]);`
- `src/extension/tool-activation.js:168`: `pi.registerTool(loader);`

## pi-skillful@0.4.0

- `extensions/index.ts:4`: `import { reportInstallTelemetry } from "../src/install-telemetry.js";`
- `extensions/index.ts:9`: `reportInstallTelemetry();`
- `src/extensions/inline-skill-invocation.ts:7`: `pi.on("input", async (event, ctx) => {`
- `src/extensions/progressive-skills.ts:15`: `pi.on("resources_discover", async (event) => {`
- `src/extensions/session-skill-toggles.ts:58`: `pi.on("session_start", async (event, ctx) => {`
- `src/extensions/session-skill-toggles.ts:90`: `pi.on("before_agent_start", (event) => {`
- `src/extensions/session-skill-toggles.ts:102`: `pi.on("session_shutdown", (event, ctx) => {`
- `src/extensions/skill-visibility.ts:85`: `pi.on("session_start", async (_event, ctx) => {`
- `src/extensions/skill-visibility.ts:90`: `pi.on("before_agent_start", async (event, ctx) => {`
- `src/extensions/skill-visibility.ts:104`: `pi.registerCommand("skillful", {`
- `src/index.ts:1`: `export { reportInstallTelemetry } from "./install-telemetry.js";`
- `src/install-telemetry.ts:8`: `const INSTALL_TELEMETRY_URL = "https://mocito.dev/api/report-install";`
- `src/install-telemetry.ts:79`: `async function reportInstallTelemetryAsync(): Promise<void> {`
- `src/install-telemetry.ts:93`: `await fetch(${INSTALL_TELEMETRY_URL}?${params.toString()}, {`

## @eko24ive/pi-ask@1.2.0

- `src/answer-commands.ts:46`: `pi.registerCommand("answer", {`
- `src/answer-commands.ts:52`: `pi.registerCommand("answer:again", {`
- `src/answer-commands.ts:65`: `pi.registerCommand("ask:replay", {`
- `src/ask-settings-command.ts:8`: `pi.registerCommand("ask-settings", {`
- `src/ask-tool.ts:27`: `pi.registerTool({`
- `src/ask-tool.ts:72`: `if (ctx.mode !== "tui") {`
- `src/index.ts:21`: `pi.on("before_agent_start", async (event) => ({`
- `src/index.ts:25`: `pi.on("session_shutdown", () => {`
- `src/resume-pending-ask.ts:29`: `pi.on("session_start", (event, ctx) => {`
- `src/resume-pending-ask.ts:30`: `if (reopening || ctx.mode !== "tui" || !REOPEN_REASONS.has(event.reason)) {`
- `src/resume-pending-ask.ts:56`: `pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">,`
- `src/ui/controller.ts:116`: `if (ctx.mode !== "tui") {`

## pi-simplify@0.2.3

- `dist/index.js:3`: `pi.registerCommand(COMMAND_NAME, {`
- `dist/simplify-command.js:30`: `pi.sendUserMessage(prompt, { deliverAs: "followUp" });`
- `src/index.ts:8`: `pi.registerCommand(COMMAND_NAME, {`
- `src/simplify-command.ts:47`: `pi.sendUserMessage(prompt, { deliverAs: "followUp" });`

## @zigai/pi-mention-skill@0.10.4

- `src/index.ts:26`: `pi.on("session_start", (_event, ctx) => {`

## @tavily/pi-extension@0.1.2

- `index.ts:202`: `return process.env.TAVILY_API_KEY?.trim();`
- `index.ts:209`: `"Missing TAVILY_API_KEY. Set TAVILY_API_KEY before using Tavily Pi tools.",`
- `index.ts:233`: `: ctx.ui.theme.fg("warning", "Tavily: missing TAVILY_API_KEY"),`

## @narumitw/pi-goal@0.54.8

- `dist/chunks/chunk-7FMBWODN.ts:906`: `this.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });`
- `dist/chunks/chunk-7FMBWODN.ts:1810`: `await pi.sendUserMessage(prompt, { deliverAs: "followUp" });`
- `dist/chunks/menu-7W5HGHFO.ts:73`: `if (ctx.mode !== "tui") {`
- `dist/chunks/settings-ui-T77VFPTK.ts:16`: `if (ctx.mode !== "tui") {`
- `dist/index.ts:68`: `pi.registerCommand("goal", {`
- `dist/index.ts:587`: `pi.on("session_start", async (_event, ctx) => {`
- `dist/index.ts:669`: `pi.on("session_shutdown", (_event, ctx) => {`
- `src/command-registration.ts:25`: `pi.registerCommand("goal", {`
- `src/lifecycle.ts:53`: `pi.on("session_start", async (_event, ctx) => {`
- `src/lifecycle.ts:146`: `pi.on("session_shutdown", (_event, ctx) => {`
- `src/lifecycle.ts:175`: `pi.on("session_before_compact", (event, ctx) => {`
- `src/menu.ts:133`: `if (ctx.mode !== "tui") {`

## pi-context-usage@2.1.0

- `src/context/index.ts:614`: `pi.on("before_agent_start", (event) => {`
- `src/context/index.ts:617`: `pi.on("context_with_system", (event) => {`
- `src/context/index.ts:626`: `pi.registerCommand("context", {`

## @narumitw/pi-btw@0.61.1

- `dist/index.ts:785`: `completeSimple,`
- `dist/index.ts:790`: `const response = await completeSimple(`
- `dist/index.ts:796`: `completeSimple.appliesRequestHeaderTransforms === true`
- `src/btw.ts:83`: `const completeSimple: CompleteSimpleFunction = async (model, context, options) =>`
- `src/btw.ts:85`: `completeSimple.appliesRequestHeaderTransforms = true;`
- `src/btw.ts:86`: `return completeSimple;`
- `src/main-thread-updates.ts:14`: `pi.on("session_info_changed", (_event, ctx) => notify(ctx));`
- `src/main-thread-updates.ts:15`: `pi.on("session_compact", (_event, ctx) => notify(ctx));`
- `src/main-thread-updates.ts:16`: `pi.on("session_tree", (_event, ctx) => notify(ctx));`
- `src/menu.ts:94`: `if (ctx.mode !== "tui") return "closed";`
- `src/side-thread.ts:87`: `completeSimple: CompleteSimpleFunction;`
- `src/side-thread.ts:103`: `completeSimple,`
- `src/side-thread.ts:108`: `const response = await completeSimple(`

## @ff-labs/pi-fff@0.11.0

- `src/aux-finders.ts:19`: `followSymlinks?: boolean;`
- `src/aux-finders.ts:108`: `followSymlinks: this.opts.followSymlinks,`
- `src/config.ts:18`: `followSymlinks?: boolean;`
- `src/config.ts:29`: `"followSymlinks",`
- `src/config.ts:72`: `validateBoolean(configPath, parsed, "followSymlinks");`
- `src/file-picker.ts:8`: `followSymlinks?: boolean;`
- `src/index.ts:359`: `let followSymlinks = true;`
- `src/index.ts:411`: `followSymlinks = getConfigValue(`
- `src/index.ts:414`: `config.followSymlinks,`

