# Salesko connector broker reference

This private workspace example is the downstream composition behind a
Salesko-style `salesko.connectors` toolset. It is deliberately not a public
connector catalogue: `@byok-sdk/client` remains credential-blind, while this
separate stdio process explicitly depends on `@byok-sdk/keys` for OS-backed
secret custody.

The closed path is:

```text
Claude task
  -> logical toolset id
  -> device-local command
  -> stdio MCP
  -> exact correspondent-domain policy
  -> OS credential store
  -> host-owned GmailReadProvider
  -> bounded correspondence metadata
```

Only `messageId`, optional `threadId`, correspondent name/email, direction,
and timestamp can leave the broker. Message bodies, subjects, attachments,
raw provider responses, OAuth tokens, and provider errors are rejected or
discarded rather than projected to MCP; a direct token echo in an otherwise
allowed metadata field is rejected too.

## Host provider contract

The Salesko composition supplies an absolute local ESM module exporting:

```ts
export async function createGmailReadProvider() {
  return {
    async searchCorrespondence({ accessToken, domains, limit, newerThanDays, signal }) {
      // Call the official Gmail API read-only. Never log or return accessToken.
      // Pass signal to every network request so the broker deadline can abort it.
      // Return only the GmailCorrespondence fields exported by this example.
    },
  };
}
```

The provider module is trusted credential-plane code: it receives the access
token in process, must honor `signal`, and must not write logs to stdout (stdout
is the MCP transport). The domain allowlist constrains requested and returned
correspondents; it is not a network-egress sandbox for that trusted module.
Broker calls are sequential and carry a 10-second local deadline by default.

Google authorization-code acquisition and refresh stay in the host product.
That workflow writes a short-lived access token to macOS Keychain or Windows
Credential Manager by calling `provisionOAuthCredential()` or piping the same
strict JSON shape to the `provision` command over stdin. Expired credentials
fail closed; this broker never guesses a refresh flow and has no plaintext or
Linux fallback.

After building, the host can pipe the strict credential JSON directly from its
OAuth callback process. Do not put the token in argv or logs:

```sh
node dist/bin/salesko-connector-mcp.js provision --profile default < /secure/ephemeral/oauth-credential.json
node dist/bin/salesko-connector-mcp.js status --profile default
node dist/bin/salesko-connector-mcp.js revoke --profile default
```

`revoke` deletes the local secret only. Device/pairing revocation and upstream
Google token revocation remain separate host-owned lifecycle operations.

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
          '--provider-module', '/absolute/path/to/salesko-gmail-provider.mjs',
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

```sh
pnpm --filter @byok-sdk/example-salesko-connector-broker run build
pnpm --filter @byok-sdk/example-salesko-connector-broker run test
```
