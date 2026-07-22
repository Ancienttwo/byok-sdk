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

/**
 * M5: thrown by {@link assertServerUrlAllowed} — see that function's own doc
 * comment for the full allow/deny rule this names. Deliberately ONE error
 * type for every way the gate can refuse a `serverUrl` (plaintext-to-remote,
 * or a scheme this SDK's transport has no meaning for at all): a catching
 * caller only ever needs "the configured server URL failed the
 * transport-security gate", never which specific sub-case fired — the
 * message text (not the type) carries that detail.
 */
export class InsecureServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureServerUrlError';
  }
}

export interface AssertServerUrlAllowedOptions {
  /**
   * Explicit escape hatch: when `true`, a `http:`/`ws:` `serverUrl` whose
   * host is NOT loopback is allowed through instead of throwing. Does
   * nothing for an unsupported scheme (see {@link assertServerUrlAllowed}'s
   * own doc comment) — that rejection is unconditional. Threaded from
   * `DaemonConfig.dangerouslyAllowInsecureRemote`; this function itself
   * never logs anything when the hatch is exercised — it stays a pure,
   * synchronous, easily-unit-testable gate — so a caller that sets this
   * true is expected to emit its own warning (see `create-daemon.ts`'s
   * `checkServerUrl`).
   */
  dangerouslyAllowInsecureRemote?: boolean;
}

/**
 * IPv4 dotted-quad with a first octet of `127` (the full RFC1122 loopback
 * block, `127.0.0.0/8`) — matched against an already-canonicalized
 * `URL.hostname`. The WHATWG URL parser normalizes every alternate IPv4
 * encoding (hex `0x7f000001`, bare-integer `2130706433`, octal `0177.0.0.1`,
 * short forms like `127.1`) to this same plain decimal-octet form before
 * `.hostname` is ever read, and genuinely reinterprets a leading zero as
 * octal (e.g. `0127.0.0.1` canonicalizes to `87.0.0.1`, NOT `127.0.0.1`) —
 * so there is no obfuscated spelling of a 127.0.0.0/8 address that reaches
 * this regex un-normalized, and no leading-zero form to additionally guard
 * against here.
 */
const IPV4_127_SLASH_8 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * `hostname` is expected to already be `new URL(...).hostname` — lowercased
 * and, for an IPv6 literal, bracketed, per WHATWG URL semantics. Tolerates
 * an unbracketed IPv6 literal too (stripped before comparison) purely
 * defensively, since nothing about this check depends on where `hostname`
 * came from.
 */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const normalized = bare.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1') return true;
  return IPV4_127_SLASH_8.test(normalized);
}

/**
 * M5: transport-security gate for a configured `serverUrl` — refuses
 * plaintext (`ws:`/`http:`) transport to any non-loopback host, so a device
 * can never be talked into pairing with (and sending its pairing code /
 * device credentials to) a remote host in the clear. Call this ONCE at each
 * real entry point a raw, operator-supplied `serverUrl` first enters the
 * client (`create-daemon.ts`'s `pair()`/`start()`) rather than inside
 * `toHttpBase`/`toWsUrl` themselves: ws-transport, the long-poll fallback,
 * and blob-client all read `serverUrl` from that SAME `DaemonConfig`, never
 * an independently-supplied URL of their own, so those two call sites are
 * already the single common path every one of them goes through.
 *
 * Rules, checked in order:
 *  - `https:`/`wss:` — always allowed, any host (TLS is the actual
 *    plaintext-network defense; this gate has nothing further to add there).
 *  - `http:`/`ws:` — allowed only when the hostname is loopback: exactly
 *    `localhost` or any `*.localhost` subdomain, an IPv4 literal in
 *    `127.0.0.0/8`, or the IPv6 loopback `::1` — see {@link isLoopbackHostname}.
 *  - `http:`/`ws:` to any other host — refused with a clear, typed
 *    {@link InsecureServerUrlError} naming the offending URL and the fix
 *    (use `wss:`/`https:`, or pass `dangerouslyAllowInsecureRemote: true` if
 *    this is a deliberate, understood exception) — UNLESS
 *    `opts.dangerouslyAllowInsecureRemote` is `true`.
 *  - Any other scheme (or a `serverUrl` that fails to parse as a URL at
 *    all) — always refused, regardless of `dangerouslyAllowInsecureRemote`:
 *    the escape hatch is specifically for "plaintext to a remote host I
 *    understand the risk of", not "a scheme this transport doesn't
 *    implement at all".
 */
export function assertServerUrlAllowed(rawUrl: string, opts: AssertServerUrlAllowedOptions = {}): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new InsecureServerUrlError(`invalid server URL "${rawUrl}": ${err instanceof Error ? err.message : String(err)}`);
  }

  switch (url.protocol) {
    case 'https:':
    case 'wss:':
      return;
    case 'http:':
    case 'ws:':
      if (opts.dangerouslyAllowInsecureRemote || isLoopbackHostname(url.hostname)) return;
      throw new InsecureServerUrlError(
        `refusing to connect to "${rawUrl}" over plaintext ${url.protocol.replace(':', '')} — "${url.hostname}" is not a ` +
          'loopback host. Use wss:/https: for any non-loopback server, or pass { dangerouslyAllowInsecureRemote: true } ' +
          '(DaemonConfig) if you understand and accept the risk of sending device credentials over an unencrypted connection.',
      );
    default:
      throw new InsecureServerUrlError(
        `refusing to connect to "${rawUrl}" — unsupported scheme "${url.protocol}" (expected http:, https:, ws:, or wss:).`,
      );
  }
}
