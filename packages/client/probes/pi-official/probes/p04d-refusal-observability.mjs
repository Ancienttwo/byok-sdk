/**
 * P04d — is a refusal observable when the session swallows it?
 *
 * P04 showed that a caller-owned transport can refuse before send but that the
 * failure neither propagates nor stops the session from reporting a normal end.
 * The question that decides the upstream request is narrower: can the component
 * that OWNS the run (the daemon) still learn, reliably, that nothing was sent?
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { streamSimple as officialStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, probeProviderConfig, recordResult } from '../lib/harness.mjs';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p04d-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI({ script: () => ({ kind: 'text', text: 'pong' }) });

try {
  // This array is the caller's own side channel: the daemon owns it, and no
  // session code can reach it.
  const refusals = [];
  const attempts = [];
  const events = [];

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({
    baseUrl: server.baseUrl,
    streamSimple: (model, context, options) => officialStreamSimple(model, context, {
      ...options,
      fetch: async (input, init) => {
        attempts.push(typeof init?.body === 'string' ? init.body.length : 0);
        const error = new Error('byok-probe: refused before send');
        refusals.push({ reason: error.message, attempt: attempts.length });
        throw error;
      },
    }),
  }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const model = services.modelRuntime.getModel('byok-probe', 'probe-model');
  const sessionManager = SessionManager.create(cwd, path.join(root, 'sessions'));
  const created = await createAgentSessionFromServices({ services, sessionManager, model, tools: [] });
  created.session.subscribe((event) => events.push({ type: event?.type }));

  let promptError;
  try {
    await created.session.prompt('probe: refusal observability');
  } catch (error) {
    promptError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const finalAssistant = sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => entry.message?.stopReason ?? 'none');
  await created.session.dispose();
  await server.close();

  checks.check('the caller-owned side channel recorded the refusal', refusals.length > 0, `refusals=${refusals.length}`);
  checks.check('the endpoint received zero requests', server.requestCount() === 0, `count=${server.requestCount()}`);
  checks.check('refusals are attributable to numbered attempts', refusals.every((entry, index) => entry.attempt === index + 1), JSON.stringify(refusals.map((entry) => entry.attempt)));
  checks.check('the session did not surface the refusal as an error', promptError === undefined, promptError ?? 'no error surfaced (recorded, not asserted as desired)');
  checks.check('the run still ended normally', events.some((event) => event.type === 'agent_settled'), JSON.stringify(events.map((event) => event.type)));
  checks.check('no assistant stop reason explains the absence', finalAssistant.length === 0 || finalAssistant.every((reason) => reason !== 'stop'), JSON.stringify(finalAssistant));

  const observable =
    refusals.length > 0 &&
    server.requestCount() === 0 &&
    events.some((event) => event.type === 'agent_settled');

  recordResult('p04d-refusal-observability', {
    ok: checks.allOk(),
    verdict: observable ? 'supported' : 'not-supported',
    verdictReason: observable
      ? 'the run owner can learn out-of-band that the transport refused and that zero requests were sent, even though the session reports a normal end; propagation through the session error channel is still absent'
      : 'a refused send cannot be attributed by the run owner; see checks',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      refusalCount: refusals.length,
      transportAttempts: attempts.length,
      endpointRequests: server.requestCount(),
      promptError: promptError ?? null,
      finalAssistantStopReasons: finalAssistant,
      eventTypes: events.map((event) => event.type),
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p04d-refusal-observability', {
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
