import { describe, expect, it } from 'vitest';
import { assertServerUrlAllowed, InsecureServerUrlError } from '../daemon/url';

/**
 * M5: transport-security gate — refuses plaintext (`ws:`/`http:`) transport
 * to any non-loopback host. See `url.ts`'s own doc comment on
 * `assertServerUrlAllowed` for the full allow/deny rule; entry-point
 * coverage (`create-daemon.ts`'s `pair()`/`start()`, and the warning emitted
 * when the escape hatch is actually exercised) lives in
 * `create-daemon-url-gate.test.ts`, not here — this file is the pure,
 * synchronous gate function in isolation.
 */
describe('url.ts: assertServerUrlAllowed', () => {
  describe('https:/wss: — always allowed, any host', () => {
    it.each([
      'https://example.com',
      'https://192.168.1.10',
      'https://any-remote-host.example',
      'wss://example.com',
      'wss://192.168.1.10',
    ])('%s does not throw', (url) => {
      expect(() => assertServerUrlAllowed(url)).not.toThrow();
    });
  });

  describe('http:/ws: to a loopback host — allowed', () => {
    it.each([
      'http://localhost',
      'http://localhost:4000',
      'http://sub.localhost',
      'http://sub.localhost:4000',
      'http://127.0.0.1',
      'http://127.9.9.9',
      'http://[::1]',
      'http://[::1]:4000',
      'ws://localhost',
      'ws://127.0.0.1:4000',
      'ws://[::1]:4000',
    ])('%s does not throw', (url) => {
      expect(() => assertServerUrlAllowed(url)).not.toThrow();
    });
  });

  describe('http:/ws: to a non-loopback host — rejected', () => {
    it('rejects a public hostname with a typed InsecureServerUrlError', () => {
      expect(() => assertServerUrlAllowed('http://example.com')).toThrow(InsecureServerUrlError);
    });

    it('rejects a private-LAN IP', () => {
      expect(() => assertServerUrlAllowed('http://192.168.1.10')).toThrow(InsecureServerUrlError);
    });

    it('rejects ws: the same way http: is rejected', () => {
      expect(() => assertServerUrlAllowed('ws://example.com')).toThrow(InsecureServerUrlError);
    });

    it('the error message names the redacted endpoint and the fix (wss:/https: or the escape hatch)', () => {
      let caught: unknown;
      try {
        assertServerUrlAllowed('http://example.com');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InsecureServerUrlError);
      const message = (caught as Error).message;
      expect(message).toContain('http://example.com');
      expect(message).toMatch(/wss:|https:/);
      expect(message).toContain('dangerouslyAllowInsecureRemote');
    });

    it('omits userinfo, query, and fragment secrets from plaintext-remote errors', () => {
      let caught: unknown;
      try {
        assertServerUrlAllowed('http://alice:password-sentinel@example.com/control?token=query-sentinel#fragment-sentinel');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InsecureServerUrlError);
      const message = (caught as Error).message;
      expect(message).toContain('http://example.com/control');
      for (const secret of ['alice', 'password-sentinel', 'query-sentinel', 'fragment-sentinel']) {
        expect(message).not.toContain(secret);
      }
    });

    it('a hostname that merely STARTS WITH "127." but is not actually in 127.0.0.0/8 is still rejected (no naive prefix match)', () => {
      expect(() => assertServerUrlAllowed('http://127.evil.com')).toThrow(InsecureServerUrlError);
    });

    it('a hostname ending in "localhost" but not actually the reserved *.localhost TLD is still rejected', () => {
      expect(() => assertServerUrlAllowed('http://localhost.evil.com')).toThrow(InsecureServerUrlError);
    });
  });

  describe('dangerouslyAllowInsecureRemote: true — admits an otherwise-rejected http:/ws: URL', () => {
    it('admits a public hostname', () => {
      expect(() => assertServerUrlAllowed('http://example.com', { dangerouslyAllowInsecureRemote: true })).not.toThrow();
    });

    it('admits a private-LAN IP', () => {
      expect(() => assertServerUrlAllowed('http://192.168.1.10', { dangerouslyAllowInsecureRemote: true })).not.toThrow();
    });

    it('is a no-op (never throws either way) when the URL was already loopback', () => {
      expect(() => assertServerUrlAllowed('http://localhost', { dangerouslyAllowInsecureRemote: true })).not.toThrow();
    });
  });

  describe('unknown scheme — rejected unconditionally', () => {
    it('rejects ftp:', () => {
      expect(() => assertServerUrlAllowed('ftp://example.com')).toThrow(InsecureServerUrlError);
    });

    it('rejects file:', () => {
      expect(() => assertServerUrlAllowed('file:///etc/passwd')).toThrow(InsecureServerUrlError);
    });

    it('the escape hatch does NOT admit an unsupported scheme — that rejection is unconditional', () => {
      expect(() => assertServerUrlAllowed('ftp://example.com', { dangerouslyAllowInsecureRemote: true })).toThrow(
        InsecureServerUrlError,
      );
    });

    it('omits userinfo, query, and fragment secrets from unsupported-scheme errors', () => {
      let caught: unknown;
      try {
        assertServerUrlAllowed('ftp://alice:password-sentinel@example.com/archive?token=query-sentinel#fragment-sentinel');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InsecureServerUrlError);
      const message = (caught as Error).message;
      expect(message).toContain('ftp://example.com/archive');
      for (const secret of ['alice', 'password-sentinel', 'query-sentinel', 'fragment-sentinel']) {
        expect(message).not.toContain(secret);
      }
    });
  });

  describe('unparseable serverUrl', () => {
    it('rejects with a typed error rather than letting the raw URL constructor error escape uncaught', () => {
      expect(() => assertServerUrlAllowed('not a url at all')).toThrow(InsecureServerUrlError);
    });

    it('does not echo malformed input that may itself contain secrets', () => {
      const malformed = 'http://alice:password-sentinel@exa mple.com/?token=query-sentinel#fragment-sentinel';
      let caught: unknown;
      try {
        assertServerUrlAllowed(malformed);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InsecureServerUrlError);
      const message = (caught as Error).message;
      expect(message).toBe('invalid server URL');
      for (const secret of ['alice', 'password-sentinel', 'query-sentinel', 'fragment-sentinel']) {
        expect(message).not.toContain(secret);
      }
    });
  });
});
