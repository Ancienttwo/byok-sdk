/** Normalize a configured `serverUrl` (http/https/ws/wss, any path) to an http(s) base with no path/query. */
export function toHttpBase(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = '/';
  url.search = '';
  return url.toString();
}

/** Derive the `/byok/ws` WebSocket URL from a configured `serverUrl`. */
export function toWsUrl(serverUrl: string): string {
  const url = new URL('/byok/ws', toHttpBase(serverUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
