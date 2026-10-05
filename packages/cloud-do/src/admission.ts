import { CloudDoError } from './errors';
import { platformProfile, type PlatformProfileId } from './platform-credentials';

export interface CloudSubmission { readonly instruction: string; readonly profile: PlatformProfileId }
const credentialFields = new Set(['credential', 'credentials', 'apikey', 'api_key', 'secret', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cf-aig-authorization', 'headers']);

function rejectCredentialFields(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (depth > 8 || seen.has(value)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  seen.add(value);
  for (const [name, child] of Object.entries(value)) {
    if (credentialFields.has(name.toLowerCase())) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
    rejectCredentialFields(child, depth + 1, seen);
  }
}

/** Best effort, not a claim that arbitrary or obfuscated keys can be recognized. */
export function hasUserKeyShape(text: string): boolean {
  return /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b|\b[a-f\d]{32}\.[A-Za-z0-9_-]{16,}\b/u.test(text);
}

/** Frozen schema for the only 4b operation. No open metadata/config bags, no stripping. */
export function admitCloudSubmission(input: unknown): CloudSubmission {
  rejectCredentialFields(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(name => name !== 'instruction' && name !== 'profile') || typeof body.instruction !== 'string'
    || !body.instruction.trim() || body.instruction.length > 16_000) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  if (hasUserKeyShape(body.instruction)) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
  return { instruction: body.instruction, profile: platformProfile(body.profile === undefined ? 'zai_openai' : body.profile) };
}
