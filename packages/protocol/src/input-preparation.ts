import { z } from 'zod';
import { AgentEgressContentHashSchema } from './agent-egress';
import { PERMISSION_MODES } from './permission';

/**
 * Remote authenticated runtime input preparation — the wire half of
 * `docs/researches/runtime-input-preparation-contract.md` §19 (channel shape)
 * and the C07 G4 design decision §17 B.
 *
 * This module owns ONLY the leaf shapes. The server -> device payload lives in
 * `messages.ts` beside every other message payload (so the one inline byte
 * bound `MAX_INLINE_BYTES` stays a single module-local authority), and the two
 * authenticated HTTP bodies live in `http-api.ts`.
 *
 * Three structural rules this surface exists to hold:
 *
 * 1. The request carries NO tools, NO tool executors and NO runtime identity.
 *    Those are LOCAL observations: only the device can honestly say which MCP
 *    toolsets it has, what schemas their servers publish, and which native
 *    package closure is installed. A Host that could state them would be
 *    stating an identity it cannot verify.
 * 2. The receipt summary discloses identities, digests, sizes, counter
 *    evidence and readiness — never D, never P(D), never the snapshot. A
 *    digest proves content identity; it is not a disclosure channel and not a
 *    bearer token (§10.3.4).
 * 3. Every shape here is `.strict()`. This is control data: an unrecognized
 *    field must be REJECTED, not silently stripped, per docs/protocol.md's
 *    freeze-rule asymmetry. Adding a field post-freeze is therefore a
 *    breaking change, exactly like `PermissionPolicySchema`.
 */

/** Capability required before a task-free remote input preparation is admitted. */
export const AGENT_INPUT_PREPARATION_CAPABILITY = 'agent-input-preparation' as const;

/** The preparation surface uses the package-wide lowercase `sha256:<hex>` transport form. */
export const InputPreparationContentHashSchema = AgentEgressContentHashSchema;

/**
 * Opaque, non-empty, single-line control identifiers (policy revision, profile
 * id, model id, reference, digest, ...). The SDK never interprets these; it
 * only refuses values that could not survive being a key, a log line or a
 * pathname component.
 */
const OPAQUE_ID = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'control identifiers must not contain control characters');

/** Longer opaque text that is still one line — base URLs, method names, endpoints. */
const OPAQUE_TEXT = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'control text must not contain control characters');

/**
 * The operator-assigned limits-policy revision a device must already hold. The
 * SDK compares it for exact equality and never negotiates it: a device whose
 * configured revision differs rejects rather than preparing under a policy the
 * caller believed was in force.
 */
export const InputPreparationPolicyRevisionSchema = OPAQUE_ID;

/**
 * Host-owned Profile identity. It rides beside `agentRef` rather than inside
 * it because `AgentRefSchema` is the frozen generic Agent identity shared by
 * every other message, and widening that would be a breaking change to all of
 * them. The device never trusts this value directly — its configured local
 * authority resolver validates it against trusted local Profile records before
 * anything is compiled.
 */
export const InputPreparationProfileIdSchema = OPAQUE_ID;

/**
 * The permission mode a preparation is compiled FOR.
 *
 * It is the same closed set every task policy uses (`permission.ts`'s
 * `PERMISSION_MODES`), spelled here as its own schema because a preparation
 * carries a mode without carrying a policy: there is no task, no grant and no
 * approval seam on this wire. The mode selects which tools the device's own
 * observation projects into the counted manifest, and nothing else.
 *
 * Declared by the requester rather than inferred by the device: a device that
 * guessed would be counting a manifest the requester never asked for, and a
 * device that defaulted would silently count the widest one.
 */
export const InputPreparationPermissionModeSchema = z.enum(PERMISSION_MODES);
export type InputPreparationPermissionMode = z.infer<typeof InputPreparationPermissionModeSchema>;

// ---------------------------------------------------------------------------
// Source / selection
// ---------------------------------------------------------------------------

/**
 * The canonical Host source snapshot this input was assembled from. Both
 * values are Host authority carried verbatim so the receipt binds the exact
 * revision/digest a later consumer must re-present. The SDK interprets
 * neither.
 */
export const InputPreparationSourceSchema = z
  .object({ revision: OPAQUE_ID, digest: OPAQUE_ID })
  .strict();
export type InputPreparationSource = z.infer<typeof InputPreparationSourceSchema>;

export const InputPreparationModelCostSchema = z
  .object({
    input: z.number().finite(),
    output: z.number().finite(),
    cacheRead: z.number().finite(),
    cacheWrite: z.number().finite(),
  })
  .strict();

/**
 * The exact model identity the request compiles for.
 *
 * `api` is a single literal, not an open enum: `openai-completions` is the one
 * API the frozen B-P1 native validator admits, and widening it is a
 * registration, not a parser relaxation.
 */
export const InputPreparationModelSchema = z
  .object({
    id: OPAQUE_ID,
    name: OPAQUE_ID,
    api: z.literal('openai-completions'),
    provider: OPAQUE_ID,
    baseUrl: OPAQUE_TEXT,
    reasoning: z.boolean(),
    input: z.array(z.enum(['text', 'image'])).min(1).max(8),
    cost: InputPreparationModelCostSchema,
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  })
  .strict();
export type InputPreparationModel = z.infer<typeof InputPreparationModelSchema>;

/** Body-affecting options only. Transport options are deliberately not on this wire. */
export const InputPreparationOptionsSchema = z
  .object({
    cacheRetention: z.enum(['none', 'short', 'long']),
    maxTokens: z.number().int().positive(),
    temperature: z.number().finite().optional(),
    toolChoice: z.enum(['auto', 'none', 'required']).optional(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .strict();
export type InputPreparationOptions = z.infer<typeof InputPreparationOptionsSchema>;

export const InputPreparationSelectionSchema = z
  .object({ model: InputPreparationModelSchema, options: InputPreparationOptionsSchema })
  .strict();
export type InputPreparationSelection = z.infer<typeof InputPreparationSelectionSchema>;

// ---------------------------------------------------------------------------
// Context document — the Host-authorized half of the compiled snapshot
// ---------------------------------------------------------------------------

/** A path-like value carried verbatim into the native prompt renderer. */
const CONTEXT_PATH = z.string().max(4096).regex(/^[^\u0000]*$/u, 'paths must not contain a NUL character');

export const InputPreparationContextFileSchema = z
  .object({ path: CONTEXT_PATH, content: z.string() })
  .strict();

export const InputPreparationDocsPathsSchema = z
  .object({ readmePath: CONTEXT_PATH, docsPath: CONTEXT_PATH, examplesPath: CONTEXT_PATH })
  .strict();

/**
 * Explicit, already-authorized inputs for the native system prompt renderer.
 *
 * `toolSnippets` is PROMPT TEXT the Host authored — it is not the
 * model-visible tool schemas, which the device observes locally and the Host
 * never states (see this module's rule 1).
 *
 * `selectedTools` is deliberately absent for the same reason one level up: the
 * native contract requires that list to equal the model-visible manifest
 * exactly, so a Host stating it would be stating the manifest. The device
 * fills it from its own assembled tool surface.
 */
export const InputPreparationPromptSnapshotSchema = z
  .object({
    customPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    cwd: CONTEXT_PATH,
    toolSnippets: z.record(z.string(), z.string()),
    promptGuidelines: z.array(z.string()).max(512),
    contextFiles: z.array(InputPreparationContextFileSchema).max(512),
    formattedSkills: z.string(),
    docsPaths: InputPreparationDocsPathsSchema,
  })
  .strict();

/**
 * One model-visible user message. Text-only user history plus the explicit
 * current user message is the whole first support set; assistant/tool-result
 * history and multimodal content are not inferred, they reject.
 */
export const InputPreparationUserMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z.string(),
    timestamp: z.number().int(),
  })
  .strict();

/**
 * What `context.inline` (or the referenced blob) decodes to.
 *
 * Deliberately NOT the whole compiled snapshot: `tools` is absent because the
 * device adds it from its own MCP observation. A Host that could send `tools`
 * could claim a toolset the device does not have.
 */
export const InputPreparationContextDocumentSchema = z
  .object({
    prompt: InputPreparationPromptSnapshotSchema,
    messages: z.array(InputPreparationUserMessageSchema).max(4096),
  })
  .strict();
export type InputPreparationContextDocument = z.infer<typeof InputPreparationContextDocumentSchema>;

// ---------------------------------------------------------------------------
// Receipt summary — the only thing a completion discloses about the artifact
// ---------------------------------------------------------------------------

/** Durable lifecycle state of one local preparation record. */
export const InputPreparationStateSchema = z.enum([
  'reserved',
  'counting',
  'counted',
  'cancelled',
  'failed',
  'counter_interrupted',
]);
export type InputPreparationState = z.infer<typeof InputPreparationStateSchema>;

/**
 * Why a receipt is not ready. An empty list is the only thing that makes
 * `ready` true.
 *
 * `ready` means the preparation CAN BE CONSUMED — the artifact is intact and
 * unexpired, the native compiler's projection is content-complete, every
 * residual key is ruled by an applicable Host accounting policy, the count is
 * present and bound to that exact projection, and every executor identity is
 * attested. It is deliberately NOT Host budget admission: the device performs
 * no budget arithmetic, so a ready receipt says the evidence holds, never that
 * the spend is allowed.
 */
export const InputPreparationReadinessReasonSchema = z.enum([
  'not_counted',
  'counter_interrupted',
  'cancelled',
  'failed',
  'artifact_expired',
  'counter_authority_not_production',
  'counter_coverage_incomplete',
  /** No counter evidence is persisted on the record. */
  'counter_missing',
  /** The native compiler's projection kind is not `content_complete`. */
  'projection_unknown',
  /** The artifact carries a residual key the accounting policy does not rule on. */
  'residual_not_ruled',
  /** The request named no accounting policy. There is no default. */
  'accounting_policy_missing',
  /** The named policy was ruled for a different runtime, endpoint or model. */
  'accounting_policy_inapplicable',
  'executor_identity_unproven',
]);
export type InputPreparationReadinessReason = z.infer<typeof InputPreparationReadinessReasonSchema>;

/**
 * Runtime/compiler identity derived from the VERIFIED installed package
 * closure on the device. A Host never states it and cannot override it.
 */
export const InputPreparationRuntimeIdentitySchema = z
  .object({
    packageName: OPAQUE_ID,
    packageVersion: OPAQUE_ID,
    upstreamBase: OPAQUE_ID,
    upstreamCommit: OPAQUE_ID,
    forkBuild: z.number().int().nonnegative(),
    envelopeFormat: OPAQUE_ID,
    requestFormat: OPAQUE_ID,
    compilerVersion: z.number().int().nonnegative(),
  })
  .strict();
export type InputPreparationRuntimeIdentity = z.infer<typeof InputPreparationRuntimeIdentitySchema>;

export const InputPreparationCounterTargetSchema = z
  .object({ endpoint: OPAQUE_TEXT, modelId: OPAQUE_ID })
  .strict();

/**
 * The Host's ruling about which residual keys of D its accounting already
 * accounts for.
 *
 * Host authority, carried verbatim. The device performs exactly one check
 * against it — APPLICABILITY — and never any budget arithmetic: every residual
 * key the artifact carries must be named here, and the ruling must have been
 * made for this preparation's own runtime identity and endpoint/model. There
 * is no default: a request that names none produces a receipt carrying
 * `accounting_policy_missing`, because "nobody ruled" and "everything is
 * ruled" are different facts.
 */
export const InputPreparationAccountingPolicyRefSchema = z
  .object({
    revision: OPAQUE_ID,
    /** The runtime identity string this ruling was made for. */
    ruledRuntime: OPAQUE_ID,
    /** The endpoint/model this ruling was made for. */
    ruledTarget: InputPreparationCounterTargetSchema,
    /** Every residual key the Host's accounting already accounts for. */
    ruledResidualKeys: z.array(OPAQUE_ID).max(64),
  })
  .strict();
export type InputPreparationAccountingPolicyRef = z.infer<typeof InputPreparationAccountingPolicyRefSchema>;

/**
 * What the provider side of a count asserted, and which exact projection it
 * was asserted about.
 *
 * Required, fixture included: a number without the identity of the bytes it
 * was taken over is not evidence. The device compares `projectionDigest`
 * against the artifact's own projection digest and `endpoint`/`modelId`
 * against the counted target, and refuses the count outright on a mismatch.
 *
 * `asserted` is the provider's own answer, stored and never second-guessed —
 * re-deriving a usage number locally is the shadow accounting this surface
 * exists to avoid. It carries no output or whole-request field: the Host holds
 * its own request, and `binding.requestDigest` is the check that ties the two.
 */
export const InputPreparationCounterProviderEvidenceSchema = z
  .object({
    projectionDigest: z.string().regex(/^[0-9a-f]{64}$/u, 'a projection digest is lowercase sha-256 hex'),
    endpoint: OPAQUE_TEXT,
    modelId: OPAQUE_ID,
    asserted: z
      .object({
        httpStatus: z.number().int(),
        usageFields: z.record(OPAQUE_ID, z.number().finite()),
        responseDigest: OPAQUE_ID,
      })
      .strict(),
  })
  .strict();

/**
 * Counter evidence exactly as the device's adapter reported it.
 *
 * `authority: 'test_fixture'` is a first-class value, not a debug flag: a
 * fixture result can never produce a ready receipt, which is what keeps an
 * offline suite from ever looking like production accounting evidence.
 */
export const InputPreparationCounterEvidenceSchema = z
  .object({
    method: OPAQUE_ID,
    methodVersion: OPAQUE_ID,
    authority: z.enum(['provider', 'test_fixture']),
    kind: z.enum(['count', 'bound']),
    value: z.number().int().nonnegative(),
    coverage: z
      .object({ covered: z.boolean(), reason: z.string().max(512).optional() })
      .strict(),
    providerEvidence: InputPreparationCounterProviderEvidenceSchema,
    target: InputPreparationCounterTargetSchema,
    calledAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * What the device established about the implementation behind ONE
 * model-visible tool: `attested`, or `unavailable:<reason>` naming which of
 * the SDK's closed unavailable reasons applies.
 *
 * A kind, never the identity itself: an install path, a closure digest or a
 * stat tuple is device-local filesystem detail, and a receipt discloses
 * identity facts, not the machine's layout.
 */
export const InputPreparationToolImplementationKindSchema = z
  .string()
  .regex(/^(?:attested|unavailable:[a-z_]{1,64})$/u, 'a tool implementation kind is "attested" or "unavailable:<reason>"');

/**
 * What the native compiler proved about ONE top-level key of D that lies
 * outside P(D).
 *
 * These classes describe STRUCTURE and nothing else. No class states, implies
 * or denies that a key influences a provider's token count — that is an
 * external accounting fact the compiler cannot prove — which is exactly why
 * the device re-derives nothing from them and routes the question to the
 * Host's own {@link InputPreparationAccountingPolicyRefSchema}.
 */
export const InputPreparationResidualValueClassSchema = z.enum([
  'constant',
  'boolean',
  'bounded_integer',
  'bounded_number',
  'finite_number',
  'closed_enum',
  'nonempty_string',
  'object_shape',
]);
export type InputPreparationResidualValueClass = z.infer<typeof InputPreparationResidualValueClassSchema>;

export const InputPreparationResidualKeySchema = z
  .object({ key: OPAQUE_ID, valueClass: InputPreparationResidualValueClassSchema })
  .strict();

/**
 * What the native compiler proves about P(D), copied verbatim off the envelope.
 *
 * `content_complete` — every context-derived byte of D is byte-identically
 * inside P(D), and every remaining top-level key was classified. `unknown` —
 * the compiler failed closed, claims nothing, and leaves `residual` empty.
 *
 * `digest` is sha-256 over the exact counted-projection bytes. The device
 * recomputes it and refuses the artifact on a mismatch; it never recomputes
 * the KIND, because the classification table belongs to the compiler and a
 * local copy of it would be a shadow parser for the same semantic fact.
 */
export const InputPreparationProjectionSchema = z
  .object({
    version: z.literal(2),
    kind: z.enum(['content_complete', 'unknown']),
    digest: z.string().regex(/^[0-9a-f]{64}$/u, 'a projection digest is lowercase sha-256 hex'),
  })
  .strict();

/**
 * Identities, sizes and the native compiler's structural projection contract.
 * Never D, never P(D), never the snapshot.
 *
 * The three tool-surface fields are what make drift between preparation and
 * launch checkable rather than assumed:
 *
 * - `observationDigest` binds everything the device OBSERVED — the projected
 *   tools, their executor fingerprints, the launch attestation and the
 *   implementation identities — so a launch whose live observation differs is
 *   a different manifest, whatever the schemas say.
 * - `toolBindingDigest` binds only the facts that can be re-derived WITHOUT
 *   spawning a server: the launch attestation, the toolset definition
 *   revisions and the implementation identities. It is what a replay of an
 *   already-recorded requestId compares against, because re-probing to detect
 *   drift would be the second executor fact the idempotency key exists to
 *   prevent.
 * - `toolImplementationKinds` states, per model-visible tool name, whether the
 *   implementation behind it was attested. It is the evidence behind
 *   `executor_identity_unproven`, so a reader does not have to take that
 *   readiness reason on trust.
 */
export const InputPreparationArtifactSummarySchema = z
  .object({
    requestDigest: OPAQUE_ID,
    envelopeDigest: OPAQUE_ID,
    toolManifestDigest: OPAQUE_ID,
    requestBytes: z.number().int().nonnegative(),
    projectionBytes: z.number().int().nonnegative(),
    projection: InputPreparationProjectionSchema,
    residual: z.array(InputPreparationResidualKeySchema).max(64),
    observationDigest: OPAQUE_ID,
    toolBindingDigest: OPAQUE_ID,
    toolImplementationKinds: z.record(OPAQUE_ID, InputPreparationToolImplementationKindSchema),
  })
  .strict();

/** The immutable binding a receipt carries and a later consumer must re-present. */
export const InputPreparationBindingSchema = z
  .object({
    scopeId: OPAQUE_ID,
    deviceId: OPAQUE_ID,
    agentRef: OPAQUE_ID,
    profileId: OPAQUE_ID,
    profileRevision: OPAQUE_ID,
    source: InputPreparationSourceSchema,
    target: InputPreparationCounterTargetSchema,
    policyRevision: OPAQUE_ID,
    /**
     * The mode the counted manifest was filtered for. Recorded on the binding
     * rather than only inside the request digest so a consumer can COMPARE it
     * without re-deriving the digest: an Execution offered under a different
     * mode is an Execution whose registered tool set differs from the one
     * these tokens were counted for.
     */
    permissionMode: InputPreparationPermissionModeSchema,
    runtime: InputPreparationRuntimeIdentitySchema,
    requestDigest: OPAQUE_ID,
    /**
     * The Host's accounting ruling this preparation was requested under,
     * copied verbatim. Absent when the request named none — never filled in,
     * and never narrowed to one the device would have chosen.
     */
    accountingPolicyRef: InputPreparationAccountingPolicyRefSchema.optional(),
  })
  .strict();

/**
 * The exact receipt projection a device reports back.
 *
 * `reference` names the record inside the device-local authenticated scope
 * that created it. It is not a capability: local lookup re-resolves authority
 * on every call and derives the record key from the trusted grant.
 */
export const InputPreparationReceiptSummarySchema = z
  .object({
    reference: OPAQUE_ID,
    state: InputPreparationStateSchema,
    binding: InputPreparationBindingSchema,
    artifact: InputPreparationArtifactSummarySchema.optional(),
    counter: InputPreparationCounterEvidenceSchema.optional(),
    ready: z.boolean(),
    readinessReasons: z.array(InputPreparationReadinessReasonSchema).max(16),
    detail: OPAQUE_ID.optional(),
    artifactExpiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    // `ready` is a derived fact, never an independently asserted one. Letting
    // the two disagree on the wire would make a not-ready receipt admissible
    // by simply flipping a boolean.
    if (value.ready !== (value.readinessReasons.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ready'],
        message: 'ready must be true exactly when readinessReasons is empty',
      });
    }
  });
export type InputPreparationReceiptSummary = z.infer<typeof InputPreparationReceiptSummarySchema>;

// ---------------------------------------------------------------------------
// Offer binding — what a prepared Execution names on the offer wire
// ---------------------------------------------------------------------------

/**
 * The device-local reference one receipt answered with
 * ({@link InputPreparationReceiptSummarySchema}'s `reference`).
 *
 * The same opaque identifier, spelled as its own schema so the offer wire and
 * the receipt wire cannot drift into two definitions of one value. It is NOT a
 * capability: the device re-resolves authority on every lookup and derives the
 * record key from its own trusted grant, so presenting another scope's
 * reference finds nothing.
 */
export const InputPreparationReferenceSchema = OPAQUE_ID;

/**
 * The preparation a `task.offer_prepared` names, re-presented by the Host from
 * the receipt it was given.
 *
 * Nothing here is authority. Every value is COMPARED against the device's own
 * durable record before an Execution is admitted, and a difference declines the
 * offer non-retryably — a Host that could state a binding would be stating what
 * this device counted.
 *
 * `artifactDigest` is optional for one structural reason, not as a compatibility
 * seam: a receipt discloses `artifact` only once there is one
 * ({@link InputPreparationArtifactSummarySchema} is optional on the receipt), so
 * a Host holding a not-yet-counted receipt has no envelope digest to re-present.
 * When it is present it is compared like everything else.
 */
export const InputPreparationOfferBindingSchema = z
  .object({
    reference: InputPreparationReferenceSchema,
    /** `InputPreparationBindingSchema.requestDigest`, as the receipt reported it. */
    requestDigest: OPAQUE_ID,
    /** `InputPreparationArtifactSummarySchema.envelopeDigest`, when the receipt carried one. */
    artifactDigest: OPAQUE_ID.optional(),
  })
  .strict();
export type InputPreparationOfferBinding = z.infer<typeof InputPreparationOfferBindingSchema>;

/**
 * Why a device refused to prepare at all. These are the device-owned typed
 * rejections; none of them ever accompanies an artifact.
 *
 * `input_preparation_unconfigured` is the answer from a device that advertised
 * nothing: the whole surface is off there. It is reported rather than thrown so
 * one mis-targeted request cannot freeze the device's mailbox cursor behind it.
 */
export const InputPreparationRejectionReasonSchema = z.enum([
  'input_preparation_unconfigured',
  'bad_request',
  'authority_unavailable',
  'scope_denied',
  'policy_revision_mismatch',
  'runtime_identity_unavailable',
  'unsupported_input',
  'limit_exceeded',
  'request_conflict',
  'not_found',
  'counter_unavailable',
  'counter_interrupted',
  'durable_write_failed',
  'cancelled',
  'context_unresolvable',
  'context_hash_mismatch',
  'toolsets_unobservable',
  'deadline_elapsed',
  /**
   * The device could not prove a non-writable launch directory (or a trusted
   * launcher) for the MCP toolset servers this preparation names, so it
   * refused rather than observing them in a directory the agent's own uid can
   * write. The specific `TrustedLaunchCwdUnavailableReason` travels in the
   * receipt's `detail`; it is not widened into a spawn.
   */
  'launch_boundary_unavailable',
  /**
   * A repeat of an already-recorded `requestId` arrived after the facts its
   * executor fingerprints were frozen against changed — a toolset definition
   * revision, the launch attestation, or an implementation identity that no
   * longer measures the same. The recorded receipt is not re-derived and no
   * server is re-probed; the repeat is refused so the caller mints a new
   * preparation instead of silently receiving one bound to stale evidence.
   */
  'observation_drift',
  /**
   * The declared `permissionMode` is not one this device admits: it exceeds
   * the operator's configured ceiling. The requester's declaration is INTENT,
   * not authorization — it goes through the same merge that admits a task
   * offer's `policy.mode` — and an unadmitted mode refuses rather than being
   * silently narrowed to one the device would allow.
   */
  'permission_mode_denied',
  /**
   * The device compiled the input, then found that the `prompt_prepared` frame
   * the runtime would have to be handed exceeds the single-frame byte cap that
   * runtime enforces. The bound belongs to the runtime, not to the operator's
   * retention policy, so it is decided first and nothing is retained: a
   * preparation that could never be delivered is not a smaller preparation.
   */
  'rpc_frame_too_large',
]);
export type InputPreparationRejectionReason = z.infer<typeof InputPreparationRejectionReasonSchema>;
