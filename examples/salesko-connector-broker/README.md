# Salesko connector broker reference

This private workspace example is the downstream composition behind a
Salesko-style `salesko.connectors` toolset. It is deliberately not a public
connector catalogue: `@byok-sdk/client` remains credential-blind, while this
separate stdio process explicitly depends on `@byok-sdk/keys` for OS-backed
secret custody.

When a host exposes long-lived connector profiles, setup should first request a
fresh device assertion with the host's exact connector-binding audience and
exchange it through `authenticateHostedDeviceAssertion()`. The assertion is
single-use and authorizes only that binding operation; it is not cached as the
profile login. After successful authentication, this broker continues to own
the Google refresh token in the OS credential store and the host owns any
durable profile/session metadata. A failed profile bind consumes the assertion
and requires a fresh one. BYOK device revocation blocks future exchanges but is
not Google token revocation.

The closed path is:

```text
Claude task
  -> logical toolset id
  -> device-local command
  -> stdio MCP
  -> exact correspondent-domain policy
  -> OAuth client + refresh token in OS credential store
  -> process-local access-token refresh
  -> Gmail profile/messages.list/messages.get(format=metadata)
  -> bounded correspondence metadata
```

Only `messageId`, optional `threadId`, correspondent name/email, direction,
and timestamp can leave the broker. Message bodies, subjects, attachments,
raw provider responses, OAuth tokens, and provider errors are rejected or
discarded rather than projected to MCP; a direct token echo in an otherwise
allowed metadata field is rejected too.

## Real Google boundary

This reference includes one concrete `GoogleGmailReadProvider`. It requests
only `gmail.readonly`, calls Google's REST endpoints directly, and asks
`messages.get` only for the `From`, `To`, and `Cc` metadata headers. It uses an
RFC 5322 parser rather than a header regex, exact-checks the resulting domain,
and emits at most one correspondent per message. It neither reads nor returns
the subject, snippet, body, attachments, or raw message.

The bounded search asks Gmail for at most 100 candidate message ids, then stops
metadata reads as soon as the requested result limit is satisfied. This is a
bounded correspondence search, not an exhaustive mailbox export.

The OAuth lifecycle follows Google's desktop-app loopback flow: a random
`127.0.0.1` port, an unguessable `state`, PKCE `S256`, offline access, and the
single Gmail read-only scope. The desktop OAuth client and refresh token are
separate macOS Keychain or Windows Credential Manager entries. Access tokens
are refreshed on demand, cached only in process, and never persisted. Every
tool call rechecks that the refresh credential still exists before using a
cached access token.

Google documents the relevant contracts in its
[desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app),
[OAuth security guidance](https://developers.google.com/identity/protocols/oauth2/resources/best-practices),
and Gmail [`messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
and [`messages.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
references.

## Configure and authorize

Create a Google **Desktop app** OAuth client and enable the Gmail API. Build the
example, then pipe this exact private JSON shape over stdin. Do not put the
client secret in argv, shell history, or logs:

```sh
bun run --filter @byok-sdk/example-salesko-connector-broker build
node dist/bin/salesko-connector-mcp.js configure --profile default < /secure/ephemeral/google-desktop-client.json
node dist/bin/salesko-connector-mcp.js login --profile default
node dist/bin/salesko-connector-mcp.js status --profile default
```

`google-desktop-client.json` is deliberately smaller and stricter than the
Google Console download:

```json
{
  "clientId": "...apps.googleusercontent.com",
  "clientSecret": "..."
}
```

`login` prints an authorization URL, listens only on its random loopback
callback for five minutes, verifies `state`, exchanges the PKCE code, proves
the Gmail account through `users/me/profile`, and persists only the refresh
credential. It never prints either token. Reconfiguring a different OAuth
client while a refresh token exists is rejected; revoke or forget first.

Normal disconnect confirms upstream Google revocation before deleting the
local refresh credential:

```sh
node dist/bin/salesko-connector-mcp.js revoke --profile default
```

If external revocation has already made Google return an error, an operator may
explicitly delete only the unusable local credential:

```sh
node dist/bin/salesko-connector-mcp.js forget --profile default
```

`forget` does not claim upstream revocation. BYOK device/pairing revocation is
a third, independent lifecycle authority.

## Device configuration

Build the example, then point the daemon's local registry at the generated
binary. Every path is local operator configuration; none crosses the BYOK
wire.

```ts
mcpToolsets: {
  'salesko.connectors': {
    mcpServers: {
      'salesko-connectors': {
        command: process.execPath,
        args: [
          '/absolute/path/to/dist/bin/salesko-connector-mcp.js',
          'serve',
          '--profile', 'default',
          '--allow-domain', 'acme.com',
        ],
      },
    },
  },
}
```

The task must request both the toolset and explicit domains. A domain outside
the local allowlist is rejected before credential access or provider I/O;
provider results outside the requested domain or age window are rejected rather
than filtered into an apparently successful response.

## Production gates

- `gmail.readonly` is a restricted Google scope. Public production use still
  requires the applicable Google verification and security-assessment process;
  this repository cannot complete that external control-plane work.
- Google's current security guidance strongly recommends DPoP for high-value
  public clients. This reference implements PKCE and OS-backed refresh-token
  custody but not DPoP, so that remains a GA hardening gate.
- The domain allowlist is a data-policy gate, not a network-egress or process
  sandbox. The MCP subprocess runs with the daemon user's OS authority.
- There is no plaintext or Linux credential fallback. The runnable composition
  supports macOS Keychain and Windows Credential Manager only.
- The automated suite uses a protocol-faithful fake Google HTTP boundary. A
  live Gmail sandbox run requires operator-owned credentials and explicit
  consent and is therefore not part of ordinary CI.

Bundled third-party license text is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

```sh
bun run --filter @byok-sdk/example-salesko-connector-broker test
```
