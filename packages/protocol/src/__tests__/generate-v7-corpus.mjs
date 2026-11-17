#!/usr/bin/env node
/**
 * One-shot authoring tool for the wire v7 golden corpora (#1757, #2009).
 *
 * Reads the frozen v6 corpora (`golden/v6.*.ndjson`, byte-identical to the
 * last v6 release), rewrites each line to the v7 contract, appends the lines
 * v7 coverage needs, and writes `golden/v7.envelopes.ndjson`,
 * `golden/v7.http.ndjson` and an empty `golden/v7.releases.json`. The output
 * is a pure function of the v6 bytes: running it twice writes the same bytes.
 *
 * After the first v7 release the v7 corpora are append-only and this script
 * must not be rerun over them; `src/__tests__/compat.test.ts` is the check.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const V7 = 7;

/**
 * `DECLINE_CODES` of `src/messages.ts`, in order. Copied, not imported: this
 * script runs on plain node. compat.test.ts proves every code (and every
 * sealed-branch code) appears in the corpus, so a drift fails there.
 */
const DECLINE_CODES = [
  'agent_home_writer_busy', 'agent_home_reader_busy',
  'sealed_key_unavailable', 'sealed_open_failed', 'sealed_content_mac_mismatch', 'sealing_policy_mismatch', 'native_sessions_unsupported',
  'agent_memory_selection_invalid', 'native_sessions_selection_invalid',
  'runtime_unavailable', 'offer_capability_missing', 'preparation_store_unavailable', 'agent_memory_commit_unavailable',
  'agent_memory_unavailable', 'tool_authorization_unsupported', 'file_scope_conflicts_with_all', 'file_scope_unsupported',
  'preparation_lane_unconfigured', 'preparation_result_schema_mismatch', 'preparation_not_found', 'preparation_not_ready',
  'preparation_device_mismatch', 'preparation_agent_mismatch', 'preparation_profile_revision_mismatch',
  'preparation_policy_revision_mismatch', 'preparation_request_digest_mismatch', 'preparation_artifact_digest_mismatch',
  'agent_memory_mismatch', 'preparation_runtime_identity_mismatch', 'preparation_tool_set_mismatch',
  'preparation_tool_binding_digest_mismatch', 'preparation_observation_digest_mismatch',
  'preparation_tool_surface_unfingerprintable', 'preparation_already_pinned',
  'input_preparation_unconfigured', 'bad_request', 'authority_unavailable', 'scope_denied', 'policy_revision_mismatch',
  'runtime_identity_unavailable', 'unsupported_input', 'limit_exceeded', 'request_conflict', 'not_found',
  'counter_unavailable', 'counter_interrupted', 'durable_write_failed', 'cancelled', 'context_unresolvable',
  'context_hash_mismatch', 'toolsets_unobservable', 'deadline_elapsed', 'observation_drift', 'rpc_frame_too_large',
  'input_preparation_record_log_unsupported',
];
const SEALED_DECLINE_CODES = ['sealed_key_unavailable', 'sealed_open_failed', 'sealed_content_mac_mismatch', 'sealing_policy_mismatch', 'native_sessions_unsupported'];
const STEER_REFUSAL_REASONS = ['input_too_large', 'steer_unsupported', 'task_not_active'];
/** v6 selection rules v7 deleted: a v7 device never declines with them. */
const DELETED_DECLINE_CODES = new Set(['runtime_selection_mismatch', 'harness_selection_conflict']);
const DROPPED_HELLO_CAPABILITIES = new Set(['steer', 'provider-profile-binding']);
const OFFER_SELECTORS = new Set(['runtime', 'harnessId', 'dispatchSelection']);
const CLAIM_SELECTORS = new Set(['runtime', 'harnessId']);
/** The runtime executor of a v6 claim or completion that named none: Pi, the device's first auto choice. */
const DEFAULT_RUNTIME = 'pi';
/** `RUNTIME_IDS` of `src/constants.ts`. */
const RUNTIME_IDS = ['pi', 'claude', 'codex'];

function ndjson(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Rebuilds `object` in key order, replacing the keys in `drop` by `[key, value]` at the first dropped key's position. */
function replaceKeys(object, drop, key, value, fallbackAfter) {
  const out = {};
  let placed = value === undefined;
  for (const [name, field] of Object.entries(object)) {
    if (drop.has(name)) {
      if (!placed) {
        out[key] = value;
        placed = true;
      }
      continue;
    }
    out[name] = field;
    if (!placed && fallbackAfter === name) {
      out[key] = value;
      placed = true;
    }
  }
  if (!placed) return { [key]: value, ...out };
  return out;
}

function offerTarget(payload) {
  if (payload.nativeSessions !== undefined) return { lane: 'runtime', runtimeId: 'pi' };
  const selection = payload.dispatchSelection;
  if (selection !== undefined) {
    if (selection.lane === 'subscription') return { lane: 'subscription', runtimeId: selection.runtimeId, modelId: selection.modelId };
    return selection;
  }
  if (payload.harnessId !== undefined) return { lane: 'harness', harnessId: payload.harnessId };
  if (payload.runtime !== undefined) return { lane: 'runtime', runtimeId: payload.runtime };
  return { lane: 'auto' };
}

function claimExecutor(payload) {
  if (payload.runtime !== undefined) return { kind: 'runtime', runtimeId: payload.runtime };
  if (payload.harnessId !== undefined) return { kind: 'harness', harnessId: payload.harnessId };
  return { kind: 'runtime', runtimeId: DEFAULT_RUNTIME };
}

function transformPayload(type, payload) {
  switch (type) {
    case 'conn.hello':
      return {
        ...payload,
        protocolVersions: payload.protocolVersions.map((version) => (version === 6 ? V7 : version)),
        capabilities: payload.capabilities.filter((flag) => !DROPPED_HELLO_CAPABILITIES.has(flag)),
      };
    case 'task.offer': {
      let next = replaceKeys(payload, OFFER_SELECTORS, 'target', offerTarget(payload));
      if (!Object.keys(payload).some((key) => OFFER_SELECTORS.has(key))) next = { ...payload, target: offerTarget(payload) };
      if (next.limits !== undefined) {
        const { maxTokens: _maxTokens, ...limits } = next.limits;
        next = { ...next, limits };
      }
      return next;
    }
    case 'task.claim': {
      const { agentId: _agentId, ...rest } = payload;
      return replaceKeys(rest, CLAIM_SELECTORS, 'executor', claimExecutor(payload), rest.agentRef !== undefined ? 'agentRef' : 'deviceId');
    }
    case 'task.complete':
    case 'task.fail':
    case 'task.cancelled': {
      const executor = payload.harnessId !== undefined
        ? { kind: 'harness', harnessId: payload.harnessId }
        : type === 'task.complete' ? { kind: 'runtime', runtimeId: DEFAULT_RUNTIME } : undefined;
      if (executor === undefined) return payload;
      return payload.harnessId !== undefined ? replaceKeys(payload, new Set(['harnessId']), 'executor', executor) : { executor, ...payload };
    }
    case 'task.decline': {
      const match = typeof payload.reason === 'string' ? /^([a-z][a-z0-9_]*): (.*)$/su.exec(payload.reason) : null;
      if (match === null || !DECLINE_CODES.includes(match[1])) return payload;
      if (payload.code !== undefined && payload.code !== match[1]) throw new Error(`decline reason prefix ${match[1]} disagrees with code ${payload.code}`);
      const next = { ...payload, reason: match[2] };
      if (next.code === undefined) next.code = match[1];
      return next;
    }
    default:
      return payload;
  }
}

function transformEnvelope(envelope) {
  if (envelope.v !== 6) throw new Error(`expected a v6 envelope, got v${envelope.v}`);
  return { ...envelope, v: V7, payload: transformPayload(envelope.type, envelope.payload) };
}

/** A v6 line v7 has no equivalent for; the generator drops it. */
function dropped(envelope) {
  return envelope.type === 'task.decline' && DELETED_DECLINE_CODES.has(envelope.payload.code);
}

function transformHttpBody(surface, body) {
  const next = { ...body };
  if (surface === 'EventsPollResponse' || surface === 'MessagesSendResponse') delete next.capabilities;
  // v7 requires the registration fence (#2045); a v6 pairing knew no current device.
  if (surface === 'PairRequest') next.expectedDeviceDigest = null;
  if (Array.isArray(next.events)) next.events = next.events.map(transformEnvelope);
  if (Array.isArray(next.messages)) next.messages = next.messages.map(transformEnvelope);
  if (Array.isArray(next.protocolVersions)) next.protocolVersions = next.protocolVersions.map((version) => (version === 6 ? V7 : version));
  return next;
}

function httpLine(surface, body, batchLength) {
  const text = JSON.stringify(body);
  return JSON.stringify({ surface, body: text, value: JSON.parse(text), ...(batchLength === undefined ? {} : { batchLength }) });
}

// ---------------------------------------------------------------------------
// v7 additions
// ---------------------------------------------------------------------------

let addition = 0;
/** A fresh, unique id and timestamp for each appended line. */
function nextHeader() {
  addition += 1;
  const id = `00000000-0000-4000-8000-${(0x700000 + addition).toString(16).padStart(12, '0')}`;
  const ts = new Date(Date.UTC(2026, 10, 16, 1, 0, 0) + addition * 1000).toISOString();
  return { v: V7, id, ts };
}

function uuidFromSha256Hex(hex64) {
  const hex = hex64.slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) & 0x03];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

/** `steerRefusalEnvelopeId` of `src/steer-refusal.ts`; compat.test.ts checks every corpus refusal against it. */
function steerRefusalEnvelopeId(steerMessageId) {
  return uuidFromSha256Hex(createHash('sha256').update(JSON.stringify({ domain: 'byok:task-steer-refused', steerMessageId })).digest('hex'));
}

function steerRefused(header, taskId, steerMessageId, reason) {
  return { v: V7, id: steerRefusalEnvelopeId(steerMessageId), ts: header.ts, type: 'task.steer_refused', task_id: taskId, payload: { steerMessageId, reason } };
}

function byId(envelopes, id) {
  const found = envelopes.find((envelope) => envelope.id === id);
  if (found === undefined) throw new Error(`no corpus line ${id}`);
  return found;
}

function additions(v6Envelopes, v7Envelopes) {
  const out = [];
  const push = (fields) => out.push({ ...nextHeader(), ...fields });

  // task.steer_refused: each reason, an unknown well-formed reason, and one on a sealed task.
  const plainSteer = byId(v6Envelopes, '00000000-0000-4000-8000-000000000007');
  const sealedSteer = byId(v6Envelopes, '00000000-0000-4000-8000-0000000009e2');
  STEER_REFUSAL_REASONS.forEach((reason, index) => {
    const steerMessageId = index === 0 ? plainSteer.id : `00000000-0000-4000-8000-0000007005${(index).toString(16).padStart(2, '0')}`;
    out.push(steerRefused(nextHeader(), plainSteer.task_id, steerMessageId, reason));
  });
  out.push(steerRefused(nextHeader(), plainSteer.task_id, '00000000-0000-4000-8000-0000007005ff', 'invented_refusal_reason'));
  out.push(steerRefused(nextHeader(), sealedSteer.task_id, sealedSteer.id, 'steer_unsupported'));

  // Both executor kinds on the claim, and every runtime as the runtime
  // executor of each terminal type and as the runtime lane of an offer, on
  // the plaintext and the sealed branch. Each copies a rewritten line of the
  // same task, so a sealed member still opens under its binding.
  push({ type: 'task.claim', task_id: 'task-golden-1', payload: { deviceId: 'device-golden-1', executor: { kind: 'harness', harnessId: 'grok' } } });
  const templates = [
    '00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000009e4', // task.complete
    '00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000009eb', // task.fail
    '00000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-0000000009f6', // task.cancelled
  ].map((id) => byId(v7Envelopes, id));
  for (const template of templates) {
    const { executor: _executor, ...payload } = template.payload;
    for (const runtimeId of RUNTIME_IDS) {
      if (template.payload.executor?.runtimeId === runtimeId) continue;
      push({ type: template.type, task_id: template.task_id, payload: { executor: { kind: 'runtime', runtimeId }, ...payload } });
    }
  }
  for (const id of ['00000000-0000-4000-8000-000000000019', '00000000-0000-4000-8000-0000000009b3']) {
    const offer = byId(v7Envelopes, id);
    const seen = new Set(v7Envelopes.filter((line) => line.type === 'task.offer' && line.payload.target.lane === 'runtime'
      && (line.payload.sealed !== undefined) === (offer.payload.sealed !== undefined)).map((line) => line.payload.target.runtimeId));
    for (const runtimeId of RUNTIME_IDS) {
      if (seen.has(runtimeId)) continue;
      const { v: _v, id: _id, ts: _ts, ...rest } = offer;
      push({ ...rest, payload: { ...offer.payload, target: { lane: 'runtime', runtimeId } } });
    }
  }

  // A decline for every code the rewritten corpus does not carry yet, on the
  // plaintext branch and, for a sealed-branch code, on the sealed branch.
  // The sealed member is the one a v6 sealed selection decline of the same
  // task carried: the decline code is not part of the sealed binding.
  const declines = v7Envelopes.filter((envelope) => envelope.type === 'task.decline');
  const plainCodes = new Set(declines.filter((line) => line.payload.sealed === undefined).map((line) => line.payload.code));
  const sealedCodes = new Set(declines.filter((line) => line.payload.sealed !== undefined).map((line) => line.payload.code));
  const sealedTemplate = byId(v6Envelopes, '00000000-0000-4000-8000-000000001678');
  for (const code of DECLINE_CODES) {
    if (plainCodes.has(code)) continue;
    push({ type: 'task.decline', task_id: `task-golden-decline-${code.replaceAll('_', '-')}`, payload: { reason: 'display only', retryable: false, code } });
  }
  for (const code of DECLINE_CODES) {
    if (SEALED_DECLINE_CODES.includes(code) || sealedCodes.has(code)) continue;
    push({ type: 'task.decline', task_id: sealedTemplate.task_id, payload: { retryable: false, code, sealed: sealedTemplate.payload.sealed } });
  }

  return out;
}

/** The lines origin/main appended to v6 after 0.43.0, never released; v7 carries them (#2259). */
const AGENT_USER_CONTEXT_ENVELOPES = [
  { v: V7, id: '00000000-0000-4000-8000-0000002241a1', ts: '2026-11-16T00:00:00.000Z', type: 'task.decline', task_id: 'task-golden-runtime-unavailable-agent-user-context', payload: { reason: 'agent_user_context_unavailable: runtime "codex" cannot keep user context out on this device. Windows refused to create a symbolic link (EPERM); turn on Developer Mode, run the daemon as an administrator, or set agentUserContext to \'inherit\' on this device', retryable: true, code: 'runtime_unavailable', runtimeUnavailable: { cause: 'agent_user_context_unavailable' } } },
  { v: V7, id: '00000000-0000-4000-8000-0000002241a2', ts: '2026-11-16T00:00:01.000Z', type: 'task.decline', task_id: 'task-golden-runtime-unavailable-sealed', payload: { retryable: true, code: 'runtime_unavailable', runtimeUnavailable: { cause: 'agent_user_context_unavailable' }, sealed: { v: 1, suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm', category: 'task-output', scope: { id: 'scope-golden-device-1', epoch: 2, keyId: 'qmLtbJYKTHb4lkm_QofPXA' }, chainHead: { seq: 3, hash: 'sha256:d84d1ca50d7ed4fb94d2c2efa48e3e2fe835725adfc196496de47f97906cb873' }, sender: 'SMFpTgqfzv36yTvqOR8dVpbi2OGjw9WeVWKucOdY2m8', salt: 'MIEKiNjeQvps8ZnBZ5Fqj3YweH2UmtKhyclMrvnITFk', nonce: 'whn88GlO9pLHUnoG', paddedLength: 512, contentMac: 'hmac-sha256:723e5564f1a8d2b5f41408dd8c969448cfa6b9a6e79941a999857550fb6c6f74', ciphertext: 'xaIlktoAVty0E5xFh80EM1u2I-oOfKxnoGTVnmEgmKYyDSwhexPyLyer8tljwhuQOyuHXv74faRhEFj8DDquCBWv9Cj5k51vThuBQEEXR0BfxKTYgoJqb_kUrKMv0jZSJjo9ai4IyL5519GcsywVoNpg0OvdcH5O3YcNpp7ImeKknP_XGkMcWnezzdrpz1SncBbDh3GikqgU22xVLZQtjzfrBNf8q3kr5y-CCqQra7PK6p9P7h3F54dszM-_c-Y4CA3kQ9eo2tjuPiH_LjxiIalnHunO7ilSE7qwc3v91ABODI8ywE2JpImxY5_UqhDPeSn8-ZHSPlYUnPmbK61sW2Vg80kGBjkG0Bxse8rbdBl2b4ALQh6tqJ7NaHGeLiIfZeDzjScWdUIdmcy0Um1nPsBhL3Zd-0y-uNhin1gdP3r3ZS37SK31siZQAr83FuZLKUDa3_7BksxyoxeY4J6Mv6SZBW9U1rWZPSd5uoDVw2Bt4Gdnru7MJzVXOgSRH1wykieRNLZWNzjNzvdI2pSacH7uiZAG2eXwLHeZYUO5KT_DSMwSWNMIly0apIsX-HuscNYsw5TZ3z2xMrplS9FteFmWvNgoRpZMfl3hPAzwqH4KhRdjkcfqCDNL1ynKZfY3XnqvA0oWNlKIkakH2BJ_LLZsX81iH_GuRw6Via9dgH0CaEK-MuYSfPNORCYa0CuB' } } },
  { v: V7, id: '00000000-0000-4000-8000-0000002241a3', ts: '2026-11-16T00:00:02.000Z', type: 'conn.hello', payload: { protocolVersions: [V7], capabilities: ['runtime-unavailable-cause'], deviceId: 'device-golden-1', productId: 'acme-agent', clientVersion: '0.31.0', runtimeUnavailable: [{ id: 'codex', cause: 'agent_user_context_unavailable', retryable: true }] } },
];

const GOLDEN_MACHINE_ID = 'a'.repeat(64);

/** `pairDeviceDigest` of `src/pair-device-digest.ts`, restated on node:crypto; compat.test.ts recomputes it. */
function pairDeviceDigest(tenantId, productId, deviceId) {
  return createHash('sha256').update(JSON.stringify(['byok-pair-device-v1', tenantId, productId, deviceId])).digest('base64url');
}

function httpAdditions(v6HelloLine, v7HelloLine) {
  const helloV7 = { ...v7HelloLine, id: '00000000-0000-4000-8000-0000007006a1' };
  return [
    httpLine('PresencePublishRequest', { level: 'online', runtimeUnavailable: [{ id: 'codex', cause: 'agent_user_context_unavailable', retryable: true }] }),
    // The frozen cross-version refusal: a lone hello of another major (docs/protocol.md "Cross-version refusal").
    httpLine('MessagesSendResponse', { accepted: 0, rejected: 1, outcomes: [{ id: '00000000-0000-4000-8000-0000007006b1', outcome: 'rejected', reason: 'protocol_version_unsupported' }] }, 1),
    httpLine('MessagesSendResponse', { accepted: 1, rejected: 1, outcomes: [{ id: '00000000-0000-4000-8000-0000007006b2', outcome: 'accepted' }, { id: '00000000-0000-4000-8000-0000007006b3', outcome: 'rejected', reason: 'type_unsupported' }] }, 2),
    // The frame carries an entry of another major; the server answers that entry on its own.
    httpLine('MessagesSendRequest', { messages: [helloV7, v6HelloLine] }),
    // #2045 registration fence: a pairing that names the machine's current device, and the typed rejections.
    httpLine('PairRequest', { pairingCode: 'PAIR-GOLDEN-2', deviceName: 'golden-device', devicePublicKey: 'golden-public-key', machineId: GOLDEN_MACHINE_ID, expectedDeviceDigest: pairDeviceDigest('tenant-golden', 'acme-agent', 'dev_00000000-0000-4000-8000-000000002045') }),
    httpLine('PairSupersededResponse', { error: 'pairing superseded', code: 'pairing_superseded', currentDeviceDigest: pairDeviceDigest('tenant-golden', 'acme-agent', 'dev_00000000-0000-4000-8000-000000002046') }),
    httpLine('PairSupersededResponse', { error: 'pairing superseded', code: 'pairing_superseded', currentDeviceDigest: null }),
    httpLine('PairingCodeInvalidResponse', { error: 'invalid pairing code', code: 'pairing_code_invalid' }),
  ];
}

// ---------------------------------------------------------------------------

const v6EnvelopeLines = ndjson(readFileSync(`${goldenDir}v6.envelopes.ndjson`, 'utf8'));
const v6HttpLines = ndjson(readFileSync(`${goldenDir}v6.http.ndjson`, 'utf8'));
const v6Envelopes = v6EnvelopeLines.map((line) => JSON.parse(line));

const kept = v6Envelopes.filter((envelope) => !dropped(envelope));
const v7Envelopes = kept.map(transformEnvelope);
const v7All = [...v7Envelopes, ...AGENT_USER_CONTEXT_ENVELOPES];
v7All.push(...additions(v6Envelopes, v7All));

const ids = new Set();
for (const envelope of v7All) {
  if (ids.has(envelope.id)) throw new Error(`duplicate envelope id ${envelope.id}`);
  ids.add(envelope.id);
}

const v7Http = v6HttpLines.map((raw) => {
  const line = JSON.parse(raw);
  return httpLine(line.surface, transformHttpBody(line.surface, JSON.parse(line.body)), line.batchLength);
});
v7Http.push(...httpAdditions(v6Envelopes[0], v7Envelopes[0]));

writeFileSync(`${goldenDir}v7.envelopes.ndjson`, v7All.map((envelope) => `${JSON.stringify(envelope)}\n`).join(''));
writeFileSync(`${goldenDir}v7.http.ndjson`, v7Http.map((line) => `${line}\n`).join(''));
writeFileSync(`${goldenDir}v7.releases.json`, '{\n  "releases": []\n}\n');
process.stdout.write(`v7: ${v7All.length} envelope lines (${v6Envelopes.length - kept.length} v6 lines dropped), ${v7Http.length} HTTP lines\n`);
