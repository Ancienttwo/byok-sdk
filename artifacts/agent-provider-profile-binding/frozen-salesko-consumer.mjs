import assert from 'node:assert/strict';
import {
  ProviderProfileBindingSchema,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
} from '@byok-sdk/protocol';
import {
  assertExactProviderProfileBinding,
  exactProviderProfileBinding,
  parseModelProviderProfile,
} from '@byok-sdk/keys';

const common = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  capabilities: ['image-input'],
  created_at: '2026-09-03T00:00:00.000Z',
  enabled: true,
  kind: 'model',
  model: 'anthropic/claude-sonnet-4',
  provider_kind: 'custom',
  updated_at: '2026-09-03T00:00:00.000Z',
};
const primary = parseModelProviderProfile({
  ...common,
  base_url: 'https://openrouter.ai/api/v1',
  display_name: 'OpenRouter primary',
  profile_ref: 'openrouter-primary',
});
const backup = parseModelProviderProfile({
  ...common,
  base_url: 'https://backup.example.com/v1',
  display_name: 'OpenRouter backup',
  enabled: false,
  profile_ref: 'openrouter-backup',
});
const primaryBinding = exactProviderProfileBinding(primary, ['image-input']);
const backupBinding = exactProviderProfileBinding(backup, ['image-input']);
assert.notEqual(primaryBinding.profileRef, backupBinding.profileRef);
assert.notEqual(primaryBinding.profileHash, backupBinding.profileHash);
assert.doesNotThrow(() => assertExactProviderProfileBinding(primary, primaryBinding));
assert.throws(
  () => assertExactProviderProfileBinding(primary, { ...primaryBinding, profileHash: backupBinding.profileHash }),
  /hash mismatch/,
);

const wireBinding = ProviderProfileBindingSchema.parse(primaryBinding);
const envelope = createEnvelope('task.offer_for_agent', {
  instruction: 'inspect image',
  policy: { mode: 'auto' },
  agentRef: { agentId: 'agent-salesko-frozen', profileRevision: 'profile-r1' },
  dispatchSelection: {
    lane: 'byok-profile',
    runtimeId: 'pi',
    providerProfile: wireBinding,
  },
}, { taskId: 'task-salesko-frozen', seq: 1 });
assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope);
const serialized = JSON.stringify(envelope);
assert.equal(serialized.includes(primary.base_url), false);
assert.equal(/credential|secret|api[_-]?key/iu.test(serialized), false);

console.log(JSON.stringify({
  status: 'passed',
  consumer: 'frozen-salesko-provider-profile-binding',
  profiles: [primaryBinding.profileRef, backupBinding.profileRef],
  capability: wireBinding.requiredCapabilities,
  secretFree: true,
}));
