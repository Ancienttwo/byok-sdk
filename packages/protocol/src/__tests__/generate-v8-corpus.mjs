#!/usr/bin/env node
/** Generate the initial v8 corpus from the frozen v7 evidence. */
import { readFileSync, writeFileSync } from 'node:fs';

const golden = name => new URL(`./golden/${name}`, import.meta.url);
const readLines = name => readFileSync(golden(name), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const writeLines = (name, rows) => writeFileSync(golden(name), rows.map(row => JSON.stringify(row)).join('\n') + '\n');

const selectionFor = {
  runtime: () => ({ mode: 'device-default' }),
  harness: ({ modelId }) => modelId === undefined ? { mode: 'device-default' } : { mode: 'adapter-model', modelId },
  subscription: ({ modelId }) => ({ mode: 'subscription', modelId }),
  byok: ({ modelId }) => ({ mode: 'byok', providerId: 'google', modelId }),
  'byok-profile': ({ providerProfile }) => ({ mode: 'byok-profile', providerProfile }),
};

function inventory({ runtimes = [], harnesses = [] }) {
  return [...runtimes, ...harnesses].map(({ id, capabilities, ...facts }) => ({
    id, ...facts,
    capabilities: {
      ...capabilities,
      selectionModes: id === 'pi' ? ['byok-profile'] : id === 'claude' || id === 'codex' ? ['device-default', 'subscription'] : ['device-default', 'adapter-model'],
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

writeLines('v8.envelopes.ndjson', readLines('v7.envelopes.ndjson').map(envelope));
writeLines('v8.http.ndjson', readLines('v7.http.ndjson').map(line => ({
  ...line, body: JSON.stringify(httpValue(line.surface, JSON.parse(line.body))), value: httpValue(line.surface, line.value),
})));
