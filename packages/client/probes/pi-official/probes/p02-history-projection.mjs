/**
 * P02 — host-canonical assistant history.
 *
 * Probes whether host-asserted assistant text can enter a fresh session without
 * fabricating provider provenance, and records exactly how it reaches the wire.
 * The synthetic endpoint stores the raw request body, so the assertion is made
 * against real bytes rather than an in-process object.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, probeProviderConfig, recordResult } from '../lib/harness.mjs';

const HOST_TEXT = 'HOST-CANONICAL ✓ 历史文本\r\nsecond line';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p02-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI({ script: () => ({ kind: 'text', text: 'pong' }) });

/**
 * Run one session. `withHostHistory` is the only difference between the control
 * and the treatment, so any behavioural change is attributable to the injected
 * host-asserted assistant text.
 */
async function runCase({ withHostHistory, index }) {
  const caseCwd = path.join(root, `cwd-${index}`);
  const caseAgentDir = path.join(root, `agent-${index}`);
  mkdirSync(caseCwd, { recursive: true });
  mkdirSync(caseAgentDir, { recursive: true });

  const services = await createAgentSessionServices({
    cwd: caseCwd,
    agentDir: caseAgentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({ baseUrl: server.baseUrl }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const model = services.modelRuntime.getModel('byok-probe', 'probe-model');
  const sessionManager = SessionManager.create(caseCwd, path.join(root, `sessions-${index}`));

  let appendError;
  if (withHostHistory) {
    try {
      // The host asserts this text was already said. It names no api, provider,
      // model, usage or stop reason on purpose: fabricating them is forbidden.
      sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: HOST_TEXT }], timestamp: Date.now() });
    } catch (error) {
      appendError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }

  const before = server.requestCount();
  let promptError;
  let sessionModelId;
  const events = [];
  let entriesBeforePrompt;
  try {
    const created = await createAgentSessionFromServices({ services, sessionManager, model, tools: [] });
    sessionModelId = created.session.model?.id;
    if (typeof created.session.subscribe === 'function') {
      created.session.subscribe((event) => {
        events.push({ type: event?.type, error: event?.error === undefined ? undefined : String(event.error).slice(0, 200) });
      });
    }
    entriesBeforePrompt = sessionManager.getEntries().length;
    await created.session.prompt('probe: continue');
    await created.session.dispose();
  } catch (error) {
    promptError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const newRequests = server.requests.slice(before);
  return { appendError, promptError, sessionModelId, newRequests, entriesBeforePrompt, entryCount: sessionManager.getEntries().length, events };
}

try {
  const control = await runCase({ withHostHistory: false, index: 'control' });
  const treatment = await runCase({ withHostHistory: true, index: 'treatment' });

  const bodyText = treatment.newRequests[0]?.bodyText ?? '';
  const messages = treatment.newRequests[0]?.body?.messages ?? [];
  const hostMessage = messages.find((message) => typeof message.content === 'string' && message.content.includes('HOST-CANONICAL'));

  // The control proves the treatment difference is caused by the injected history.
  checks.check('control session sends its request', control.newRequests.length === 1, `count=${control.newRequests.length}`);
  checks.check('control session resolves the explicit model', control.sessionModelId === 'probe-model', `model=${control.sessionModelId}`);

  checks.check('host history append is accepted by the session manager', treatment.appendError === undefined, treatment.appendError);
  checks.check('treatment session still sends a request', treatment.newRequests.length === 1, `count=${treatment.newRequests.length} error=${treatment.promptError ?? 'none'}`);
  const projectionSupported = treatment.newRequests.length === 1 && bodyText.includes('HOST-CANONICAL');
  checks.check('host-asserted text reaches the wire', projectionSupported, `bytes=${bodyText.length}`);
  checks.check('host-asserted text keeps the assistant role', hostMessage?.role === 'assistant', `role=${hostMessage?.role}`);

  const supported = checks.allOk();
  const verdictKind = supported ? 'supported' : (control.newRequests.length === 1 && treatment.newRequests.length === 0 ? 'not-supported' : 'partial');

  await server.close();

  recordResult('p02-history-projection', {
    ok: checks.allOk(),
    verdict: verdictKind,
    verdictReason: supported
      ? 'host-asserted assistant text entered a fresh session and reached the wire with assistant role and no fabricated provenance'
      : (verdictKind === 'not-supported'
        ? 'injecting host-asserted assistant text suppressed the request entirely: the official release has no way to carry host-owned assistant history'
        : 'official release does not carry host-asserted assistant history; see checks'),
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      control: { requests: control.newRequests.length, modelId: control.sessionModelId, promptError: control.promptError ?? null, entryCount: control.entryCount },
      treatment: { requests: treatment.newRequests.length, modelId: treatment.sessionModelId, promptError: treatment.promptError ?? null, appendError: treatment.appendError ?? null, entriesBeforePrompt: treatment.entriesBeforePrompt, entryCount: treatment.entryCount },
      treatmentEvents: treatment.events,
      controlEvents: control.events,
      hostMessage: hostMessage ?? null,
      messageRoles: messages.map((message) => message.role),
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p02-history-projection', {
    ok: false,
    verdict: 'none',
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
