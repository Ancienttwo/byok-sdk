// Cross-package drift check: the device-side provisioning codes that
// @byok-sdk/keys emits must map 1:1 onto the @byok-sdk/protocol closed sets.
//
// keys may not import protocol, and no aligned package may reach keys
// (scripts/release/check-package-graph.mjs), so neither package can hold this
// check. It lives with the root scripts and reads both packages' built `dist/`
// entrypoints, which is why `test:scripts` runs after `bun run build`.
//
// The mapping below is the spec recorded in
// tasks/notes/20260928-0450-web-sealed-provisioning.notes.md (S2c): every
// device-side meaning has exactly one wire code, and the wire code is the same
// string. A new code on either side must be added here deliberately, which
// fails this test until both sets and this table agree.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distEntry = (pkg) => pathToFileURL(path.join(repoRoot, 'packages', pkg, 'dist', 'index.js')).href;

const keys = await import(distEntry('keys'));
const protocol = await import(distEntry('protocol'));

/** keys rejection → protocol rejection code. */
const REJECTION_MAPPING = {
  request_invalid: 'request_invalid',
  request_conflict: 'request_conflict',
  request_expired: 'request_expired',
  request_not_yet_valid: 'request_not_yet_valid',
  request_window_invalid: 'request_window_invalid',
  sealing_key_rotated: 'sealing_key_rotated',
  enrollment_mismatch: 'enrollment_mismatch',
  agent_not_placed: 'agent_not_placed',
  config_digest_mismatch: 'config_digest_mismatch',
  operation_generation_stale: 'operation_generation_stale',
  profile_changed: 'profile_changed',
  profile_not_found: 'profile_not_found',
  credential_scope_mismatch: 'credential_scope_mismatch',
  provider_kind_unsupported: 'provider_kind_unsupported',
  pi_model_invalid: 'pi_model_invalid',
  capabilities_invalid: 'capabilities_invalid',
  seal_open_failed: 'seal_open_failed',
  secret_invalid: 'secret_invalid',
  local_commit_interrupted: 'local_commit_interrupted',
  secret_store_unavailable: 'secret_store_unavailable',
};

/** keys key-check outcome → protocol keyCheck result. */
const KEY_CHECK_MAPPING = {
  ok: 'ok',
  credential_rejected: 'credential_rejected',
  rate_limited: 'rate_limited',
  quota_or_billing: 'quota_or_billing',
  model_not_permitted: 'model_not_permitted',
  provider_error: 'provider_error',
  unreachable: 'unreachable',
  timeout: 'timeout',
  not_run: 'not_run',
};

function assertBijection(label, deviceCodes, wireCodes, mapping) {
  assert.ok(Array.isArray(deviceCodes) && deviceCodes.length > 0, `${label}: keys list missing from dist`);
  assert.ok(Array.isArray(wireCodes) && wireCodes.length > 0, `${label}: protocol list missing from dist`);
  assert.equal(new Set(deviceCodes).size, deviceCodes.length, `${label}: keys list has duplicates`);
  assert.equal(new Set(wireCodes).size, wireCodes.length, `${label}: protocol list has duplicates`);

  assert.deepEqual([...deviceCodes].sort(), Object.keys(mapping).sort(), `${label}: keys codes differ from the mapping table`);
  const mapped = Object.values(mapping);
  assert.equal(new Set(mapped).size, mapped.length, `${label}: mapping table is not injective`);
  assert.deepEqual([...mapped].sort(), [...wireCodes].sort(), `${label}: mapping image differs from the protocol closed set`);
  for (const [device, wire] of Object.entries(mapping)) {
    assert.equal(wire, device, `${label}: ${device} must keep the same wire string`);
  }
}

test('keys provisioning rejections map 1:1 onto protocol rejection codes', () => {
  assertBijection(
    'rejection',
    keys.PROVIDER_PROVISIONING_REJECTIONS,
    protocol.PROVIDER_PROVISIONING_REJECTION_CODES,
    REJECTION_MAPPING,
  );
});

test('keys key-check outcomes map 1:1 onto protocol keyCheck results', () => {
  assertBijection(
    'keyCheck',
    keys.PROVIDER_KEY_CHECK_OUTCOMES,
    protocol.PROVIDER_PROVISIONING_KEY_CHECK_RESULTS,
    KEY_CHECK_MAPPING,
  );
});

test('every Host-terminal rejection is a device-side rejection too', () => {
  for (const code of protocol.PROVIDER_PROVISIONING_HOST_TERMINAL_CODES) {
    assert.ok(keys.PROVIDER_PROVISIONING_REJECTIONS.includes(code), `${code} is Host-terminal but unknown to keys`);
  }
});
