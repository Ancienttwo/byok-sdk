/**
 * P06 — extension-provided tool bridge on the official release.
 *
 * P01 mounts a tool through `customTools`. BYOK's real tool path is different:
 * the MCP bridge registers tools from an extension
 * (`packages/client/src/adapters/pi/mcp-extension.ts:111` calls
 * `pi.registerTool`). This probe proves that path on the official runtime, so
 * OP3's tool migration is not blocked on the prepared-input seams.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, probeProviderConfig, recordResult } from '../lib/harness.mjs';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p06-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI({
  script: (record, index) => {
    const messages = Array.isArray(record.body?.messages) ? record.body.messages : [];
    const hasToolResult = messages.some((message) => message.role === 'tool');
    if (!hasToolResult && index === 0) {
      return { kind: 'tool_call', name: 'probe_bridge', args: { text: 'ping' }, id: 'call_bridge_1' };
    }
    return { kind: 'text', text: `pong:${index}` };
  },
});

try {
  const loadedFactories = [];
  const bridgeFactory = (pi) => {
    loadedFactories.push('bridge');
    pi.registerTool(defineTool({
      name: 'probe_bridge',
      label: 'Probe Bridge',
      description: 'Stands in for an MCP-backed tool registered by an extension.',
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: 'text', text: `bridge:${params.text}` }],
      }),
    }));
  };

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [bridgeFactory],
    },
  });
  const extensionPaths = services.resourceLoader.getExtensions().extensions.map((entry) => entry.path);
  checks.check('only the authorized inline extension is loaded', extensionPaths.length === 1 && extensionPaths[0].startsWith('<inline:'), JSON.stringify(extensionPaths));
  checks.check('the extension factory ran', loadedFactories.length === 1, JSON.stringify(loadedFactories));

  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({ baseUrl: server.baseUrl }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const model = services.modelRuntime.getModel('byok-probe', 'probe-model');

  const sessionManager = SessionManager.create(cwd, path.join(root, 'sessions'));
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    tools: ['probe_bridge'],
  });
  await created.session.prompt('probe: use the bridge');

  const first = server.requests[0]?.body;
  const wireTools = (first?.tools ?? []).map((tool) => tool?.function?.name);
  checks.check('extension-registered tool reaches the wire', wireTools.length === 1 && wireTools[0] === 'probe_bridge', JSON.stringify(wireTools));
  checks.check('tool round trip produced two requests', server.requestCount() === 2, `count=${server.requestCount()}`);
  checks.check('extension tool executed and its result returned', JSON.stringify(server.requests[1]?.body ?? {}).includes('bridge:ping'), 'expected bridge:ping in the follow-up request');

  await created.session.dispose();
  await server.close();

  const supported = checks.allOk();
  recordResult('p06-extension-tool-bridge', {
    ok: supported,
    verdict: supported ? 'supported' : 'not-supported',
    verdictReason: supported
      ? 'a tool registered by an inline extension is exposed on the wire, executed, and its result returns to the model — the mechanism the MCP bridge depends on'
      : 'the extension tool path does not round-trip on the official release; see checks',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      extensionPaths,
      wireTools,
      requestCount: server.requestCount(),
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p06-extension-tool-bridge', {
    ok: false,
    verdict: 'none',
    verdictReason: 'probe could not complete',
    environment: environmentFacts(),
    checks: checks.checks,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
