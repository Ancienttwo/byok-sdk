#!/usr/bin/env node
/** Generate the initial v8 corpus from the frozen v7 evidence. */
import { readFileSync, writeFileSync } from 'node:fs';

const golden = name => new URL(`./golden/${name}`, import.meta.url);
const readLines = name => readFileSync(golden(name), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const writeLines = (name, rows) => writeFileSync(golden(name), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

const selectionFor = {
  runtime: () => ({ mode: 'device-default' }),
  harness: ({ modelId }) => modelId === undefined ? { mode: 'device-default' } : { mode: 'adapter-model', modelId },
  subscription: ({ modelId }) => ({ mode: 'subscription', modelId }),
  byok: ({ modelId }) => ({ mode: 'byok', providerId: 'google', modelId }),
  'byok-profile': ({ providerProfile: { modelId, ...providerProfile } }) => ({ mode: 'byok-profile', providerProfile, modelId }),
};

function selectionModes(id) {
  if (id === 'pi') return ['byok-profile'];
  if (id === 'claude' || id === 'codex') return ['device-default', 'subscription'];
  return ['device-default', 'adapter-model'];
}

function inventory({ runtimes = [], harnesses = [] }) {
  return [...runtimes, ...harnesses].map(({ id, capabilities, ...facts }) => ({
    id, ...facts,
    capabilities: {
      ...capabilities,
      selectionModes: selectionModes(id),
      ...(id === 'pi' ? { defaultModelModes: ['byok-profile'] } : {}),
      effort: true,
    },
  }));
}

function hello({ runtimes, harnesses, ...payload }) {
  return {
    ...payload,
    protocolVersions: payload.protocolVersions.map(version => version === 7 ? 8 : version),
    capabilities: payload.capabilities.filter(flag => flag !== 'dispatch-selection' && flag !== 'task-execution-options'),
    harnesses: [...inventory({ runtimes, harnesses }), {
      id: 'agy', capabilities: { selectionModes: ['byok'], byokProviderId: 'google', effort: true },
    }],
  };
}

function envelope(previous) {
  const next = { ...previous, v: 8, payload: { ...previous.payload } };
  if (next.type === 'conn.hello') next.payload = hello(next.payload);
  if (next.type === 'task.offer' && next.payload.target?.lane !== 'auto') {
    const target = next.payload.target;
    next.payload.target = {
      lane: 'harness', harnessId: target.lane === 'byok' ? 'agy' : target.harnessId ?? target.runtimeId,
      selection: selectionFor[target.lane](target), ...(target.effort === undefined ? {} : { effort: target.effort }),
    };
  }
  if (next.payload.executor !== undefined) {
    next.payload.executor = { id: next.payload.executor.harnessId ?? next.payload.executor.runtimeId };
  }
  return next;
}

function httpValue(surface, input) {
  if (surface === 'PresencePublishRequest') {
    const { runtimes, ...payload } = input;
    return {
      ...payload,
      ...(payload.protocolVersions === undefined ? {} : { protocolVersions: payload.protocolVersions.map(v => v === 7 ? 8 : v) }),
      ...(runtimes === undefined ? {} : { harnesses: [...inventory({ runtimes }), {
        id: 'grok', capabilities: { selectionModes: ['device-default', 'adapter-model'], effort: true },
      }, {
        id: 'agy', capabilities: { selectionModes: ['byok'], byokProviderId: 'google', effort: true },
      }] }),
    };
  }
  if (surface === 'MessagesSendRequest') {
    return { ...input, messages: input.messages.map(envelope) };
  }
  if (surface === 'EventsPollResponse') {
    return { ...input, events: input.events.map(envelope) };
  }
  return input;
}

const modelHarnesses = [
  { id: 'pi', capabilities: { selectionModes: ['device-default', 'adapter-model', 'byok-profile'], defaultModelModes: ['byok-profile'], effort: true } },
  { id: 'opencode', capabilities: { selectionModes: ['adapter-model'], effort: true } },
  { id: 'grok', capabilities: { selectionModes: ['device-default', 'adapter-model'], defaultModelModes: ['adapter-model'], effort: true } },
  { id: 'dsh', capabilities: { selectionModes: ['byok'], byokProviderId: 'deepseek', defaultModelModes: ['byok'], effort: true } },
];
const modelDefaultsHello = {
  v: 8, id: '00000000-0000-4000-8000-000000004101', ts: '2026-11-19T00:00:00.000Z', type: 'conn.hello',
  payload: { deviceId: 'device-model-defaults', productId: 'acme-agent', protocolVersions: [8], capabilities: [], harnesses: modelHarnesses },
};
const modelDefaultsOffer = {
  v: 8, id: '00000000-0000-4000-8000-000000004102', ts: '2026-11-19T00:00:01.000Z', type: 'task.offer',
  task_id: 'task-model-defaults', seq: 7,
  payload: { instruction: 'Continue Agent work', agentRef: { agentId: 'agent-golden-1', profileRevision: 'profile-r7' },
    target: { lane: 'harness', harnessId: 'dsh', selection: { mode: 'byok', providerId: 'deepseek' } },
    session: { mode: 'resume', sessionRef: 'sess-golden-agent' } },
};
const modelDeclines = ['invalid_request', 'model_unavailable'].map((code, index) => ({
  v: 8, id: `00000000-0000-4000-8000-00000000410${index + 3}`, ts: '2026-11-19T00:00:02.000Z', type: 'task.decline',
  task_id: `task-model-decline-${index}`, payload: { code, reason: code, retryable: false },
}));
const modelDefaultsPresence = { level: 'online', protocolVersions: [8], harnesses: modelHarnesses };
const v8Envelopes = readLines('v7.envelopes.ndjson').map(envelope);
// The decline code stays in plaintext and is outside the sealed binding.
const sealedDecline = v8Envelopes.find(row => row.type === 'task.decline' && row.payload.sealed !== undefined);
const sealedModelDeclines = modelDeclines.map((row, index) => ({
  ...sealedDecline, id: `00000000-0000-4000-8000-00000000410${index + 5}`,
  payload: { ...sealedDecline.payload, code: row.payload.code, retryable: false },
}));

const profileDefaultOffer = {
  ...modelDefaultsOffer, id: '00000000-0000-4000-8000-000000004107', task_id: 'task-profile-default',
  payload: { ...modelDefaultsOffer.payload, target: { lane: 'harness', harnessId: 'pi', selection: {
    mode: 'byok-profile', providerProfile: { profileRef: 'local', profileRevision: '1',
      profileHash: `sha256:${'c'.repeat(64)}`, requiredCapabilities: [] },
  } } },
};

writeLines('v8.envelopes.ndjson', [...v8Envelopes, modelDefaultsHello, modelDefaultsOffer, ...modelDeclines, ...sealedModelDeclines, profileDefaultOffer]);
writeLines('v8.http.ndjson', [...readLines('v7.http.ndjson').map(line => ({
  ...line, body: JSON.stringify(httpValue(line.surface, JSON.parse(line.body))), value: httpValue(line.surface, line.value),
})), { surface: 'PresencePublishRequest', body: JSON.stringify(modelDefaultsPresence), value: modelDefaultsPresence }]);
