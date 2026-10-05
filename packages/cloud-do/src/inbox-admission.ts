import { hasUserKeyShape } from './admission';
import { CloudDoError } from './errors';
import { platformProfile, type PlatformProfileId } from './platform-credentials';

export type InboxSource = 'message' | 'schedule' | 'invocation';
export interface CloudInboxAdmission {
  readonly dedupKey: string;
  readonly source: InboxSource;
  readonly text: string;
  readonly profile: PlatformProfileId;
  readonly availableAt?: number;
  readonly expiresAt?: number;
}
const fields = new Set(['dedupKey', 'source', 'text', 'profile', 'availableAt', 'expiresAt']);
const credentials = new Set(['credential', 'credentials', 'apikey', 'api_key', 'secret', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cf-aig-authorization', 'headers']);
export const INBOX_DAY = 86_400_000;

/** Freeze the wire schema before credential reads or storage writes. */
export function admitCloudInbox(input: unknown, now = Date.now()): CloudInboxAdmission {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'string' && credentials.has(key.toLowerCase())) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !fields.has(key) || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new CloudDoError('CLOUD_REQUEST_INVALID');
    }
  }
  const body = input as Record<string, unknown>;
  if (typeof body.dedupKey !== 'string' || !body.dedupKey.length || body.dedupKey.length > 128
    || /[\u0000-\u001f\u007f-\u009f]/u.test(body.dedupKey)
    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16_000
    || !['message', 'schedule', 'invocation'].includes(body.source as string)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  if (hasUserKeyShape(body.text) || hasUserKeyShape(body.dedupKey)) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
  for (const key of ['availableAt', 'expiresAt']) {
    if (body[key] !== undefined && !Number.isSafeInteger(body[key])) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  const availableAt = body.availableAt as number | undefined;
  const expiresAt = body.expiresAt as number | undefined;
  if ((availableAt !== undefined && availableAt > now + 30 * INBOX_DAY)
    || (expiresAt !== undefined && availableAt !== undefined && expiresAt <= availableAt)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  // An omitted availability on retry resolves from the retained row, not this admission clock.
  // CloudState validates the complete pair before any item/event/alarm write.
  return Object.freeze({ dedupKey: body.dedupKey, source: body.source as InboxSource, text: body.text,
    profile: platformProfile(body.profile === undefined ? 'zai_openai' : body.profile),
    ...(availableAt === undefined ? {} : { availableAt }), ...(expiresAt === undefined ? {} : { expiresAt }) });
}
