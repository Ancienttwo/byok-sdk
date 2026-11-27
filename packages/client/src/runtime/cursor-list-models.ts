import { client, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { asRecord, asRecordList } from '../../vendor/oar/223703d/shared/json.js';
import { acpThoughtLevelOption } from '../../vendor/oar/223703d/shared/acp/model.js';
import { startAcpProcess, withAcpDeadline } from '../../vendor/oar/223703d/shared/acp/process.js';
import { cursorAuthFailure } from '../adapters/cursor/cursor-policy.js';
import { CURSOR_ACP_ARGS, CURSOR_ACP_CLIENT_META } from './cursor-acp-profile.js';
import type { ModelReader } from './oar-reader-contract.js';
import type { RuntimeModelEntry } from './runtime-reader-types.js';

const LIST_MODELS = 'cursor/list_available_models';

function modelEntry(model: Readonly<Record<string, unknown>>): RuntimeModelEntry[] {
  const id = model.value;
  if (typeof id !== 'string' || !id.trim()) return [];
  const displayName = typeof model.name === 'string' && model.name.trim() && model.name !== id ? model.name : undefined;
  const effort = acpThoughtLevelOption({ configOptions: model.configOptions });
  const effortLevels = asRecordList(effort?.options).flatMap(option => typeof option.value === 'string' && option.value.trim() ? [option.value] : []);
  const defaultEffort = typeof effort?.currentValue === 'string' && effortLevels.includes(effort.currentValue) ? effort.currentValue : undefined;
  return [{ id, ...(displayName === undefined ? {} : { displayName }),
    ...(effortLevels.length === 0 ? {} : { effortLevels }), ...(defaultEffort === undefined ? {} : { defaultEffort }) }];
}

export const cursorListModels: ModelReader = async (installation, reader) => {
  // The reader owns and awaits process-tree disposal on success, failure and cancellation.
  const runtime = startAcpProcess(reader.spawn, installation.command, CURSOR_ACP_ARGS, client({ name: 'byok' }), {
    env: reader.env, redact: reader.redact,
  });
  try {
    const initialize = methods.agent.initialize;
    await withAcpDeadline(runtime, initialize, reader.timeoutMs, options => runtime.connection.agent.request(initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: CURSOR_ACP_CLIENT_META },
    }, options));
    const result = await withAcpDeadline(runtime, LIST_MODELS, reader.timeoutMs,
      options => runtime.connection.agent.request(LIST_MODELS, {}, options));
    return { kind: 'ok', models: asRecordList(asRecord(result)?.models).flatMap(modelEntry) };
  } catch (error) {
    if (error instanceof RequestError && error.code === -32_000) throw cursorAuthFailure();
    if (error instanceof RequestError && error.code === -32_601) return { kind: 'unsupported', reason: 'Cursor ACP model catalog unavailable' };
    throw error;
  }
};
