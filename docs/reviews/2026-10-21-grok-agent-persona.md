# Issue 628: fresh-session Agent persona routing

Baseline: `742295a4a97a8c1de5b2ab55c827ac2f73cb07cc`.
The relevant Grok adapter, vendor profile and operation manifest were unchanged
from release baseline `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`.

The adapter supplied no canonical-home persona. The vendored profile mapped
appendSystemPrompt to initialize._meta.rules, while the installed Grok guide
(user-guide/15-agent-mode.md, Session _meta options) documents rules on
session/new. This is a documented routing mismatch, not proof that every Grok
version ignores initialize metadata. Folder trust also gates MCP/LSP, hooks,
project instructions and skills together (user-guide/10-hooks.md); granting
that trust would change authority beyond the persona repair.

This slice reads only a strict Agent's sealed lease canonical-home AGENTS.md,
not ancestor/global/run-directory rules. It retains the sealed reader cwd.
The file must be regular, non-symlink, stable, valid UTF-8 and at most 64 KiB.
Missing or empty files add no rules. Unsafe reads fail closed before spawn.
Fresh sessions append rules on session/new without replacing the built-in
system prompt, changing argv/environment or modifying trust configuration.

The upstream profile refuses append-only resumed rules, citing observed Grok
1.0.52 behavior. Persona-bearing Agent resumes now explicitly fail before
spawn with a non-retryable authority error. Non-Agent resumes and Agent resumes
without persona remain unchanged. No session is silently replaced or forked.
Root independent review approved this conditional refusal and its integration
impact before commit. Runtime-backed resume qualification is a separate remaining decision.

The maintained vendor source has an Apache change notice and a documented
source-manifest delta. Its upstream commit/hash are unchanged; only the actual
vendored hash and maintained-file inventory are updated.

Evidence (macOS, Node 24.18.0 / Bun 1.4.3):

- Baseline new fixture suite: 6 failed, 1 passed. Failures covered absent canonical
  and reader persona metadata, unsafe/oversized files ignored, and persona resume.
- Patched affected Grok/persona/ACP/provenance suites: 53 passed across five files,
  no skips. Includes canonical and reader decoys, unchanged trust argv/env,
  explicit resume refusal, missing/empty persona and ordinary resume behavior.
- Workspace build/typecheck and version authority passed; OAR bridge: 4 passed.
  API declarations have no drift; private ACP closure measures 83,751 bytes
  against the prior exact 83,640-byte budget (+111 bytes from the maintained
  routing change). Root review approved an exact 83,751-byte budget; no generic
  relaxation or dependency prohibition changed. The updated API gate passed.
  No monorepo full test suite was duplicated.

These are synthetic ACP transport tests, not real model/runtime acceptance.
No real Grok session, model call, credential read, folder-trust edit or private
AiphaBee access was performed. Live canonical persona adherence and unchanged
MCP/hooks trust gates remain pending authorized runtime context/budget; #628
must remain open and no new Grok version is qualified by this slice.
