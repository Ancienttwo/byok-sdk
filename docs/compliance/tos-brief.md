# Anthropic / OpenAI ToS Legal-Checkpoint Brief

**Purpose.** Give counsel the technical facts and the public-policy landscape needed to
decide whether the byok-sdk may be released **publicly** without violating Anthropic's or
OpenAI's terms. This brief **gates public release**; it does **not** gate internal
dogfooding.

**Audience.** Legal counsel. Language here is deliberately factual and non-promotional.
Every technical claim is tied to a repository file path (branch `m4`, commit `622030a`).
Every terms claim is tied to a URL and an effective date, with load-bearing text quoted
verbatim.

**How to read the terms sections.** Each vendor sub-section separates three things that must
not be conflated: **[SAY]** what the written terms state, **[SHOWN]** what enforcement has
actually done, and **[AMBIGUOUS]** what the text does not resolve and only counsel can call.

---

## 1. Executive summary (one page)

The byok-sdk connects a hosted product ("the operator's SaaS") to coding agents that run on
the **end user's own machine**. For Anthropic's Claude and OpenAI's Codex, it does this by
**spawning the user's own, already-installed, already-logged-in official CLI binary** in that
CLI's own supported headless mode. It is a launcher, not a proxy.

**What the SDK does:**

- Spawns the user's own `claude` / `codex` binary found on `PATH` (or via an explicit
  test-only override env var), passing **only official, documented-or-empirically-confirmed
  CLI flags**.
- Runs each binary in its **own official non-interactive mode** (`claude -p --input-format
  stream-json`; `codex exec --json`).
- Maps the operator's permission policy onto **the binary's own official permission flags**
  (`--permission-mode`, and in M4 the official `--permission-prompt-tool` + MCP approval
  mechanism for Claude; `-c sandbox_mode` / `-c approval_policy` for Codex).
- Isolates state **per product** under `~/.byok/<productId>/` and writes an **append-only,
  secret-redacted audit log**.
- Requires the user to **initiate pairing** themselves from their own machine
  (`byok-agent pair <code> --server <url>`).

**What the SDK does NOT do (each verified in code — see §2):**

- It does **not** read, copy, proxy, forward, or transmit `~/.claude`, `~/.codex`, or any
  OAuth token / API key. The credential never leaves the user's machine and never touches
  the operator's infrastructure. The official binary authenticates itself directly to the
  vendor.
- It does **not** offer or broker a Claude.ai / ChatGPT login.
- It does **not** spoof client identity (it does not inject the Claude Code beta header or
  impersonate the official harness); it runs the **genuine** binary with the vendor's own
  telemetry intact.
- It does **not** pool, share, or multiplex multiple users' accounts through one credential.

**Bottom line for counsel.** The architecture is deliberately built to sit on the **opposite
side** of the specific conduct Anthropic enforced against in January 2026 (OAuth-token
extraction and client-identity spoofing — see §3). That is a strong, defensible technical
distinction. **However**, Anthropic's own Claude Code legal page repeatedly qualifies
permitted subscription use as **"ordinary, individual usage,"** and a commercial SaaS that
dispatches tasks to users' machines does not cleanly satisfy that phrase. Anthropic has also
shown it will change terms and enforce **without prior notice**. The residual risk is
therefore **not** the enforcement mechanism (the SDK avoids it) but the **interpretation of
"ordinary, individual usage" applied to third-party orchestration**, which the written terms
do not resolve. OpenAI's posture is more permissive (subscription CLI/`exec` use is
officially supported), and the `pi` adapter (MIT, third-party open source) carries **zero**
vendor-ToS exposure.

**Correction to a working assumption.** An API-key-based fallback switch (a "compliance
escape hatch") was assumed to already exist. It does **not**: it is absent from source, tests,
and docs on branch `m4` — not implemented, not stubbed, not even a TODO (§2, item 6). Any
gating posture that leans on it must treat it as **work to be built**, not an existing hedge.

---

## 2. Technical facts inventory

Each claim below is tied to a repository path. Snippets are quoted only where the exact text
is load-bearing.

**1. Spawn-only, user's own binary, PATH-resolved.**
`packages/client/src/adapters/claude/resolve-bin.ts:28-34` resolves `claude` from `PATH`
(or the `BYOK_CLAUDE_BIN` test override) and nothing else. Its doc-comment
(`resolve-bin.ts:6-27`) states the SDK deliberately does **not** vendor or manage a `claude`
install because "the credential-isolation rule … means this adapter has no business managing
a claude install at all, only spawning whatever `claude` the user already has authenticated
on their PATH." Codex is identical: `packages/client/src/adapters/codex/resolve-bin.ts:26-32`
(`codex` on `PATH`, or `BYOK_CODEX_BIN`).

**2. Credential-isolation rule (the load-bearing invariant).**
`packages/client/src/types.ts:105-114`, doc-comment on `RuntimeAdapter`:
> "Credential-isolation rule: an adapter spawns only the runtime's official binary. It never
> reads, proxies, or forwards that runtime's own credential storage (OAuth tokens, API keys
> on disk, `~/.claude`, `~/.codex`, `~/.pi` auth state, etc). Presence checks are limited to
> environment variable *names*."

A repository-wide grep for reads of those credential paths found **no** `fs.readFile`
targeting `~/.claude`, `~/.codex`, or `~/.pi`. Every occurrence of those path strings is
either the prose rule above or unrelated OS service-lifecycle / device-store paths.

**3. Auth presence is probed via the binary's own non-secret status command, not by reading
credentials.**
- Claude: `packages/client/src/adapters/claude/claude-adapter.ts:315-342` runs
  `claude auth status --json` — "claude's OWN non-secret login-state signal … it never reads
  `~/.claude` or any credential file itself" — and reads only `loggedIn: true/false`.
- Codex: `packages/client/src/adapters/codex/codex-adapter.ts:90-123` runs `codex login
  status` and interprets its human-readable report, "without ever reading `~/.codex/auth.json`."
- pi: `packages/client/src/adapters/pi/pi-adapter.ts:23-45` checks only whether known provider
  env-var **names** are set (never values).

**4. Official flags / official mechanisms only.**
- Claude spawn argv (`claude-adapter.ts:240-253`): `-p --input-format stream-json
  --output-format stream-json --verbose`, plus `--resume <id>` and the policy-mapped flags.
- Claude M4 "confirm" approval (`claude-adapter.ts:196-236`) uses the **official**
  `--permission-prompt-tool` + `--mcp-config` + `--strict-mcp-config` mechanism, pointed at a
  bundled local approval MCP server. The MCP config file it writes carries "no secret/token
  material at all" (a store path, productId, taskId).
- Codex spawn argv (`codex-adapter.ts:267-270`, `permission-mapping.ts:136-137`): `exec` /
  `exec resume <ref>`, `--json`, `--skip-git-repo-check`, `-c sandbox_mode=<…>`,
  `-c approval_policy=never`.

**5. User's own machine + user-initiated pairing.**
`packages/client/src/bin/byok-agent.ts:132-137` and `commands/pair.ts:9-14`: pairing runs only
when the user invokes `byok-agent pair <code> --server <url>` on their own machine; the device
keypair is generated locally (`daemon/auth-manager.ts:71-87`). No auto-pairing / background
enrollment path exists.

**6. API-key / "bare" fallback switch — ABSENT (verified).**
Grep of `packages/` and `docs/` for `bare` mode, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
passthrough, or any API-key-based fallback spawn path returns **no such feature**. The only
`*_API_KEY` occurrences are the env-var **name** list used for presence detection
(`pi-adapter.ts:31-45`) and test fixtures. There is no implementation, stub, or TODO for an
API-key escape hatch on this branch. **This is a design concept, not existing code.**

**7. Per-product daemon isolation.**
`packages/client/src/daemon/store.ts:33-34` roots each product's state at
`~/.byok/<productId>/` (0600 files, 0700 dir); the control socket is derived per-`storeDir`
(`daemon/control-protocol.ts:45-67`); wired in `daemon/create-daemon.ts:268-271`. Distinct
products never share state, sockets, or credentials.

**8. Audit log (append-only, secret-redacted).**
`packages/client/src/bin/audit-log.ts:7-31` writes one JSON line per `DaemonEvent` to
`<storeDir>/audit.jsonl` (0600, size-bounded). Redaction discipline: "only event type,
taskId, timestamps, tool/runtime NAMES, sizes/counts, and closed-enum state fields are ever
written to disk — every free-form text/bytes field is replaced with its byte SIZE." Recorded
events (`daemon/observer.ts:46-94`) include task offered/claimed/started, awaiting-approval,
completed/failed/cancelled, paired/unpaired. A test
(`packages/client/src/__tests__/bin-audit-log.test.ts:72-119`) asserts a planted secret API
key never appears in the log.

---

## 3. Terms analysis per vendor

### 3.1 Anthropic

**Source documents and effective dates (retrieved 2026-07-22):**
- Consumer Terms of Service — <https://www.anthropic.com/legal/consumer-terms> — eff. **Oct 8, 2025**
- Commercial Terms of Service — <https://www.anthropic.com/legal/commercial-terms> — eff. **Jun 17, 2025**
- Usage Policy (AUP) — <https://www.anthropic.com/legal/aup> — eff. **Sep 15, 2025**
- Claude Code "Legal and compliance" — <https://code.claude.com/docs/en/legal-and-compliance> (this is the canonical, Claude Code-specific page; undated on-page)

**[SAY] Consumer Terms §3 — prohibited automated access, with a carveout.**
> "Except when you are accessing our Services via an Anthropic API Key or where we otherwise
> explicitly permit it, to access the Services through automated or non-human means, whether
> through a bot, script, or otherwise."

Reading: consumer-plan access "through … a bot, script, or otherwise" is prohibited **unless**
(a) via an API key, **or** (b) "where we otherwise explicitly permit it." Anthropic ships and
documents `claude -p` headless mode as an official scripted-use surface, which is an argument
that headless use is "explicitly permitted." Whether that permission extends to a **third
party orchestrating** that mode is the open question (§5).

**[SAY] Consumer Terms §3 — no competing/reselling.**
> "To develop any products or services that compete with our Services, including to develop or
> train any artificial intelligence or machine learning algorithms or models or resell the
> Services."

Reading: the SDK is not a competing model/service and does not resell access; low direct
exposure, but noted for completeness.

**[SAY] Consumer Terms §2 — evaluation is personal/non-commercial.**
> "Use of our Services for evaluation purposes are for your personal, non-commercial use only."

Reading: on its face this "personal, non-commercial" limit is scoped to **evaluation /
additional services**, not the whole consumer plan. Counsel should confirm whether a broader
commercial-use restriction on Free/Pro/Max exists elsewhere (§5, Q4).

**[SAY] Claude Code Legal & compliance page — the most on-point text.**
> "Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of
> Claude Code and the Agent SDK."

> "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max,
> Team, and Enterprise subscription plans and is designed to support **ordinary use of Claude
> Code and other native Anthropic applications**."

> "**Developers** building products or services that interact with Claude's capabilities,
> including those using the Agent SDK, should use API key authentication through Claude Console
> or a supported cloud provider. **Anthropic does not permit third-party developers to offer
> Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of
> their users.**"

> "Anthropic reserves the right to take measures to enforce these restrictions and may do so
> **without prior notice**."

Reading — this cuts two ways:
- **Favorable:** the explicit prohibition names two acts — (i) *offer Claude.ai login* and
  (ii) *route requests through Free/Pro/Max credentials on behalf of users*. The SDK does
  **neither** in the infrastructure sense: it never brokers a login and never receives,
  stores, carries, or transmits the credential or the model request — the user's own official
  binary makes the credentialed request directly to Anthropic. On the narrow reading (the one
  matching the January enforcement target), "route requests through credentials" means the
  developer's servers carry/use the token; the SDK's servers do not.
- **Unfavorable / ambiguous:** the page thrice qualifies permitted use as "ordinary,
  individual usage" / "ordinary use." A commercial SaaS dispatching tasks to users' machines
  is not obviously "ordinary, individual." A broad reading of "route requests … on behalf of
  their users" could also be stretched to cover *causing* credentialed requests to be made on
  behalf of a third-party service, even without touching the token. Only counsel can resolve
  which reading governs (§5, Q1–Q3).

**[SAY] Commercial Terms — the API-key path is expressly permissive.**
- §A.1: "Subject to these Terms, Anthropic gives Customer permission to use the Services,
  **including to power products and services Customer makes available to its own customers and
  end users**."
- §D.4: "Customer may not … (a) access the Services to build a competing product or service,
  including to train competing AI models or resell the Services except as expressly approved by
  Anthropic …"

Reading: an **API-key-authenticated** deployment (Console / Bedrock / Vertex) is squarely
permitted to power downstream products. This is why the (currently non-existent) API-key
fallback matters as a compliance hedge — it converts the ambiguous consumer path into a
clearly permitted commercial one.

**[SAY] Usage Policy.** Agentic use cases "must still comply with the Usage Policy"; no
Claude Code-specific prohibition in the AUP text itself.

**[SHOWN] Enforcement — January / February 2026.**
Reported timeline (secondary sources; corroborated across multiple outlets incl. The
Register, <https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/>):
- **Jan 9, 2026:** Anthropic began blocking OAuth tokens from Pro/Max subscriptions when used
  in **third-party tools** (OpenCode, OpenClaw, Cline, RooCode, et al.). Server message:
  "This credential is only authorized for use with Claude Code and cannot be used for other
  API requests."
- The technical trigger was tools **spoofing the Claude Code client identity** — sending the
  `claude-code-20250219` beta header to impersonate the official CLI — plus **using extracted
  OAuth tokens in other products**. Anthropic deployed client-identity verification and
  rejected non-genuine clients.
- **Feb ~19, 2026:** Anthropic updated the legal/compliance documentation to state the rule in
  plain language, widely quoted as: "Using OAuth tokens obtained through Claude Free, Pro, or
  Max accounts in any other product, tool, or service — including the Agent SDK — is not
  permitted and constitutes a violation of the Consumer Terms of Service."

**Why this matters for the SDK:** the enforced conduct was **token extraction + client
spoofing + use-in-another-product**. The byok-sdk does none of these — it runs the **genuine**
binary, on the user's machine, with the **credential never extracted** and telemetry/client
identity **intact** (§2 items 2–4). The SDK is thus **distinguishable from the banned class on
the exact axis Anthropic enforced.** That is the single strongest point in its favor.

**[AMBIGUOUS] for Anthropic:** whether third-party *orchestration of the genuine binary*
(no token touched, no spoofing) is "ordinary, individual usage"; whether "explicitly permit it"
in Consumer §3 reaches third-party-triggered headless runs; and whether commercial dispatch of
a personal subscription implicates any commercial-use limit. See §5.

### 3.2 OpenAI / Codex

**Source documents (retrieved 2026-07-22):**
- Codex authentication docs — <https://learn.chatgpt.com/docs/auth> (redirected from
  developers.openai.com/codex/auth)
- Using Codex with your ChatGPT plan — OpenAI Help Center, article 11369540

**[SAY] Subscription CLI use is officially supported.**
> "When you sign in with ChatGPT, Codex usage follows your ChatGPT workspace permissions,
> role-based access control (RBAC), and ChatGPT Enterprise retention and residency settings."

Non-interactive/scripted use is contemplated, with cautions:
> "Access tokens are intended for **trusted scripts, schedulers, and private CI runners**."
> "API keys are still the recommended default for automation."
> "Don't expose Codex execution in **untrusted or public environments**."

Reading: OpenAI's posture is materially **more permissive** than Anthropic's — running
`codex` / `codex exec` under a ChatGPT subscription from the terminal is an officially
supported path, and there is no OpenAI equivalent of Anthropic's explicit "no third-party
developers … on behalf of their users" clause. The live cautions are about **trust boundary**
("trusted," "private," not "untrusted or public") and about **account pooling** (greyer area
per secondary sources). The SDK's model — the user's own subscription, on the user's own paired
machine, per-product isolated, no pooling — fits the "trusted / private" framing better than a
public multi-tenant runner would. Residual exposure is lower than Anthropic's, but the
"untrusted/public environment" and pooling questions still warrant counsel sign-off (§5, Q6).

---

## 4. Risk register

Likelihood × Severity are qualitative. "Mitigation" flags whether the control **exists today**.

| # | Risk | Likelihood | Severity | Mitigation (and current state) |
|---|------|-----------|----------|-------------------------------|
| R1 | Anthropic tightens/clarifies terms to explicitly bar third-party spawn/orchestration of Claude Code even when credential-isolated | Medium (fast, unilateral track record) | High (kills the Claude public path) | (a) API-key fallback switch — **NOT YET BUILT**, must be implemented; (b) `pi` (MIT) floor — **exists**, zero exposure; (c) ship Claude adapter **off by default / operator opt-in**; (d) obtain written permission via contact-sales |
| R2 | Account termination lands on the **end user** for "automated means" / non-ordinary usage | Low–Medium | High (user harm + reputational) | Pairing-time disclosure & consent (**needs to be added**); genuine binary + intact telemetry, no spoofing (**exists**, §2); API-key path option (**not built**) |
| R3 | "ordinary, individual usage" reinterpreted to exclude SaaS-dispatched tasks | Medium | High | No account pooling; per-product daemon isolation + audit log demonstrate individual, non-pooled use (**exists**, §2 items 7–8); API-key fallback (**not built**) |
| R4 | Enforcement via client-identity/telemetry checks catches the SDK | Low (SDK runs genuine binary, no header spoofing) | High if it occurred | Architecture already avoids spoofing; **maintain** it — never inject the Claude Code beta header or impersonate the harness (**exists / must be preserved as an invariant**) |
| R5 | The relied-upon mitigation (API-key fallback) does not exist | Certain (verified absent, §2 item 6) | Medium (leaves R1/R3 un-hedged) | Build the API-key switch before public Claude/Codex ship; until then rely on `pi` floor + adapter-off default |
| R6 | OpenAI "untrusted/public environment" or account-pooling guidance breached | Low–Medium | Medium | SDK runs on the user's own paired machine, not a public multi-tenant runner; per-product isolation (**exists**); document the trust boundary and no-pooling design |
| R7 | Commercial-use tension when a personal consumer subscription performs commercial work | Low–Medium | Medium | For commercial deployments, steer operators to Commercial/Team/Enterprise + API-key path (Commercial Terms A.1 expressly permits powering products); surface plan-type guidance at pairing (**needs product work**) |

---

## 5. Open questions for counsel

Numbered; these are the calls only a lawyer can make.

1. **"Explicitly permit" scope.** Does Anthropic shipping and documenting `claude -p` headless
   mode constitute the Consumer Terms §3 carveout "where we otherwise explicitly permit it" for
   a **third party** that spawns that mode on the user's own machine — credential never leaving
   the machine, client identity/telemetry intact — or is such third-party-triggered headless
   use still prohibited "automated or non-human means"?
2. **"ordinary, individual usage."** Does the Claude Code legal page's "ordinary, individual
   usage" / "ordinary use of Claude Code" qualifier exclude a commercial SaaS that dispatches
   tasks to a user's machine, even when each user runs their **own individual** subscription
   and credential? Is there a structural or volume threshold that turns "individual" into "not
   individual"?
3. **"route requests through … credentials on behalf of their users."** Does this prohibition
   reach an architecture where the developer's infrastructure **never** receives, stores,
   carries, or transmits the credential or the model request (the user's own official binary
   makes the credentialed request directly to Anthropic), or is it confined to
   credential-carrying/proxying architectures — i.e., the OAuth-extraction class that was
   actually enforced against?
4. **Personal vs commercial on consumer plans.** Does dispatching a user's **personal** Pro/Max
   subscription to perform work for a commercial product implicate any "personal,
   non-commercial" limitation, given the explicit "personal, non-commercial" text appears
   scoped to evaluation services? Is there a separate commercial-use restriction on Free/Pro/Max
   that applies?
5. **Pre-launch assurance.** Given Anthropic "reserves the right to … enforce these restrictions
   … without prior notice" and ran a Jan-2026 enforcement → Feb-2026 terms-update sequence, what
   written assurance (contact-sales confirmation, an enterprise agreement, or express written
   permission) should be obtained **before** public launch so the account-termination risk does
   not land on end users?
6. **OpenAI / Codex.** Does OpenAI's "trusted scripts, schedulers, and private CI runners" /
   "don't expose Codex execution in untrusted or public environments" guidance permit a
   third-party SaaS to trigger `codex exec` on a user's machine under the user's ChatGPT
   subscription? Does an "account pooling" concern arise when many users each connect their own
   individual subscription through one operator?
7. **Liability & disclosure.** If a vendor enforces against an end user's account for using this
   SDK, where does contractual liability sit (operator vs end user), and what disclosure/consent
   must the SDK surface to the user **at pairing time**?

---

## 6. Recommended gating posture (recommendation — orchestrator/user + counsel decide)

**Ship publicly as-is (no counsel sign-off required for the ToS axis):**
- The SDK core, protocol, server, operator CLI, and the **`pi` adapter** (MIT, third-party
  open-source agent). The `pi` path has **zero** Anthropic/OpenAI ToS exposure and is the safe
  public floor.

**Gate behind counsel sign-off before public release:**
- The **Claude adapter** — highest residual risk, driven by the "ordinary, individual usage"
  framing plus Anthropic's demonstrated willingness to change terms and enforce without notice.
  Recommend it ship **off by default / operator opt-in** even after sign-off, so the operator
  elects the ToS-exposed path with informed consent.
- The **Codex adapter** — lower risk (subscription CLI/`exec` use is officially supported), but
  still counsel-gated on the "untrusted/public environment" and account-pooling questions
  (§5, Q6). Also recommend opt-in.

**Build before public Claude/Codex ship (currently missing):**
- The **API-key fallback switch** (§2 item 6) — today it does not exist. It is the mechanism
  that converts the ambiguous consumer path into the expressly-permitted commercial path
  (Commercial Terms A.1). Until it exists, R1/R3 have no real hedge beyond the `pi` floor and
  the adapter-off default.
- **Pairing-time ToS disclosure & consent** surfaced to the end user (supports R2/R7).
- Preserve, as a hard invariant, the **no-credential-access / no-client-spoofing** design
  (§2 items 2–4); it is the SDK's strongest protection and must never regress.

**Internal dogfood may proceed meanwhile (this brief does not gate it):**
- Internal dogfooding with the Claude/Codex adapters is reasonable to continue, provided each
  dogfooder uses **their own individual subscription on their own machine** (no shared/pooled
  accounts) and telemetry/audit remain intact — i.e., the usage that most closely matches
  "ordinary, individual usage." This keeps internal iteration moving while counsel reviews the
  public-release questions.

**One-line recommendation:** Public-release the `pi` path now; hold the Claude and Codex
adapters behind counsel sign-off and behind an opt-in default; build the (currently absent)
API-key fallback and pairing-time disclosure before any public Claude/Codex enablement.
Confidence: **MEDIUM** — the technical distinction from the enforced conduct is strong and
verified, but the governing terms are genuinely ambiguous on commercial third-party
orchestration and only counsel can close that gap.

---

DRAFT — pending counsel review; gate: public release blocked until sign-off recorded here.
