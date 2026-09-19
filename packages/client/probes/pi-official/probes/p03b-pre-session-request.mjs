/**
 * P03b — how much of "task-free preparation" is reachable today?
 *
 * P03 showed there is no prepared-input entry. This probe splits the capability
 * into its two halves and measures each one, because the split decides the size
 * of the upstream request:
 *
 *   1. REPRODUCIBILITY — can a caller obtain the same request body the session
 *      would send, without a session, using only published provider entries?
 *   2. CERTIFICATION — does that path also tell the caller what the compiler can
 *      prove about the request, which is what budget coverage needs?
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

const SYSTEM_MARKER = 'SYSTEM_MARKER_P03B';
const USER_TEXT = 'probe: hello';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p03b-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI({ script: () => ({ kind: 'text', text: 'pong' }) });
const model = probeProviderConfig({ baseUrl: server.baseUrl }).models[0];

try {
  // ---- Half 1a: the session's own request, with a caller-fixed system prompt.
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: {
      systemPrompt: SYSTEM_MARKER,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({ baseUrl: server.baseUrl }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const sessionModel = services.modelRuntime.getModel('byok-probe', 'probe-model');
  const sessionManager = SessionManager.create(cwd, path.join(root, 'sessions'));
  const created = await createAgentSessionFromServices({ services, sessionManager, model: sessionModel, tools: [] });
  await created.session.prompt(USER_TEXT);
  await created.session.dispose();

  const sessionBody = server.requests[0]?.body;
  const sessionMessages = sessionBody?.messages ?? [];

  // ---- Half 1b: the same request, built with no session at all.
  const sessionUser = sessionMessages.find((message) => message.role === 'user');
  let payload;
  let transportBody;
  let transportError;
  const stream = officialStreamSimple(
    model,
    {
      systemPrompt: SYSTEM_MARKER,
      messages: sessionUser ? [sessionUser] : [{ role: 'user', content: USER_TEXT }],
      tools: [],
    },
    {
      apiKey: 'synthetic-probe-key',
      onPayload: (value) => {
        payload = value;
        return undefined;
      },
      fetch: async (_input, init) => {
        transportBody = typeof init?.body === 'string' ? init.body : undefined;
        const error = new Error('byok-probe: refused before send');
        transportError = error.message;
        throw error;
      },
    },
  );
  await stream.result().catch((error) => {
    transportError = error instanceof Error ? error.message : String(error);
  });

  checks.check('pre-session call delivers the request body to the caller', payload !== undefined, `payload=${payload === undefined ? 'none' : typeof payload}`);
  checks.check('pre-session call reaches transport without a session', transportBody !== undefined, `body=${transportBody === undefined ? 'none' : transportBody.length}`);
  checks.check('pre-session refusal keeps the endpoint at zero requests', server.requestCount() === 1, `count=${server.requestCount()} (1 = the session call only)`);

  const payloadKeys = Object.keys(payload ?? {}).sort();
  const sessionKeys = Object.keys(sessionBody ?? {}).sort();
  checks.check('pre-session payload has the same top-level shape as the session body', JSON.stringify(payloadKeys) === JSON.stringify(sessionKeys), `pre=${JSON.stringify(payloadKeys)} session=${JSON.stringify(sessionKeys)}`);

  const payloadUser = (payload?.messages ?? []).find((message) => message.role === 'user');
  const sameUserBytes = JSON.stringify(payloadUser ?? null) === JSON.stringify(sessionUser ?? null);
  checks.check('pre-session user message is byte-identical to the session one', sameUserBytes, `pre=${JSON.stringify(payloadUser ?? null).slice(0, 120)} session=${JSON.stringify(sessionUser ?? null).slice(0, 120)}`);

  const sameSystem = JSON.stringify(payload?.messages?.[0] ?? null) === JSON.stringify(sessionMessages[0] ?? null);
  checks.check('first message (system) matches the session projection', sameSystem, `pre=${JSON.stringify(payload?.messages?.[0] ?? null).slice(0, 140)} session=${JSON.stringify(sessionMessages[0] ?? null).slice(0, 140)}`);

  // ---- Half 2: certification.
  const certificationFields = Object.keys(payload ?? {}).filter((key) => /certif|project|residual|coverage|proof|digest/i.test(key));
  checks.check('no certification accompanies the payload', certificationFields.length === 0, JSON.stringify(certificationFields));

  const reproducible = checks.checks
    .filter((entry) => /pre-session call|same top-level shape|byte-identical|first message/.test(entry.name))
    .every((entry) => entry.ok);

  await server.close();

  recordResult('p03b-pre-session-request', {
    ok: checks.allOk(),
    verdict: reproducible ? 'partial' : 'not-supported',
    verdictReason: reproducible
      ? 'the request body is reproducible pre-session through published provider entries, but the path attaches no certification of what the compiler proves about it, and nothing ties that body to the session that will consume it'
      : 'a pre-session call does not reproduce the session request; the compile seam needs upstream work as well',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      payloadKeys,
      sessionKeys,
      payloadBytes: payload === undefined ? 0 : JSON.stringify(payload).length,
      sessionBodyBytes: (server.requests[0]?.bodyText ?? '').length,
      transportBodyEqualsPayload: transportBody !== undefined && transportBody === JSON.stringify(payload),
      transportError: transportError ?? null,
      systemMessagePresent: sessionMessages[0]?.role,
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p03b-pre-session-request', {
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
