import type { AuthManager } from './auth-manager';

/**
 * `fetch` with the current device bearer token attached. On a 401, renews
 * the token once (reactive renewal, protocol §6.2) and retries exactly
 * once — never loops. A second 401 (or {@link AuthManager.handleUnauthorized}
 * throwing `DeviceRevokedError`) propagates to the caller.
 */
export async function authedFetch(url: string | URL, init: RequestInit, auth: AuthManager): Promise<Response> {
  const token = await auth.getValidAccessToken();
  const res = await fetch(url, withAuth(init, token));
  if (res.status !== 401) return res;

  const renewed = await auth.handleUnauthorized();
  return fetch(url, withAuth(init, renewed));
}

function withAuth(init: RequestInit, token: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } };
}
