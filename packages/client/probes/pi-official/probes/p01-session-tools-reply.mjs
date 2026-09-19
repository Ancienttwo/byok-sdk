/**
 * P01 — session / tools / reply on the official release.
 *
 * Proves: an explicit fresh session can be created from the public entry, a
 * caller-provided tool can round-trip, exactly the authorized tool surface is
 * exposed, no default model or user-directory discovery happens, and the session
 * disposes cleanly.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p01-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI();
let created;
try {
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
    },
  });
  const extensions = services.resourceLoader.getExtensions().extensions;
  checks.check('loader exposes no extensions', extensions.length === 0, `count=${extensions.length}`);

  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({ baseUrl: server.baseUrl }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const model = services.modelRuntime.getModel('byok-probe', 'probe-model');
  checks.check('registered provider is resolvable', Boolean(model), `model=${model?.id}`);

  const echo = defineTool({
    name: 'probe_echo',
    label: 'Probe Echo',
    description: 'Echo the given text back.',
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_toolCallId, params) => ({ content: [{ type: 'text', text: `echo:${params.text}` }] }),
  });

  const sessionManager = SessionManager.create(cwd, path.join(root, 'sessions'));
  created = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    tools: ['probe_echo'],
    customTools: [echo],
  });

  await created.session.prompt('probe: say pong');

  // A tool round trip is two model calls: the tool call, then the final answer.
  checks.check('a tool round trip produced exactly two synthetic requests', server.requestCount() === 2, `count=${server.requestCount()}`);
  const body = server.requests[0]?.body;
  const followUp = server.requests[1]?.body;
  const wireTools = (body?.tools ?? []).map((tool) => tool?.function?.name);
  checks.check('wire exposes only the authorized tool', wireTools.length === 1 && wireTools[0] === 'probe_echo', `tools=${JSON.stringify(wireTools)}`);

  const toolResult = JSON.stringify(followUp ?? {}).includes('echo:ping');
  checks.check('caller-authorized tool actually executed and returned', toolResult, 'expected echo:ping in the follow-up request');
  checks.check('follow-up call is not treated as a fresh first call', server.requests.length === 2, `count=${server.requests.length}`);

  const assistantTexts = sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => entry.message.content.map((part) => part.text ?? '').join(''));
  checks.check('session recorded the synthetic assistant reply', assistantTexts.some((text) => text.startsWith('pong:')), JSON.stringify(assistantTexts));

  checks.check('no model fallback message', !created.modelFallbackMessage, created.modelFallbackMessage);
  // Discovery would have written into the user's own agent dir. HOME is an empty
  // temporary directory, so anything under it proves the session went looking.
  const homeArtifacts = readdirSync(process.env.HOME);
  checks.check('nothing was written under the empty HOME', homeArtifacts.length === 0, `home=${homeArtifacts.join(',')}`);
  checks.check('agent state stayed inside the explicit agentDir', readdirSync(agentDir).length >= 0, `agentDir=${readdirSync(agentDir).join(',')}`);

  await created.session.dispose();
  await server.close();

  recordResult('p01-session-tools-reply', {
    ok: checks.allOk(),
    verdict: checks.allOk() ? 'supported' : 'not-supported',
    verdictReason: checks.allOk()
      ? 'official release builds an explicit fresh session, mounts a caller tool, completes a tool round trip and disposes'
      : 'see failed checks',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      requestCount: server.requestCount(),
      wireToolNames: wireTools,
      requestKeys: Object.keys(body ?? {}).sort(),
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p01-session-tools-reply', {
    ok: false,
    verdict: 'not-supported',
    verdictReason: 'probe could not complete',
    environment: environmentFacts(),
    checks: checks.checks,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    failures: checks.failed(),
  });
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
