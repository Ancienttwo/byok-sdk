// ==== @byok-sdk/cloud dist/activity.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from '@byok-sdk/core';
import { type TenantId } from '@byok-sdk/core';
import { type AgentEventOrUnknown, type SealedPayload } from '@byok-sdk/protocol';
import { z } from 'zod';
export declare const DEFAULT_ACTIVITY_CAPACITY = 50;
export declare const ActivityAppendRequestSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    batchSeq: z.ZodNumber;
    events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        input: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        output: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodBoolean>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"artifact">;
        name: z.ZodString;
        contentType: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"turn_end">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"usage">;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        contextTokens: z.ZodOptional<z.ZodNumber>;
        contextWindow: z.ZodOptional<z.ZodNumber>;
        contextSource: z.ZodOptional<z.ZodEnum<{
            estimate: "estimate";
            provider: "provider";
        }>>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">, z.ZodObject<{
        type: z.ZodString;
    }, z.core.$loose>]>>;
    dropped: z.ZodNumber;
}, z.core.$strip>;
export declare const TimelineEventSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    batchSeq: z.ZodNumber;
    eventIndex: z.ZodNumber;
    sourceDropped: z.ZodOptional<z.ZodNumber>;
    receivedAt: z.ZodISODateTime;
    event: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        input: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        output: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodBoolean>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"artifact">;
        name: z.ZodString;
        contentType: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"turn_end">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"usage">;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        contextTokens: z.ZodOptional<z.ZodNumber>;
        contextWindow: z.ZodOptional<z.ZodNumber>;
        contextSource: z.ZodOptional<z.ZodEnum<{
            estimate: "estimate";
            provider: "provider";
        }>>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">, z.ZodObject<{
        type: z.ZodString;
    }, z.core.$loose>]>;
}, z.core.$strip>;
export type TimelineEvent = Readonly<z.infer<typeof TimelineEventSchema>>;
/**
 * One sealed batch in the tail (#654 12e). A sealed member covers the whole
 * batch, so the tail keeps one entry for it, and the tail capacity counts
 * batches. `eventIndex` is always 0, so the order key of a batch is the same
 * as for its first plaintext event. A member opens `sealed`.
 */
export declare const SealedActivityBatchSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    batchSeq: z.ZodNumber;
    eventIndex: z.ZodLiteral<0>;
    sourceDropped: z.ZodOptional<z.ZodNumber>;
    receivedAt: z.ZodISODateTime;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strip>;
export type SealedActivityBatch = Readonly<z.infer<typeof SealedActivityBatchSchema>>;
/** One tail entry: a plaintext event, or a sealed batch. */
export type ActivityTailEntry = TimelineEvent | SealedActivityBatch;
export interface ActivityCursor {
    readonly batchSeq: number;
    readonly eventIndex: number;
}
export interface ActivityTail {
    readonly tenantId: TenantId;
    readonly taskId: string;
    readonly entries: readonly ActivityTailEntry[];
    readonly cursor?: ActivityCursor;
    readonly dropped: number;
    readonly capacity: number;
    readonly expiresAt: string;
}
interface ActivityAppendFields {
    readonly taskId: string;
    readonly sourceEnvelopeId: string;
    readonly batchSeq: number;
    readonly dropped: number;
    readonly ttlMs: number;
    readonly capacity?: number;
}
/** One batch to append: plaintext events, or one sealed member that covers the batch. */
export type ActivityAppendInput = (ActivityAppendFields & {
    readonly events: readonly AgentEventOrUnknown[];
}) | (ActivityAppendFields & {
    readonly sealed: SealedPayload;
});
export interface ActivityStore {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    /**
     * `sourceEnvelopeId` is the per-envelope idempotency authority. Repeating
     * its exact canonical batch returns the existing tail; changing any batch
     * fact under that identity is rejected rather than appended as a second
     * observation.
     */
    append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
    read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}
export declare function validateActivityAppend(input: ActivityAppendInput): number;
export declare function projectTimelineEvents(input: ActivityAppendInput, receivedAt: string): readonly ActivityTailEntry[];
/**
 * Whether one live tail already contains this source envelope's canonical
 * batch. `conflict` includes a partially retained source: its missing events
 * are not evidence that a different batch may reuse the same source identity.
 */
export declare function activitySourceBatchState(entries: readonly ActivityTailEntry[], input: ActivityAppendInput): 'absent' | 'same' | 'conflict';
export declare function parseTimelineEvents(value: unknown): readonly ActivityTailEntry[];
export declare function compareTimelineEvents(left: ActivityTailEntry, right: ActivityTailEntry): number;
export declare function activityCursor(entries: readonly ActivityTailEntry[]): ActivityCursor | undefined;
export declare function activityTailKey(tenant: TenantId, taskId: string): string;
export {};
// ==== @byok-sdk/cloud dist/agent-execution.d.ts ====
import { z } from 'zod';
/**
 * Persist this validated input before dispatch; the Host owns Turn/generation and outbox.
 *
 * `terminalProjection` is always required (#470). Execution targets either a built-in
 * `runtime` or a device-advertised `harnessId` (not both; harnessId also excludes
 * `dispatchSelection`), so corpus hosted entries that carry only `harnessId` stay
 * expressible through `submitAgentExecution`.
 */
export declare const AgentExecutionInputSchema: z.ZodObject<{
    taskId: z.ZodString;
    deviceId: z.ZodString;
    payload: z.ZodObject<{
        sealed: z.ZodOptional<z.ZodNever>;
        sealing: z.ZodOptional<z.ZodNever>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        agentMemory: z.ZodOptional<z.ZodEnum<{
            none: "none";
            read: "read";
            "read-if-admitted": "read-if-admitted";
            "read-write": "read-write";
            "read-write-if-admitted": "read-write-if-admitted";
        }>>;
        homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        harnessId: z.ZodOptional<z.ZodString>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodNonOptional<z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
            schema: z.ZodCustom<import("@byok-sdk/protocol").ResultSchema, import("@byok-sdk/protocol").ResultSchema>;
        }, z.core.$strict>], "mode">>>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        egressPolicy: z.ZodOptional<z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodObject<{
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
        routineRef: z.ZodOptional<z.ZodNever>;
        instruction: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>>;
        session: z.ZodObject<{
            mode: z.ZodLiteral<"fresh">;
        }, z.core.$strict>;
        preparation: z.ZodOptional<z.ZodNever>;
    }, z.core.$strict>;
    agentMessageContext: z.ZodOptional<z.ZodObject<{
        destinationBinding: z.ZodString;
        freshnessCursor: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type AgentExecutionInput = z.infer<typeof AgentExecutionInputSchema>;
/**
 * The sealed counterpart (#654): the payload is the sealed branch of a fresh
 * `task.offer` with the same rules. Submit it through `submitSealedAgentExecution`.
 */
export declare const SealedAgentExecutionInputSchema: z.ZodObject<{
    taskId: z.ZodString;
    deviceId: z.ZodString;
    payload: z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        agentMemory: z.ZodOptional<z.ZodEnum<{
            none: "none";
            read: "read";
            "read-if-admitted": "read-if-admitted";
            "read-write": "read-write";
            "read-write-if-admitted": "read-write-if-admitted";
        }>>;
        homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        harnessId: z.ZodOptional<z.ZodString>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodNonOptional<z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
            schema: z.ZodCustom<import("@byok-sdk/protocol").ResultSchema, import("@byok-sdk/protocol").ResultSchema>;
        }, z.core.$strict>], "mode">>>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        egressPolicy: z.ZodOptional<z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodObject<{
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
        instruction: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>>;
        sealing: z.ZodObject<{
            scopeId: z.ZodString;
            epoch: z.ZodNumber;
            categories: z.ZodArray<z.ZodEnum<{
                "task-input": "task-input";
                "task-output": "task-output";
            }>>;
        }, z.core.$strict>;
        sealed: z.ZodOptional<z.ZodObject<{
            v: z.ZodLiteral<1>;
            suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
            category: z.ZodLiteral<"task-input">;
            scope: z.ZodObject<{
                id: z.ZodString;
                epoch: z.ZodNumber;
                keyId: z.ZodString;
            }, z.core.$strict>;
            chainHead: z.ZodObject<{
                seq: z.ZodNumber;
                hash: z.ZodString;
            }, z.core.$strict>;
            sender: z.ZodString;
            salt: z.ZodString;
            nonce: z.ZodString;
            paddedLength: z.ZodNumber;
            contentMac: z.ZodString;
            ciphertext: z.ZodOptional<z.ZodString>;
            ciphertextRef: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        routineRef: z.ZodOptional<z.ZodObject<{
            routineId: z.ZodString;
            definitionVersion: z.ZodNumber;
            notAfter: z.ZodString;
        }, z.core.$strict>>;
        session: z.ZodObject<{
            mode: z.ZodLiteral<"fresh">;
        }, z.core.$strict>;
        preparation: z.ZodOptional<z.ZodNever>;
    }, z.core.$strict>;
    agentMessageContext: z.ZodOptional<z.ZodObject<{
        destinationBinding: z.ZodString;
        freshnessCursor: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type SealedAgentExecutionInput = z.infer<typeof SealedAgentExecutionInputSchema>;
// ==== @byok-sdk/cloud dist/agent-home-projections.d.ts ====
/**
 * Durable task-free Agent-home projection facts.
 *
 * Desired projection and completion are deliberately two immutable request
 * receipts.  The receipt store is tenant-scoped and first-write-wins, so the
 * composition does not need a second mutable projection authority merely to
 * survive a process restart.
 */
import { type AgentHomeProjectionPayload, type AgentHomeProjectionCompletionRequest, type AgentHomeProjectionReadback } from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import type { TenantBoundReceipts } from './tenant-stores';
export interface AgentHomeProjectionReceiptInput {
    readonly requestId: string;
    readonly agentRef: AgentHomeProjectionPayload['agentRef'];
    readonly projectionHash: AgentHomeProjectionPayload['projectionHash'];
}
export declare function agentHomeProjectionRequestKey(deviceId: string, agentRef: AgentHomeProjectionPayload['agentRef'], requestId: string): string;
export declare function agentHomeProjectionCompletionKey(deviceId: string, agentRef: AgentHomeProjectionPayload['agentRef'], requestId: string): string;
export declare function sameAgentHomeProjectionRequest(expected: AgentHomeProjectionPayload, actual: AgentHomeProjectionPayload): boolean;
export declare function receiptMatchesAgentHomeProjection(request: AgentHomeProjectionPayload, receipt: AgentHomeProjectionCompletionRequest): boolean;
export declare function statusInputMatchesAgentHomeProjection(request: AgentHomeProjectionPayload, input: AgentHomeProjectionReceiptInput): boolean;
export declare function readAgentHomeProjectionStatus(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, input: AgentHomeProjectionReceiptInput): Promise<AgentHomeProjectionReadback | undefined>;
export declare function recordAgentHomeProjectionCompletion(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, receiptInput: AgentHomeProjectionCompletionRequest): Promise<AgentHomeProjectionReadback>;
// ==== @byok-sdk/cloud dist/agent-memory-projection.d.ts ====
/**
 * Optional hosted Agent-memory projection ports and reference store.
 *
 * Local `MEMORY.md` and `notes/` remain the sole authoring authority. This
 * module only accepts a redacted full snapshot after a host-owned authorizer
 * grants the exact authenticated task identity; it never offers a read,
 * import, merge, history, RAG, or product-fact surface.
 */
import type { TenantId } from '@byok-sdk/core';
import { type AgentMemoryProjectionMutation, type AgentMemoryProjectionReceipt, type AgentMemoryProjectionEraseResult } from '@byok-sdk/protocol';
export type { AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionEraseResult, } from '@byok-sdk/protocol';
export interface AgentMemoryProjectionAuthorizerInput {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly taskId: string;
    readonly agentRef: AgentMemoryProjectionMutation['agentRef'];
    readonly sessionRef: AgentMemoryProjectionMutation['sessionRef'];
    readonly runtimeId: AgentMemoryProjectionMutation['runtimeId'];
    readonly grantRef: AgentMemoryProjectionMutation['grantRef'];
    /** Server-granted active writer epoch; a client may not upgrade it unilaterally. */
    readonly writerEpoch: AgentMemoryProjectionMutation['writerEpoch'];
    readonly policyRevision: AgentMemoryProjectionMutation['policyRevision'];
}
export type AgentMemoryProjectionAuthorization = {
    readonly outcome: 'authorized';
} | {
    readonly outcome: 'denied';
    readonly reasonCode: string;
};
/**
 * Embedder-owned consent and grant authority. A model never provides a
 * consent flag: it presents only an opaque grantRef, which this port binds to
 * the authenticated tenant/device/task/AgentRef/session/runtime/grant/policy
 * identity. The host must retain an exact historical permit until its
 * mutation is accepted, explicitly revoked, or superseded by a higher writer
 * epoch; reaching task terminal state alone must not implicitly delete it.
 */
export interface AgentMemoryProjectionAuthorizer {
    authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
    /** Revoke hosted-projection authorization before the server asks the store to erase. */
    revoke(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<void>;
}
/** Input to the durable projection store. `redactedBytes` has already been decoded from the portable base64url body. */
export interface AgentMemoryProjectionCommitInput {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly mutation: AgentMemoryProjectionMutation;
    readonly redactedBytes: Uint8Array;
}
/**
 * Durable hosted snapshot and immutable metering receipt authority.
 *
 * `commit` must hash the supplied bytes and compare them with the portable
 * redacted hash before every write. It accepts a new epoch only at sourceSeq
 * one, accepts same-epoch writes only gap-free, returns `idempotent` for an
 * exact replay, and rejects stale/gap/binding/hash mismatches. The accepted
 * snapshot and its metering receipt share one transaction boundary.
 */
export interface AgentMemoryProjectionStore {
    commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
    /**
     * Server-side deletion leaves a body-free epoch fence. The host must mint a
     * later writer grant from `nextWriterEpoch`; no device/runtime is required.
     */
    erase(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<AgentMemoryProjectionEraseResult>;
}
// ==== @byok-sdk/cloud dist/agent-message-draft.d.ts ====
import type { TenantId } from '@byok-sdk/core';
import { type AgentRef } from '@byok-sdk/protocol';
import type { TenantStores } from './tenant-stores';
export interface AgentMessageDraftCursor {
    readonly revision: number;
    readonly offset: number;
}
export interface AgentMessageDraftRow {
    readonly taskId: string;
    readonly deviceId: string;
    readonly agentRef: AgentRef;
    readonly revision: number;
    readonly text: string;
    readonly byteCount: number;
    readonly state: 'open' | 'overflow' | 'gap';
    readonly updatedAt: string;
    readonly expiresAt: string;
}
export interface AgentMessageDraftApplyInput extends AgentMessageDraftCursor {
    readonly taskId: string;
    readonly deviceId: string;
    readonly agentRef: AgentRef;
    readonly text: string;
    readonly overflow?: true;
    readonly maxBytes: number;
    readonly now: string;
}
export type AgentMessageDraftApplyResult = 'applied' | 'stale' | 'gap' | 'overflow';
export interface AgentMessageDraftStore {
    apply(tenant: TenantId, input: AgentMessageDraftApplyInput): Promise<AgentMessageDraftApplyResult>;
    read(tenant: TenantId, taskId: string): Promise<AgentMessageDraftRow | undefined>;
    delete(tenant: TenantId, taskId: string): Promise<void>;
    sweepExpired(now: string): Promise<void>;
}
export interface AgentMessageDraftReadback extends AgentMessageDraftCursor {
    readonly text: string;
    readonly byteCount: number;
    readonly state: AgentMessageDraftRow['state'] | 'ended' | 'discarded';
}
/** The cursor is a UTF-8 boundary. A cursor beyond retained text has no suffix. */
export declare function agentMessageDraftSuffix(text: string, cursor: AgentMessageDraftCursor | undefined, revision: number): {
    offset: number;
    text: string;
};
export declare function readTaskAgentMessageDraft(stores: TenantStores, deviceId: string, taskId: string, expectedRef: AgentRef, cursor?: AgentMessageDraftCursor): Promise<AgentMessageDraftReadback | undefined>;
// ==== @byok-sdk/cloud dist/approval-control.d.ts ====
/**
 * Host-side approval resolution: the one rule that decides WHICH approval a
 * `cloud.approveTask`/`rejectTask` call is allowed to resolve.
 *
 * The old reference server kept this as a single mutable slot on its task
 * record that `task.await_approval` overwrote and `task.approval_resolved`
 * cleared. Cloud holds no session state and no second store: the SAME two
 * observations are already durable in the `ApprovalTimelineStore` tail
 * (`approval-timeline.ts`), appended by the inbound gate, so the slot is
 * DERIVED from that tail on each call rather than mirrored into a record that
 * could then disagree with it. `@byok-sdk/server` projects the same fold as
 * `TaskSnapshot.pendingApprovalId` (`packages/server/src/snapshot.ts`).
 *
 * The derivation is a fold over the tail's entries in revision order, holding
 * exactly one slot — deliberately the server's shape, not a set of concurrently
 * pending approvals:
 *
 *   - `approval_requested` SETS the slot, superseding whatever it held. A
 *     daemon that dispatched a fresh approval without this cloud ever seeing
 *     the previous one resolved has moved on, and the newest request is what
 *     an operator is being asked about (`hub.ts:1399`).
 *   - `approval_resolved(X)` CLEARS the slot when the slot's own id is `X`, or
 *     when the slot has no id at all (a request recorded before wire v4 named
 *     none, so the resolution can only be about the single outstanding
 *     request). A resolution naming some OTHER id is about an approval already
 *     superseded and leaves the current slot standing (`hub.ts:1569`).
 *
 * Two ways there is legitimately nothing pending: the tail has no unresolved
 * request, or the tail is gone entirely — it is a bounded, TTL'd observation
 * ring, not an authority that keeps facts forever. Both answer `undefined`,
 * and the callers fail closed on it. A dropped-then-expired approval is not
 * silently approved.
 */
import type { ApprovalTimelineTail } from './approval-timeline';
/**
 * M5 (approval targeting): thrown by `ByokCloud.approveTask`/`rejectTask` when
 * the caller supplied an `approvalId` that does NOT match the approval this
 * task currently has pending — the caller is targeting a SPECIFIC approval the
 * daemon has already superseded with a newer one.
 *
 * Distinct from the `task_not_awaiting_approval` `ByokCloudError` (there
 * is no pending approval at all, checked FIRST so it still wins when both would
 * apply): this error means the task genuinely IS awaiting an approval, just not
 * the one the caller thinks it is. Thrown before any mailbox row is allocated —
 * a stale-id call has zero side effects.
 *
 * A distinct class rather than a `CloudErrorCode`, unlike the rest of
 * this package's failures, because it carries the two ids the caller needs to
 * re-target: a code alone cannot say what the pending approval actually is.
 */
export declare class StaleApprovalError extends Error {
    readonly taskId: string;
    readonly requestedApprovalId: string;
    readonly currentApprovalId: string | undefined;
    constructor(taskId: string, requestedApprovalId: string, currentApprovalId: string | undefined);
}
/** The one approval a task currently has outstanding. */
export interface PendingApproval {
    /**
     * The daemon's own id for this approval. Wire v4 requires one; it is ABSENT
     * only on a request recorded before v4. A host decision refuses such a
     * request, because a v4 `task.approve`/`task.reject` must name it.
     */
    readonly approvalId?: string;
    /** Immutable daemon envelope identity for this exact request observation. */
    readonly sourceEnvelopeId: string;
    /** Monotonic timeline revision for this exact request observation. */
    readonly revision: number;
}
/**
 * The task's current pending approval, or `undefined` when it has none — see
 * this module's own doc comment for the fold and why it holds one slot.
 */
export declare function pendingApproval(tail: ApprovalTimelineTail | undefined): PendingApproval | undefined;
// ==== @byok-sdk/cloud dist/approval-timeline.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from '@byok-sdk/core';
import { type TenantId } from '@byok-sdk/core';
import { z } from 'zod';
export declare const DEFAULT_APPROVAL_TIMELINE_CAPACITY = 50;
export declare const DEFAULT_APPROVAL_TIMELINE_TTL_MS: number;
export declare const APPROVAL_SUMMARY_MAX_BYTES: number;
export declare const ApprovalTimelineEventSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"approval_requested">;
    summary: z.ZodString;
    approvalId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"approval_requested">;
    approvalId: z.ZodString;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"approval_resolved">;
    approvalId: z.ZodOptional<z.ZodString>;
    decision: z.ZodEnum<{
        approve: "approve";
        reject: "reject";
    }>;
    resolvedBy: z.ZodLiteral<"local">;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"approval_resolved">;
    approvalId: z.ZodOptional<z.ZodString>;
    decision: z.ZodLiteral<"approve">;
    resolvedBy: z.ZodLiteral<"host">;
    at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"approval_resolved">;
    approvalId: z.ZodOptional<z.ZodString>;
    decision: z.ZodLiteral<"reject">;
    resolvedBy: z.ZodLiteral<"host">;
    reason: z.ZodNullable<z.ZodString>;
    at: z.ZodISODateTime;
}, z.core.$strict>]>;
export type ApprovalTimelineEvent = Readonly<z.infer<typeof ApprovalTimelineEventSchema>>;
/**
 * True when two observations of one source envelope are the same event. A
 * sealed request compares by its comparison projection, so a retry that
 * sealed the same summary again is the same request (§9.2).
 */
export declare function sameApprovalTimelineEvent(left: ApprovalTimelineEvent, right: ApprovalTimelineEvent): boolean;
export declare const ApprovalObservationSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    revision: z.ZodNumber;
    receivedAt: z.ZodISODateTime;
    event: z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"approval_requested">;
        summary: z.ZodString;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"approval_requested">;
        approvalId: z.ZodString;
        sealed: z.ZodObject<{
            v: z.ZodLiteral<1>;
            suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
            category: z.ZodLiteral<"task-output">;
            scope: z.ZodObject<{
                id: z.ZodString;
                epoch: z.ZodNumber;
                keyId: z.ZodString;
            }, z.core.$strict>;
            chainHead: z.ZodObject<{
                seq: z.ZodNumber;
                hash: z.ZodString;
            }, z.core.$strict>;
            sender: z.ZodString;
            salt: z.ZodString;
            nonce: z.ZodString;
            paddedLength: z.ZodNumber;
            contentMac: z.ZodString;
            ciphertext: z.ZodOptional<z.ZodString>;
            ciphertextRef: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"approval_resolved">;
        approvalId: z.ZodOptional<z.ZodString>;
        decision: z.ZodEnum<{
            approve: "approve";
            reject: "reject";
        }>;
        resolvedBy: z.ZodLiteral<"local">;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"approval_resolved">;
        approvalId: z.ZodOptional<z.ZodString>;
        decision: z.ZodLiteral<"approve">;
        resolvedBy: z.ZodLiteral<"host">;
        at: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"approval_resolved">;
        approvalId: z.ZodOptional<z.ZodString>;
        decision: z.ZodLiteral<"reject">;
        resolvedBy: z.ZodLiteral<"host">;
        reason: z.ZodNullable<z.ZodString>;
        at: z.ZodISODateTime;
    }, z.core.$strict>]>;
}, z.core.$strip>;
export type ApprovalObservation = Readonly<z.infer<typeof ApprovalObservationSchema>>;
export interface ApprovalTimelineTail {
    readonly tenantId: TenantId;
    readonly taskId: string;
    readonly entries: readonly ApprovalObservation[];
    readonly cursor?: number;
    readonly dropped: number;
    readonly capacity: number;
    readonly expiresAt: string;
}
export interface ApprovalTimelineAppendInput {
    readonly taskId: string;
    readonly sourceEnvelopeId: string;
    readonly event: ApprovalTimelineEvent;
    readonly ttlMs?: number;
    readonly capacity?: number;
}
/**
 * One host decision against the exact unresolved request it observed.
 *
 * The expected source/revision pair is the durable request identity.  A
 * resolver must not turn a stale read into a decision for a request which has
 * since been superseded, and it must not split one logical decision into
 * several mailbox controls.  Implementations serialize this comparison and
 * append under the timeline's per-task authority.
 */
export interface ApprovalTimelineResolvePendingInput extends ApprovalTimelineAppendInput {
    readonly expectedSourceEnvelopeId: string;
    readonly expectedRevision: number;
}
/** Result of a conditional host-decision append. Logical conflicts are data, not transport failures. */
export type ApprovalTimelineResolvePendingResult = {
    readonly status: 'applied' | 'replayed';
    readonly tail: ApprovalTimelineTail;
} | {
    readonly status: 'conflict' | 'superseded' | 'absent';
    readonly tail?: ApprovalTimelineTail;
};
export interface ApprovalTimelineStore {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    /** Atomically append one host resolution only if its request remains current. */
    resolvePending(tenant: TenantId, input: ApprovalTimelineResolvePendingInput): Promise<ApprovalTimelineResolvePendingResult>;
    read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export interface ValidatedApprovalTimelineAppend {
    readonly capacity: number;
    readonly ttlMs: number;
    readonly event: ApprovalTimelineEvent;
}
export declare function validateApprovalTimelineAppend(input: ApprovalTimelineAppendInput): ValidatedApprovalTimelineAppend;
export declare function validateApprovalTimelineResolve(input: ApprovalTimelineResolvePendingInput): ValidatedApprovalTimelineAppend;
export declare function approvalTimelineKey(tenant: TenantId, taskId: string): string;
export declare function parseApprovalObservations(value: unknown): readonly ApprovalObservation[];
export declare function approvalTimelineCursor(entries: readonly ApprovalObservation[]): number | undefined;
// ==== @byok-sdk/cloud dist/auth/bearer.d.ts ====
/**
 * The single bearer check every device-facing route shares.
 *
 * S1 shape, reproduced exactly: the token's `(tenantId, deviceId, productId)`
 * are LOOKUP KEYS, and the ROW that comes back is the authority. A token for a
 * device that no longer exists, one whose tenant does not own that device, one
 * whose product disagrees with the row, one for a revoked device, an expired
 * token, and a malformed tenant id in the claims all fail identically here and
 * are indistinguishable to the caller. There is deliberately no "which of
 * those was it" signal to hand back, so no route can turn a 401 into a
 * cross-tenant existence oracle.
 *
 * The returned {@link DevicePrincipal} is core's, carrying a minted
 * `TenantId` — which is what makes it the only legal input to
 * `tenantStoresFor` (`../tenant-stores.ts`).
 */
import { type DevicePrincipal } from '@byok-sdk/core';
import type { DeviceDirectory } from '../stores/ports';
import type { TokenSigner } from './tokens';
export interface BearerAuthDeps {
    readonly tokenSigner: TokenSigner;
    readonly devices: DeviceDirectory;
    /**
     * The ONE product this deployment serves, when it serves exactly one.
     *
     * Two deployment shapes, two explicit authorities — not a default and a
     * fallback. A multi-product hosted control plane leaves this absent, and the
     * row is the whole product authority (`device.productId === claims.productId`
     * below). A single-product instance supplies it — that is the embedded shape,
     * where `createByokServer({ productId })` always has one — and the token must
     * then name THAT product as well, so a device paired through a code minted
     * for another product cannot reach this instance's bearer-authed routes at
     * all.
     *
     * Absent it, a cross-product device whose token and row agree with each other
     * authenticates on every `device` route the deployment mounts, which is
     * precisely the drift this closes for the embedded shape.
     */
    readonly instanceProductId?: string;
}
export declare function extractBearerToken(header: string | undefined): string | undefined;
export declare function authenticateBearer(header: string | undefined, deps: BearerAuthDeps): Promise<DevicePrincipal | undefined>;
// ==== @byok-sdk/cloud dist/auth/device-assertion.d.ts ====
import { type AuthenticatedDeviceAssertion, type AuthenticatedTaskAssertion, type Clock, type DeviceAssertionExpectedBinding, type DeviceAssertionReplayAuthority } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';
export interface HostedDeviceAssertionAuthDeps {
    readonly devices: DeviceDirectory;
    readonly crypto: CloudCrypto;
    readonly replay: DeviceAssertionReplayAuthority;
    readonly clock: Clock;
    readonly expected: DeviceAssertionExpectedBinding;
    readonly maxLifetimeMs?: number;
}
/**
 * Hosted composition for an assertion exchange endpoint. The returned
 * principal is current device-directory authority; the assertion is consumed
 * before success is returned. Connector sessions minted afterward remain
 * host-owned and are never represented by this short-lived credential.
 */
export declare function authenticateHostedDeviceAssertion(input: unknown, deps: HostedDeviceAssertionAuthDeps): Promise<AuthenticatedDeviceAssertion | undefined>;
/**
 * The task lane needs exactly the same hosted authorities as the device lane —
 * the same directory rows, the same verifier, the same replay ledger, the same
 * clock and the same expected binding. An alias rather than a second interface,
 * because two structurally identical declarations are two places for the
 * hosted composition's requirements to drift apart.
 */
export type HostedTaskAssertionAuthDeps = HostedDeviceAssertionAuthDeps;
/**
 * Hosted composition for the task-scoped tool-authority exchange
 * (`byok-task-assertion-v1`, contract §8.1 / §8.2(2)).
 *
 * Everything §8.2(2) puts on this side is here or in the core function it
 * composes: strict parse, the CURRENT device row (exists, not revoked, legal
 * key), signature, exact issuer/product/audience, valid time window, the TTL
 * ceiling, and one atomic `jti` consumption under the task lane's own `schema`
 * segment — so the same `jti` presented as a device assertion and as a task
 * assertion occupies two key slots and neither lane can burn the other's. The
 * replay segment is chosen inside core from the envelope kind; this function
 * deliberately has no say in it, because a caller able to name the segment
 * would be a caller able to spend the other lane's key.
 *
 * A DEVICE envelope presented here authenticates as `undefined`, always: §8.1
 * gives the task lane zero acceptance and zero fallback, and that is a property
 * of core's parser (`parseTaskAssertionEnvelope`), not a branch anyone here
 * could relax.
 *
 * A replay store that cannot answer REJECTS the promise rather than resolving
 * to a principal — §8.2(2)'s "an unavailable replay store fails, it does not
 * downgrade authentication". A host turns that into an availability error; it
 * must never turn it into signature-only acceptance.
 *
 * What this deliberately does NOT do is the frozen-offer check — that the
 * task, AgentRef and toolset in the claims belong to THIS Execution, and that
 * the Execution still permits a new tool call. That authority is the host's
 * (§8.2(3)), and a parameter for it here would be an invitation to synthesize
 * it. This function's answer is "these claims are authentic and spent once",
 * never "this invocation is admitted".
 */
export declare function authenticateHostedTaskAssertion(input: unknown, deps: HostedTaskAssertionAuthDeps): Promise<AuthenticatedTaskAssertion | undefined>;
// ==== @byok-sdk/cloud dist/auth/device-proof.d.ts ====
import { type Clock, type DevicePrincipal } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';
export declare const DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS = 60000;
export declare const MAX_DEVICE_PROOF_CLOCK_SKEW_MS: number;
export declare const DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS: number;
export declare const MAX_DEVICE_PROOF_MAX_LIFETIME_MS: number;
export interface DeviceProofRequestBinding {
    readonly method: string;
    readonly path: string;
    readonly operation: string;
    readonly resource: string;
    readonly body: Uint8Array;
}
export interface DeviceProofAuthDeps {
    readonly devices: DeviceDirectory;
    readonly crypto: CloudCrypto;
    readonly clock: Clock;
    readonly clockSkewMs?: number;
    readonly maxLifetimeMs?: number;
}
export interface AuthenticatedDeviceProof {
    /** Row-derived principal; no protected claim is re-used as authority. */
    readonly device: DevicePrincipal;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly bodySha256: string;
    readonly bodySize: bigint;
    readonly keyId: string;
    readonly keyEpoch: number;
}
/**
 * Authenticate a request-bound proof. Every rejected state is `undefined`, so
 * a route has one 401 response for malformed input, row misses, revocation,
 * stale epochs, binding changes, clock failures and bad signatures.
 */
export declare function authenticateDeviceProof(input: unknown, request: DeviceProofRequestBinding, deps: DeviceProofAuthDeps): Promise<AuthenticatedDeviceProof | undefined>;
// ==== @byok-sdk/cloud dist/auth/plane.d.ts ====
/**
 * The auth plane: everything the three pre-tenant routes (`/byok/pair`,
 * `/byok/challenge`, `/byok/token`) need, and nothing else.
 *
 * Those three routes cannot take a {@link TenantStores} facade — they run
 * BEFORE a principal exists, which is exactly why they are the surface where a
 * tenant boundary is easiest to lose. So instead of handing them naked stores
 * and trusting each handler to pass the right tenant, this module owns every
 * tenant-carrying call they make and hands back operations that name no tenant
 * at all:
 *
 * - a pairing code redeems into a REGISTERED device row in one step, so the
 *   claims never sit in handler scope as a tenant a handler could substitute;
 * - a device resolves to a row (the pre-tenant lookup, §6.2's pinned wire
 *   contract), and unknown/revoked collapse to one answer;
 * - nonce issue/atomic-consume and token minting take that ROW, so the
 *   tenant they act on is the row's, by construction.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { CloudStores, DeviceRecord, PairingCodeInfo } from '../stores/ports';
import { type TokenSigner } from './tokens';
/** ~10min, matching the reference server's pairing-code lifetime. */
export declare const PAIRING_CODE_TTL_MS: number;
/** The paired identity key is the first and only proof key in S6. */
export declare const DEVICE_IDENTITY_PROOF_KEY_ID = "identity";
export declare const DEVICE_IDENTITY_PROOF_KEY_EPOCH = 0;
export interface PairInput {
    readonly pairingCode: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    /** Optional client-hashed machine identity (protocol §6.1). Carried into registration verbatim; it is never a tenant or product authority. */
    readonly machineId?: string;
}
export interface MintedAccessToken {
    readonly accessToken: string;
    readonly expiresAt: string;
}
export interface AuthPlane {
    /** Host control plane: mint a single-use code carrying the tenant/product a device will land in. */
    createPairingCode(tenant: TenantId, input: {
        readonly productId: string;
        readonly ttlMs?: number;
    }): Promise<PairingCodeInfo>;
    /**
     * Redeem a code and register the device it pairs, in one step. `undefined`
     * for a code that is unknown, expired, or already used — one answer for all
     * three. Single-use redemption is what makes this exclusive: a second
     * redeem never reaches the row write.
     */
    redeemAndRegister(input: PairInput): Promise<DeviceRecord | undefined>;
    /** The pre-tenant device lookup §6.2's wire contract forces. `undefined` for unknown AND revoked alike — no existence oracle. */
    resolveDevice(deviceId: string): Promise<DeviceRecord | undefined>;
    issueNonce(device: DeviceRecord): Promise<string>;
    /** Atomically consume the nonce after signature verification (§6.2). */
    consumeNonceIfValid(device: DeviceRecord, nonce: string): Promise<boolean>;
    /** Domain-separated (`byok-nonce-v1\n`) — see `verify.ts`. A raw signature over the bare nonce is invalid, with no second accepted form. */
    verifySignature(device: DeviceRecord, nonce: string, signature: string): Promise<boolean>;
    mintAccessToken(device: DeviceRecord): Promise<MintedAccessToken>;
}
export interface AuthPlaneDeps {
    readonly stores: CloudStores;
    readonly crypto: CloudCrypto;
    readonly clock: Clock;
    readonly tokenSigner: TokenSigner;
    readonly accessTokenTtlSeconds?: number;
}
export declare function createAuthPlane(deps: AuthPlaneDeps): AuthPlane;
// ==== @byok-sdk/cloud dist/auth/tokens.d.ts ====
/**
 * Access tokens for the hosted device surface (docs/protocol.md §6).
 *
 * The token carries the identity TRIPLE — `(deviceId, tenantId, productId)` —
 * and all three legs are lookup keys, never authority: `authenticateBearer`
 * (`bearer.ts`) resolves them against the device directory and answers with
 * the ROW's identity. A token missing a leg is not a partially usable token;
 * it is not a token this deployment minted.
 *
 * {@link TokenSigner} is a port for the same reason `@byok-sdk/server` made it
 * one: a SaaS with an org-wide asymmetric signer or a KMS swaps its own in.
 * The reference implementation below is HS256 over a caller-supplied secret,
 * built on WebCrypto so the package stays runtime-neutral (no `jose`, no
 * `node:crypto`).
 */
import type { Clock } from '@byok-sdk/core';
/** Access tokens are ~1h, matching the reference server (docs/protocol.md §6.1/§6.2). */
export declare const ACCESS_TOKEN_TTL_SECONDS: number;
export interface AccessTokenClaims {
    readonly deviceId: string;
    /** Unbranded on the wire: the value is only a lookup key until a device row vouches for it. */
    readonly tenantId: string;
    readonly productId: string;
}
export interface TokenSigner {
    sign(claims: AccessTokenClaims, expiresInSeconds: number): Promise<string>;
    /** Claims for a valid, unexpired token, or `undefined` for invalid/expired/malformed — no reason is ever reported. */
    verify(token: string): Promise<AccessTokenClaims | undefined>;
}
/**
 * HS256 JWT signer over `secret`.
 *
 * `clock` is injected rather than read off `Date.now()` so expiry is testable
 * and so the whole package keeps a single notion of "now" (the same one the
 * stores use for TTLs).
 */
export declare function createHmacTokenSigner(secret: Uint8Array, clock: Clock): TokenSigner;
// ==== @byok-sdk/cloud dist/auth/verify.d.ts ====
import type { CloudCrypto } from '../crypto/port';
export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';
export declare function verifyNonceSignature(crypto: CloudCrypto, devicePublicKey: string, nonce: string, signature: string): Promise<boolean>;
// ==== @byok-sdk/cloud dist/capabilities.d.ts ====
/**
 * The hosted capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by READING a declaration, never
 * by probing an endpoint and interpreting 404/405/501. `@byok-sdk/core` owns the
 * declaration shape and the `hasCapability`/`assertCapability` enforcement
 * point; what lives here is the hosted vocabulary and the mapping from a
 * capability name to the routes that provide it.
 *
 * `GET /byok/capabilities` is a hosted-only route: it is not part of the
 * frozen device wire contract, `@byok-sdk/protocol` is untouched by it, and the
 * daemon does not consume it yet (that lands in a later slice). What it
 * already does here is drive route selection — a deployment that does not
 * declare `blobs.presigned` does not mount the grant routes at all, and one
 * that does not declare `blobs.contentproxy` does not mount the two `/content`
 * routes, so the declaration and the surface cannot disagree.
 */
import { type CapabilityDeclaration } from '@byok-sdk/core';
import type { ByokCloudOptions } from './cloud';
/** The hosted capability vocabulary this package knows how to serve. */
export declare const CLOUD_CAPABILITIES: {
    /** `GET /byok/events` long-poll receive (§8). */
    readonly eventsLongPoll: 'events.longpoll';
    /** `POST /byok/messages` batched send (§8.2). */
    readonly messagesBatch: 'messages.batch';
    /** The three bearer-authed blob routes: reserve/grant, explicit finalize, committed-only download (§7). */
    readonly blobsPresigned: 'blobs.presigned';
    /**
     * The two presigned `/byok/blobs/:id/content` routes — cloud carrying the
     * bytes itself.
     *
     * Split out of `blobs.presigned` because it was one capability describing two
     * separable facts. A composition whose bytes live in object storage mints
     * grants (`blobs.presigned`) but has no byte-proxy path at all, and saying so
     * by declaration is ADR-010's whole posture: a client reads what a deployment
     * serves, it never probes a `/content` route and interprets the status code.
     *
     * Spelled all-lowercase because core's declaration schema pins capability
     * names to `/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/` — the same reason the sibling
     * above reads `events.longpoll` and not `events.longPoll`.
     */
    readonly blobsContentProxy: 'blobs.contentproxy';
    /** Board list/claim/unclaim/status routes. Polling is first-class under this declaration. */
    readonly boardCoordination: 'board.coordination';
    /** Additional SSE transport for the same board read model. */
    readonly boardSse: 'board.sse';
    /** Device-scoped five-level presence publication. */
    readonly presenceHints: 'presence.hints';
    /** Bounded task activity batch publication. */
    readonly activityTail: 'activity.tail';
    /** Request-bound device proof record manifest/read/write surface (S6). */
    readonly truthRecords: 'truth.records';
    /**
     * Tenant-scoped skill pack distribution: the manifest list plus the per-file
     * content route a paired device installs from.
     *
     * Hosted HTTP on purpose. A pack is DECLARATIVE CONTENT a device pulls after
     * reading this declaration — not a message — so `@byok-sdk/protocol` gains
     * nothing from it and the frozen v1 envelope stays untouched. Composition-
     * bound like `truth.records`: a deployment that declares it without supplying
     * a `SkillPackStore` is refused at construction rather than publishing two
     * routes it would then 404.
     */
    readonly skillPacks: 'skills.pack';
    /** Optional, one-way redacted Agent-memory snapshot mutation route. */
    readonly agentMemoryProjection: 'agent.memory.projection';
    /**
     * Remote authenticated runtime input preparation (C07 G4): the host control
     * plane enqueues `agent.input.preparation` and the device discharges it
     * through the completion/status pair.
     *
     * Informational like `host-mcp-task-context`, not route-gating. Both routes
     * mount unconditionally (`cloud.ts`) because the completion route is the
     * DEVICE's only way to discharge a mailbox row this same deployment handed
     * it — withholding it would strand the device's redelivery cursor rather
     * than degrade a feature. For the same reason the completion route asserts
     * no DEVICE capability either: the device-level `agent-input-preparation-v9`
     * flag gates ADMISSION (`enqueueInputPreparation`) and nothing else, so an
     * unconfigured device is refused a row instead of being handed one whose
     * only honest answer — `input_preparation_unconfigured` — it could not then
     * record. What declaring THIS capability promises is that this deployment's
     * host side actually drives the lane, which is what a Host reads before
     * calling `enqueueInputPreparation` instead of probing.
     */
    readonly inputPreparation: 'agent.input.preparation';
    /**
     * Contract §8.1's capability gate for task-scoped tool authority
     * (`byok-task-assertion-v1`), deployment-level channel.
     *
     * The SAME literal name `@byok-sdk/protocol`'s
     * `HOST_MCP_TASK_CONTEXT_CAPABILITY` carries on the device-level channel —
     * §8.1 requires both to be in place, and a name spelled differently in the
     * two would make "both" unverifiable.
     *
     * Unlike its siblings above this capability mounts no route in this package:
     * what a deployment promises by declaring it is that its host side actually
     * VERIFIES task assertions (`authenticateHostedTaskAssertion` plus the frozen
     * offer check that only the host can make). That is why it is default-off
     * below and not derivable from anything this package can inspect — §8.2(1):
     * the capability is declared only once it is completely implemented.
     */
    readonly hostMcpTaskContext: 'host-mcp-task-context';
    /**
     * The E2EE member device routes (#654): register a member key bundle,
     * append and read the member chain, put and read scope key packages, and
     * read the relayed client pairing MAC. Composition-bound like
     * `truth.records`: declaring it without an `e2eeMemberStore`, or passing one
     * without declaring it, is refused at construction.
     */
    readonly e2eeMember: 'e2ee.member';
    /**
     * The member KEM epoch rules of #654 E5b-2 (owner batch §77a): v2 key
     * packages only, the per-member KEM floor from `rotate` entries, and the
     * paged own-package read with the scope head. Declared exactly when
     * `e2ee.member` is.
     */
    readonly e2eeMemberKemEpoch: 'e2ee.member.kem-epoch';
};
export type CloudCapability = (typeof CLOUD_CAPABILITIES)[keyof typeof CLOUD_CAPABILITIES];
/** The wire DTO for `GET /byok/capabilities` — core's shape, bound to a cloud-owned route. */
export declare const CapabilitiesResponseSchema: import("zod").ZodObject<{
    schema: import("zod").ZodLiteral<"byok-capabilities-v1">;
    version: import("zod").ZodNumber;
    capabilities: import("zod").ZodArray<import("zod").ZodString>;
}, import("zod/v4/core").$strip>;
export type CapabilitiesResponse = CapabilityDeclaration;
export interface FullCapabilityDeclarationOptions {
    /**
     * Composition-bound capabilities require an explicit application authority.
     * `truth.records` is omitted by default because the standard in-memory
     * composition cannot truthfully promise a cross-store atomic commit.
     */
    readonly includeTruthRecords?: boolean;
    /**
     * `skills.pack` is omitted for the same reason: the standard composition is
     * given no `SkillPackStore`, and a default-on declaration would make every
     * existing deployment refuse to construct.
     */
    readonly includeSkillPacks?: boolean;
    /**
     * Hosted Agent memory is default-off: a composition needs both an embedder
     * grant authorizer and a durable projection store before it may declare the
     * mutation route.
     */
    readonly includeAgentMemoryProjection?: boolean;
    /**
     * Contract §8.2(1): the task lane is declared only by a deployment whose host
     * side verifies task assertions end to end. There is nothing this package can
     * probe to decide that for an embedder, and guessing would declare a gate the
     * deployment does not hold — so it is off unless a composition says otherwise.
     */
    readonly includeHostMcpTaskContext?: boolean;
    /** `e2ee.member` is default-off: the composition must supply an `e2eeMemberStore`. */
    readonly includeE2eeMember?: boolean;
}
/**
 * Each port-bound capability and the `createByokCloud` ports that serve it.
 * The declaration and the ports agree in both directions (#1096):
 * `createByokCloud` refuses a capability declared without all of its ports and
 * a port passed without its capability, and `capabilityDeclarationForPorts`
 * declares exactly the capabilities whose ports are all present.
 */
export declare const CAPABILITY_PORTS: {
    readonly "blobs.contentproxy": readonly ["blobContentProxy"];
    readonly "truth.records": readonly ["truthCommitter", "truthObjectDownloads"];
    readonly "skills.pack": readonly ["skillPacks"];
    readonly "agent.memory.projection": readonly ["agentMemoryProjectionAuthorizer", "agentMemoryProjectionStore"];
    readonly "e2ee.member": readonly ["e2eeMemberStore"];
};
/** The `createByokCloud` ports a capability is bound to. */
export type CapabilityPorts = Pick<ByokCloudOptions, (typeof CAPABILITY_PORTS)[keyof typeof CAPABILITY_PORTS][number]>;
/**
 * The declaration a composition's ports back: every standard capability, each
 * port-bound capability exactly when all of its ports are present, and never
 * `host-mcp-task-context`, which no port can prove (§8.2(1)).
 */
export declare function capabilityDeclarationForPorts(ports: CapabilityPorts, version?: number): CapabilityDeclaration;
/** Every capability the standard composition can serve, plus explicitly wired composition-bound ones. */
export declare function fullCapabilityDeclaration(version?: number, options?: FullCapabilityDeclarationOptions): CapabilityDeclaration;
export declare function declares(declaration: CapabilityDeclaration, capability: CloudCapability): boolean;
// ==== @byok-sdk/cloud dist/cloud.d.ts ====
import { z } from 'zod';
import { type AgentMessageDraftCursor, type AgentMessageDraftReadback } from './agent-message-draft';
import { type MaintenanceInput, type MaintenanceReport, type ProofReceiptRetentionOptions } from './maintenance';
import type { DeviceAssertionReplayAuthority } from '@byok-sdk/core';
import { type TaskAgentMessage } from './task-agent-message';
import { type AgentExecutionInput, type SealedAgentExecutionInput } from './agent-execution';
/**
 * `createByokCloud` — the hosted device surface, assembled.
 *
 * What this is NOT: an embedded coordinator. There is no `TaskHandle`, no
 * connection registry, no per-task object that a host holds onto. Sprint 0.1's
 * non-goal is explicit about that — the embedded `TaskHandle` must not become
 * the hosted API — so the host's control-plane input is a function
 * ({@link ByokCloud.enqueueOffer}) and its read model is a store query
 * ({@link ByokCloud.readTaskAttempt}).
 *
 * Every route is stateless in the strict sense: it resolves a principal from
 * the request, binds stores to that principal's tenant, and returns. Nothing
 * survives the response but what a store wrote. The one shape that would
 * quietly undo that — a Running/session map — is asserted absent by
 * `src/__tests__/constraints.test.ts`.
 */
import { type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type CapabilityDeclaration, type Clock, type CoreStores, type PresenceHint, type SkillPackStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { ActivityTail } from './activity';
import type { ApprovalTimelineTail } from './approval-timeline';
import { BYOK_CHALLENGE_PATH, BYOK_PAIR_PATH, BYOK_TOKEN_PATH, type Envelope, type AgentEgressPolicy, type InputPreparationOfferBinding, type SessionSelection, type TaskOfferPayload, type TaskOfferPlainPayload, type TaskOfferSealedPayload, type AgentRef, type AgentContentReadPayload, type AgentMessageDispositionPayload, type AgentMessagePublishPayload, type AgentMessageServerContext, type AgentHomeProjectionCompletionRequest, type AgentHomeProjectionPayload, type AgentHomeProjectionReadback, type AgentInputPreparationPayload, type ProviderProvisioningAvailablePayload, type AgentMemoryIntentAvailablePayload, type InputPreparationCompletionRequest, type InputPreparationReadback, type AgentMemoryProjectionEraseResult, type TaskSteerSealedPayload, type E2eeClientPairingMac, type E2eeKeyPackageAvailablePayload, type E2eeMemberChainEntry, type E2eeMemberKeyBundle, type E2eeScopeKeyPackage, type E2eeScopeKeyPackageV2Schema } from '@byok-sdk/protocol';
import type { TokenSigner } from './auth/tokens';
import type { CloudCrypto } from './crypto/port';
import { type RouteDescriptor } from './router/registry';
import { type ByokCloudObserver } from './inbound';
import { type AgentHomeProjectionReceiptInput } from './agent-home-projections';
import { type InputPreparationReceiptInput } from './input-preparations';
import type { AgentMemoryProjectionAuthorizer, AgentMemoryProjectionStore } from './agent-memory-projection';
import type { BlobContentProxy, CloudStores, DeviceRecord, AgentEgressRecord, PairingCodeInfo, RequestReceipt, TaskAbandonCause, TaskAttempt, TaskAttemptListQuery, TaskAttemptPage } from './stores/ports';
import { type DeviceTerminal, type TerminalResult } from './terminal-result';
import type { MailboxWake } from './mailbox-wake';
import { type TaskRedactionResult, type TaskRedactionStore } from './task-redaction';
import type { E2eeMemberStore } from './e2ee-member';
import type { TruthCommitter, TruthObjectDownloads } from './truth/contract';
/** Matches the reference server's ceiling (§7). */
export declare const DEFAULT_MAX_BLOB_SIZE_BYTES: number;
/** Matches the reference server's hold (§8). */
export declare const DEFAULT_LONG_POLL_HOLD_MS = 50000;
/** Rows per `GET /byok/events` response. */
export declare const DEFAULT_EVENTS_PAGE_LIMIT = 50;
/** Device capability required by the strict Agent offer path. */
export declare const AGENT_HOME_CONTRACT_CAPABILITY = "agent-home-contract";
export interface ByokCloudOptions {
    readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority;
    /**
     * Prunes used device-proof request ids in maintenance. Absent, the
     * `proofReceipts` step reports `not-configured` and every used `requestId`
     * stays single-use for as long as its receipt is kept.
     */
    readonly proofReceiptRetention?: ProofReceiptRetentionOptions;
    readonly mailboxWake: MailboxWake;
    readonly core: CoreStores;
    readonly cloud: CloudStores;
    /**
     * Byte proxying for the two `/byok/blobs/:id/content` routes. OPTIONAL, and
     * absent is a first-class answer: a composition backed by object storage
     * hands the device a presigned URL to the object store and never carries a
     * byte, so it has nothing to supply here. Supplied exactly when the
     * deployment declares `blobs.contentproxy` (ADR-010); either without the
     * other is refused at construction.
     */
    readonly blobContentProxy?: BlobContentProxy;
    /** Atomic proof receipt + truth/reference/accounting authority for S6 routes. */
    readonly truthCommitter?: TruthCommitter;
    /** Content-hash keyed object GET grants for object-backed truth bodies. */
    readonly truthObjectDownloads?: TruthObjectDownloads;
    /**
     * Tenant-scoped skill pack catalogue. OPTIONAL, and absent is a first-class
     * answer: a deployment that distributes no declarative content supplies
     * nothing here and declares no `skills.pack`. Supplied exactly when the
     * deployment declares the capability (ADR-010), like the byte proxy above.
     */
    readonly skillPacks?: SkillPackStore;
    readonly crypto: CloudCrypto;
    readonly tokenSigner: TokenSigner;
    readonly clock: Clock;
    /** What this deployment serves (ADR-010). Routes are mounted from it, so it can never over-declare. */
    readonly capabilities: CapabilityDeclaration;
    /** Recorded on the control-plane principal every host-side call is made under. */
    readonly operatorId?: string;
    /**
     * The ONE product this deployment serves, when it serves exactly one — the
     * embedded shape. Supplying it makes every bearer-authed route additionally
     * require the token to name this product; omitting it leaves the device row
     * as the whole product authority. Two deployment shapes, two explicit
     * authorities: see `BearerAuthDeps.instanceProductId` (`auth/bearer.ts`).
     */
    readonly instanceProductId?: string;
    /**
     * Product-owned consumer; destination lookup uses authenticated task context.
     * Delivery is at least once, including concurrent calls and retries after a
     * process restart or an uncertain commit. The product must durably deduplicate
     * the exact tenant/device/task/AgentRef/message identity and payload, producing
     * one logical effect and the same outcome/reasonCode on every exact replay.
     * A thrown error leaves admission pending for transport retry; only a returned
     * outcome is a terminal product decision. Do not use callback invocation count
     * as execution authority.
     */
    readonly agentMessage?: {
        consume(input: {
            readonly tenant: TenantId;
            readonly deviceId: string;
            readonly taskId: string;
            readonly context: AgentMessageServerContext;
            readonly payload: AgentMessagePublishPayload;
        }): Promise<{
            readonly outcome: 'accepted' | 'held' | 'refused';
            readonly reasonCode?: string;
        }>;
    };
    /**
     * Post-commit relay for envelopes this cloud durably accepted. Read-only by
     * construction: it is told after the write, it returns `void`, and a throw
     * from it is swallowed — the outcome is already fixed. Distinct from
     * {@link ByokCloudOptions.agentMessage}, which is admission and runs BEFORE
     * a write, deciding whether it happens at all.
     */
    readonly observer?: ByokCloudObserver;
    /**
     * Admission hook for the unauthenticated auth routes (`POST /byok/pair`,
     * `/byok/challenge`, `/byok/token`), called BEFORE their handler runs and
     * before any store is touched. `false` answers 429 and the handler never
     * runs. Absent means no limit: the SDK ships no policy here, so an edge
     * limiter is the deployment's responsibility (see `deploy/runbooks/hosted-operations.md`,
     * "Public routes and edge rate limits"). A limiter that throws or rejects
     * fails the request with a 500 rather than letting it through.
     *
     * Authenticated routes are not covered: they already have the per-device
     * `InboundRateLimiter`.
     */
    readonly publicRouteLimiter?: PublicRouteLimiter;
    /** Embedder-owned grant and consent authority for optional hosted Agent-memory projection. */
    readonly agentMemoryProjectionAuthorizer?: AgentMemoryProjectionAuthorizer;
    /** Durable snapshot + immutable metering receipt authority for optional hosted Agent-memory projection. */
    readonly agentMemoryProjectionStore?: AgentMemoryProjectionStore;
    /** Durable authority for {@link ByokCloud.redactTasks}. Without it, `redactTasks` fails closed. */
    readonly taskRedactionStore?: TaskRedactionStore;
    /** Durable authority for the E2EE member chain, key packages and pairing MACs. Without it, those calls fail closed. */
    readonly e2eeMemberStore?: E2eeMemberStore;
    readonly maxBlobSizeBytes?: number;
    readonly longPollHoldMs?: number;
    readonly eventsPageLimit?: number;
    readonly accessTokenTtlSeconds?: number;
    readonly boardPageLimit?: number;
    readonly boardStreamQueryIntervalMs?: number;
    readonly boardStreamHeartbeatIntervalMs?: number;
    readonly boardStreamReconciliationIntervalMs?: number;
    readonly boardChannelMaxBytes?: number;
    readonly boardTitleMaxBytes?: number;
    readonly presenceTtlMs?: number;
    readonly presenceMinimumIntervalMs?: number;
    readonly presenceDetailMaxBytes?: number;
    readonly activityMaxEvents?: number;
    readonly activityMaxBytes?: number;
    readonly activityCapacity?: number;
    readonly activityTtlMs?: number;
    readonly maxTruthRequestBytes?: number;
    /** Byte cap of one E2EE member device write. The default fits one full chain append (64 entries of 64 KiB). */
    readonly maxE2eeRequestBytes?: number;
    readonly skillPackPageLimit?: number;
}
/** The unauthenticated routes {@link ByokCloudOptions.publicRouteLimiter} guards. */
export type LimitedPublicRoute = {
    readonly method: 'POST';
    readonly path: typeof BYOK_PAIR_PATH;
} | {
    readonly method: 'POST';
    readonly path: typeof BYOK_CHALLENGE_PATH;
} | {
    readonly method: 'POST';
    readonly path: typeof BYOK_TOKEN_PATH;
};
/** `true` admits the request; `false` answers 429 before the handler or any store runs. */
export type PublicRouteLimiter = (route: LimitedPublicRoute, request: Request) => boolean | Promise<boolean>;
type ResumeSession = Extract<SessionSelection, {
    readonly mode: 'resume';
}>;
/**
 * Strict Agent dispatch input. The device path is intentionally a separate
 * argument on {@link ByokCloud.enqueueAgentOffer}; no legacy offer field is
 * interpreted as an Agent placement hint.
 */
export interface AgentDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    /**
     * Strict Agent resume payload carrying the exact opaque AgentRef and the
     * exact session being resumed (`session.mode: 'resume'`). A fresh Agent
     * execution is admitted only through {@link ByokCloud.submitAgentExecution};
     * an egress policy only through {@link ByokCloud.enqueueAgentEgressOffer}.
     */
    readonly payload: TaskOfferPlainPayload & {
        readonly session: ResumeSession;
        readonly egressPolicy?: never;
        readonly messageEgress?: never;
        readonly preparation?: never;
    };
}
/**
 * Strict dispatch of an already-counted preparation back to the device that
 * counted it.
 *
 * Deliberately NOT an optional field on {@link AgentDispatchInput}: a host API
 * that could express both through one input would let a caller reach the
 * ordinary lane by omitting one property.
 */
export interface PreparedDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    /** Instruction-free strict fresh payload naming the preparation this Execution consumes. */
    readonly payload: TaskOfferPlainPayload & {
        readonly preparation: InputPreparationOfferBinding;
    };
    /** Host-only destination/freshness authority; never serialized to the daemon. */
    readonly agentMessageContext?: AgentMessageServerContext;
}
/** Strict Agent resume dispatch that supplies the policy consumed by the typed egress lanes. */
export interface AgentEgressDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    readonly payload: TaskOfferPlainPayload & {
        readonly session: ResumeSession;
        readonly egressPolicy: AgentEgressPolicy;
        readonly preparation?: never;
    };
    /** Host-only product destination/freshness authority; never serialized to the daemon. */
    readonly agentMessageContext?: AgentMessageServerContext;
}
/**
 * The sealed lane of {@link AgentDispatchInput} (#654). Resume-only, as the
 * plaintext lane is. Each sealed lane has its own input, as
 * {@link PreparedDispatchInput} does: a plaintext lane refuses `sealing` and
 * `sealed`, so a caller cannot reach the plaintext lane by a missing field,
 * and no lane strips a sealing policy.
 */
export interface SealedAgentDispatchInput {
    /** Required with a sealed instruction, whose AAD and content MAC bind it. Without one, cloud mints the id. */
    readonly taskId?: string;
    readonly payload: TaskOfferSealedPayload & {
        readonly session: ResumeSession;
        readonly egressPolicy?: never;
        readonly messageEgress?: never;
    };
}
/** The sealed lane of {@link AgentEgressDispatchInput} (#654). */
export interface SealedAgentEgressDispatchInput {
    /** Required with a sealed instruction, whose AAD and content MAC bind it. Without one, cloud mints the id. */
    readonly taskId?: string;
    readonly payload: TaskOfferSealedPayload & {
        readonly session: ResumeSession;
        readonly egressPolicy: AgentEgressPolicy;
    };
    /** Host-only product destination/freshness authority; never serialized to the daemon. */
    readonly agentMessageContext?: AgentMessageServerContext;
}
/** A task-free, independently capability-gated Agent content read. */
export interface AgentContentReadInput {
    readonly payload: AgentContentReadPayload;
}
/** Task-free exact-device projection desired state, intentionally unrelated to TaskAttempt. */
export type AgentHomeProjectionInput = AgentHomeProjectionPayload;
/**
 * Task-free sealed provider provisioning notice: exactly `{ requestId }`. The
 * sealed request itself stays in the Host's own store and is fetched by the
 * device over Host routes; nothing else can be carried by this input.
 */
export type ProviderProvisioningNoticeInput = ProviderProvisioningAvailablePayload;
/**
 * Task-free Host-approved Agent memory intent notice: exactly
 * `{ intentId, agentRef }`. The immutable intent, and any memory content it
 * carries, stays in the Host's own store and is fetched by the device over
 * Host routes; nothing else can be carried by this input.
 */
export type AgentMemoryIntentNoticeInput = AgentMemoryIntentAvailablePayload;
/** Exact request identity a host must echo to read back durable projection status. */
export type AgentHomeProjectionStatusInput = AgentHomeProjectionReceiptInput;
/** Task-free exact-device remote preparation request, intentionally unrelated to TaskAttempt. */
export type InputPreparationInput = AgentInputPreparationPayload;
/** Exact request identity a host must echo to read back durable preparation status. */
export type InputPreparationStatusInput = InputPreparationReceiptInput;
/** Optional targeting for {@link ByokCloud.approveTask}. */
export interface ApproveTaskOptions {
    /**
     * Resolve THIS specific approval rather than whichever one is pending.
     * A mismatch against the task's current pending approval throws
     * {@link StaleApprovalError} instead of resolving the wrong thing.
     */
    readonly approvalId?: string;
}
/** Optional targeting and refusal cause for {@link ByokCloud.rejectTask}. */
export interface RejectTaskOptions extends ApproveTaskOptions {
    /** Carried to the runtime verbatim; absent stays absent on the wire. */
    readonly reason?: string;
}
export interface EnqueuedAgentControl {
    readonly seq: number;
    readonly envelope: Envelope;
}
export interface EnqueuedAgentHomeProjection extends EnqueuedAgentControl {
    readonly status: AgentHomeProjectionReadback;
}
export interface EnqueuedInputPreparation extends EnqueuedAgentControl {
    readonly status: InputPreparationReadback;
}
/** Immutable executable offer authority, independent of mailbox retention. */
export interface TaskOfferReadback {
    readonly taskId: string;
    readonly deviceId: string;
    readonly messageId: string;
    readonly type: 'task.offer';
    readonly payload: TaskOfferPayload;
    /** Receipt time, not a transport delivery timestamp. */
    readonly recordedAt: string;
    /** The delivered marker is durable; false is not proof append never happened. */
    readonly delivered: boolean;
}
export interface EnqueuedOffer {
    readonly taskId: string;
    /** The per-(tenant, device) delivery seq — the daemon's redelivery cursor position for this envelope. */
    readonly seq: number;
    readonly envelope: Envelope;
    readonly attempt: TaskAttempt;
}
export interface ByokCloud {
    runMaintenance(input: MaintenanceInput): Promise<MaintenanceReport>;
    /** WHATWG fetch handler — mount on `@hono/node-server`, a Worker, or Deno. */
    readonly fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
    /** The I1 route inventory: every mounted route and the credential class it requires. */
    readonly routes: readonly RouteDescriptor[];
    /**
     * What the router ACTUALLY holds, read back off the router itself. Exposed
     * so the I1 matrix can close in both directions: an inventory is only
     * evidence if a route mounted some other way would show up here without a
     * matching entry in {@link routes}.
     */
    readonly mountedRoutes: readonly {
        readonly method: string;
        readonly path: string;
    }[];
    readonly capabilities: CapabilityDeclaration;
    /** Host control plane: mint a single-use pairing code for a tenant/product. */
    createPairingCode(tenant: TenantId, input: {
        readonly productId: string;
        readonly ttlMs?: number;
    }): Promise<PairingCodeInfo>;
    /**
     * Host control plane: enqueue a strict Agent resume offer to an explicit
     * device. Resume-only: the payload must carry `session.mode: 'resume'` with
     * an exact `sessionRef`, and one without it is refused with `coordination_input_invalid` before any attempt,
     * receipt or mailbox write. A fresh Agent execution is admitted only through
     * {@link ByokCloud.submitAgentExecution}.
     * Capability admission is read from the durable authenticated device row
     * before either the mailbox append or task-attempt open.
     */
    enqueueAgentOffer(tenant: TenantId, deviceId: string, input: AgentDispatchInput): Promise<EnqueuedOffer>;
    /**
     * Host control plane: enqueue an offer for an already-counted preparation.
     *
     * Admission requires the device to durably advertise both the Agent-home
     * contract and `agent-input-preparation-v9` — the second because only a device
     * that can prepare holds the durable record this offer names. A device that
     * advertises neither never receives the message. The offer is strict, so a
     * daemon that does not know `preparation` stops rather than running it as an
     * ordinary instruction offer.
     */
    enqueuePreparedOffer(tenant: TenantId, deviceId: string, input: PreparedDispatchInput): Promise<EnqueuedOffer>;
    /**
     * Host control plane: enqueue the typed egress-policy Agent offer. Missing
     * egress/reliable-ack capabilities reject before a mailbox row is allocated.
     */
    enqueueAgentEgressOffer(tenant: TenantId, deviceId: string, input: AgentEgressDispatchInput): Promise<EnqueuedOffer>;
    /**
     * Submit one fresh Agent execution from the Host's persisted input.
     * A delivered taskId conflicts; recover through exact offer readback.
     */
    submitAgentExecution(tenant: TenantId, input: AgentExecutionInput): Promise<EnqueuedOffer>;
    /**
     * Sealed offer lanes (#654). Each sends the sealed branch of its plaintext
     * sibling's `task.offer` with the same rules, and needs every flag that
     * `requiredReceiverCapabilities` names for it, `sealed-payload-v1` among them.
     * The plaintext siblings refuse `sealing` and `sealed` with
     * `coordination_input_invalid`.
     */
    enqueueSealedAgentOffer(tenant: TenantId, deviceId: string, input: SealedAgentDispatchInput): Promise<EnqueuedOffer>;
    enqueueSealedAgentEgressOffer(tenant: TenantId, deviceId: string, input: SealedAgentEgressDispatchInput): Promise<EnqueuedOffer>;
    submitSealedAgentExecution(tenant: TenantId, input: SealedAgentExecutionInput): Promise<EnqueuedOffer>;
    /** Host control plane: request one policy-bound content read without a task fallback. */
    enqueueAgentContentRead(tenant: TenantId, deviceId: string, input: AgentContentReadInput): Promise<EnqueuedAgentControl>;
    /** Durable, task-free projection request for precisely one admitted device. */
    enqueueAgentHomeProjection(tenant: TenantId, deviceId: string, input: AgentHomeProjectionInput): Promise<EnqueuedAgentHomeProjection>;
    /** Tenant/device/request-bound durable desired-state and terminal-outcome readback. */
    getAgentHomeProjectionStatus(tenant: TenantId, deviceId: string, input: AgentHomeProjectionStatusInput): Promise<AgentHomeProjectionReadback | undefined>;
    /** Direct device completion endpoint authority; first exact terminal receipt wins. */
    completeAgentHomeProjection(tenant: TenantId, deviceId: string, receipt: AgentHomeProjectionCompletionRequest): Promise<AgentHomeProjectionReadback>;
    /**
     * Durable, task-free remote input preparation for precisely one admitted
     * device. Capability admission, the immutable desired receipt and the
     * mailbox append happen in that order, so a refused call leaves NO receipt
     * and NO delivery row behind.
     */
    enqueueInputPreparation(tenant: TenantId, deviceId: string, input: InputPreparationInput): Promise<EnqueuedInputPreparation>;
    /**
     * Durable, task-free `provider.provisioning.available` notice for precisely
     * one device that durably advertised `provider-provisioning.v1`. The payload
     * is validated strictly before admission, and admission happens before the
     * mailbox append, so a refused call leaves no delivery row behind.
     *
     * Idempotent per (tenant, device, requestId): the mailbox message id is
     * derived from that identity, so a retried enqueue returns the existing row
     * and its seq instead of appending a second notice. The completion and its
     * durable readback are Host authority on Host routes; this plane records no
     * provisioning receipt of its own.
     */
    enqueueProviderProvisioningNotice(tenant: TenantId, deviceId: string, input: ProviderProvisioningNoticeInput): Promise<EnqueuedAgentControl>;
    /**
     * Durable, task-free `agent.memory.intent.available` notice for precisely
     * one device that durably advertised `agent-memory-intent.v1`. The payload
     * is validated strictly before admission, and admission happens before the
     * mailbox append, so a refused call leaves no delivery row behind.
     *
     * Idempotent per (tenant, device, intentId) while the original mailbox row
     * is retained: the mailbox message id is derived from that identity, so a
     * retried enqueue returns the existing row and its seq instead of appending
     * a second notice, and a retry naming a different `agentRef` for the same
     * intent fails `mailbox_receipt_mismatch`. After acked-row retention cleanup
     * a retry appends a new row with a new seq and `agentRef` is no longer
     * compared, so the Host must keep `agentRef` fixed per `intentId`. The
     * device fails closed (`fetch_invalid`/`readback_invalid`) on a mismatched
     * `agentId`, or on a mismatched `profileRevision` once its ledger row is
     * pruned; while the row is live it replays its stored completion without
     * comparing the notice's `profileRevision` (no memory write, no second CAS).
     * Approval, release, completion and readback are Host authority on Host
     * routes; this plane records no intent receipt of its own.
     */
    enqueueAgentMemoryIntentNotice(tenant: TenantId, deviceId: string, input: AgentMemoryIntentNoticeInput): Promise<EnqueuedAgentControl>;
    /**
     * Durable, task-free `e2ee.key_package.available` notice (#654 E2c-3) for
     * one device that durably advertised `sealed-payload-v1`; otherwise it
     * throws `agent_capability_missing` before the mailbox append. The payload
     * is exactly `{ scopeId, epoch }`; the device fetches the package from its
     * device route. Idempotent per (tenant, device, scopeId, epoch) while the
     * mailbox row is retained. `putScopeKeyPackages` calls it for every
     * recipient device that has the capability.
     */
    enqueueScopeKeyPackageNotice(tenant: TenantId, deviceId: string, input: E2eeKeyPackageAvailablePayload): Promise<EnqueuedAgentControl>;
    /** Tenant/device/request-bound durable desired-state and terminal-outcome readback. */
    getInputPreparationStatus(tenant: TenantId, deviceId: string, input: InputPreparationStatusInput): Promise<InputPreparationReadback | undefined>;
    /** Direct device completion endpoint authority; first exact terminal receipt wins. */
    completeInputPreparation(tenant: TenantId, deviceId: string, receipt: InputPreparationCompletionRequest): Promise<InputPreparationReadback>;
    /**
     * Server-side consent revocation and hosted projection erasure. It does not
     * depend on a device being online and never imports anything back locally.
     */
    eraseAgentMemoryProjection(tenant: TenantId, agentId: string): Promise<AgentMemoryProjectionEraseResult>;
    /**
     * Host control plane: replace the stored content of terminal tasks with
     * body-free tombstones (#654 E5a). Status, digests and identity fences stay,
     * so a replay is still a duplicate and new content is still a conflict.
     * Content reads of a redacted task throw `task_content_redacted`.
     * Each task is redacted on its own; a refused task can be retried.
     */
    redactTasks(tenant: TenantId, input: {
        readonly taskIds: readonly string[];
    }): Promise<TaskRedactionResult>;
    /**
     * Host control plane (#654 E2c): append signed member chain entries. First
     * writer wins per seq: an entry already stored with the same bytes is a
     * replay, and a different one throws `e2ee_member_chain_conflict`. The
     * first new entry must follow the stored head. The Host checks shapes and
     * the tenant only; members verify signatures and links.
     *
     * A newly stored `shred` entry, whose subject must be exactly `{ scopeId }`,
     * deletes that scope's key packages and epochs in the same write, marks the
     * scope shredded, and records an `e2ee-scope-shred:<scopeId>` receipt.
     * A newly stored `rotate` entry raises its member's KEM floor to its
     * `kemEpoch` in the same write; a floor never falls.
     */
    appendMemberChainEntries(tenant: TenantId, input: {
        readonly entries: readonly E2eeMemberChainEntry[];
    }): Promise<{
        readonly appended: number;
        readonly replayed: number;
    }>;
    /** Host control plane: member chain entries after `afterSeq` (default 0), ascending, at most `limit` (default and maximum 256). */
    readMemberChain(tenant: TenantId, input?: {
        readonly afterSeq?: number;
        readonly limit?: number;
    }): Promise<{
        readonly entries: readonly E2eeMemberChainEntry[];
    }>;
    /**
     * Host control plane: store version 2 scope key packages. The first package
     * of a scope epoch fixes its `keyId`; a package with another `keyId` throws
     * `e2ee_scope_key_conflict`, and the call stores nothing. A package of a
     * shredded scope throws `e2ee_scope_shredded`, and one whose
     * `recipientKemEpoch` is below its recipient's KEM floor throws
     * `e2ee_scope_key_package_stale`; either way the call stores nothing.
     *
     * After the commit, each recipient that is a registered device gets one
     * `e2ee.key_package.available` notice per scope epoch, also on a replay.
     * A recipient device without `sealed-payload-v1` gets no notice and is
     * listed in `skippedDeviceIds`; its packages are stored all the same.
     */
    putScopeKeyPackages(tenant: TenantId, input: {
        readonly packages: readonly z.infer<typeof E2eeScopeKeyPackageV2Schema>[];
    }): Promise<{
        readonly stored: number;
        readonly skippedDeviceIds: readonly string[];
    }>;
    /** Host control plane: the stored packages of one scope, optionally for one epoch or one recipient. */
    readScopeKeyPackages(tenant: TenantId, input: {
        readonly scopeId: string;
        readonly epoch?: number;
        readonly recipient?: string;
    }): Promise<{
        readonly packages: readonly E2eeScopeKeyPackage[];
    }>;
    /**
     * Host control plane: the member key bundle an active device registered,
     * and its pairing MAC while the pairing window is open (§7.2 step 3).
     */
    readMemberKeyRegistration(tenant: TenantId, deviceId: string): Promise<{
        readonly member: E2eeMemberKeyBundle;
        readonly deviceMac?: string;
    } | undefined>;
    /** Host control plane: relay the client pairing MAC to a registered device (§7.2 step 4). */
    relayClientPairingMac(tenant: TenantId, deviceId: string, input: E2eeClientPairingMac): Promise<void>;
    /** Host control plane: durably request cancellation by tenant/task id. Idempotent. */
    cancelTask(tenant: TenantId, taskId: string, reason?: string): Promise<TaskAttempt>;
    /**
     * Host control plane: settle a task no device will finish. In one store
     * transaction an unfinished attempt becomes `cancelled` with
     * `terminalCause = cause`. Its undelivered mailbox rows on a device that is
     * no longer registered are dead-lettered, so they stop holding mailbox
     * quota; a registered device keeps them pending (its replay floor never
     * passes a row it has not read), acks them as usual, and has its later
     * reports for the task refused. Nothing is sent to a device, so this does
     * not stop a runtime still working on the task: {@link ByokCloud.cancelTask}
     * does. A terminal attempt is returned unchanged. `cause` must be one of
     * `TASK_ABANDON_CAUSES` (`coordination_input_invalid` otherwise); an
     * unknown task throws `task_not_found`. Device revocation and machine
     * supersession apply the same transition by themselves.
     */
    abandonTask(tenant: TenantId, taskId: string, cause: TaskAbandonCause): Promise<TaskAttempt>;
    /**
     * Host control plane: resolve the approval a paused task is waiting on, by
     * enqueueing `task.approve` to the device that claimed it.
     *
     * WHICH approval is a derived fact, not a stored one — see
     * `approval-control.ts` for the fold over the durable timeline that produces
     * it, and why cloud adds no second authority for it. Gate order mirrors the
     * reference server (`packages/server/src/hub.ts`), and every gate is
     * evaluated in full before a mailbox row is allocated, so a refused call has
     * zero side effects:
     *
     *   1. no such task for this tenant -> `task_not_found`;
     *   2. nothing to resolve -> `task_not_awaiting_approval`, which covers a
     *      terminal attempt, an unclaimed one, and a timeline with no unresolved
     *      request (expired or never written). Checked BEFORE targeting, so it
     *      still wins when both would apply;
     *   3. the pending request has no `approvalId` (recorded before wire v4)
     *      -> `task_not_awaiting_approval`;
     *   4. `opts.approvalId` names an approval this task has already superseded
     *      -> {@link StaleApprovalError}.
     *
     * Delivery is a best-effort notification, the same contract the wire message
     * has always had (`TaskApprovePayloadSchema`, `@byok-sdk/protocol`): the
     * enqueued envelope is durable, the runtime's response to it is observable
     * only through that task's own later messages. The outgoing `approvalId` is
     * the pending request's id; `opts.approvalId` is only compared against it
     * (gate 4) and is never sent.
     */
    approveTask(tenant: TenantId, taskId: string, opts?: ApproveTaskOptions): Promise<EnqueuedAgentControl>;
    /**
     * Host control plane: refuse the approval a paused task is waiting on, by
     * enqueueing `task.reject` to the device that claimed it. Same gates, same
     * targeting, and the same best-effort delivery contract as
     * {@link ByokCloud.approveTask} — `opts.reason` is carried to the runtime
     * verbatim and is never synthesized when absent.
     */
    rejectTask(tenant: TenantId, taskId: string, opts?: RejectTaskOptions): Promise<EnqueuedAgentControl>;
    /**
     * Host control plane: inject steering text into a RUNNING task, by enqueueing
     * `task.steer` to the device that claimed it.
     *
     * Gated on the claim-time capability snapshot and on nothing else — see
     * `steer-control.ts` for why that is the only admissible input and why an
     * absent snapshot refuses. Gate order mirrors the old
     * reference server's `ConnectionHub.steerTask`, and every gate is evaluated
     * in full before a mailbox row is allocated, so a refused call has
     * zero side effects:
     *
     *   1. no such task for this tenant -> `task_not_found` ({@link ByokCloudError});
     *   2. terminal attempt -> {@link SteerRejectedError} `task_terminal`,
     *      checked BEFORE the running check so a steer racing a terminal
     *      transition always resolves terminal-first;
     *   3. not running (or running with no owning device) ->
     *      {@link SteerRejectedError} `task_not_running`;
     *   4. the claim snapshot does not positively say `steer: true` ->
     *      {@link SteerRejectedError} `steer_unsupported_runtime`, including when
     *      there is no snapshot at all.
     *
     * Delivery is the same best-effort notification every control message has:
     * the enqueued envelope is durable, and whether the runtime acted on it is
     * observable only through that task's own later messages.
     */
    steerTask(tenant: TenantId, taskId: string, payload: {
        readonly text: string;
    }): Promise<EnqueuedAgentControl>;
    /**
     * The sealed lane of {@link steerTask} (#654): the sealed `task.steer`, with the
     * same gates in the same order, and then the device's durable
     * `sealed-payload-v1` (`agent_capability_missing`). `steerTask` refuses
     * `sealed` and `steerId`.
     */
    steerSealedTask(tenant: TenantId, taskId: string, payload: TaskSteerSealedPayload): Promise<EnqueuedAgentControl>;
    readTaskAttempt(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    /** Read the original executable offer; missing/corrupt authority never becomes a guessed payload. */
    readTaskOffer(tenant: TenantId, taskId: string): Promise<TaskOfferReadback | undefined>;
    /**
     * Host control plane: one bounded page of this tenant's task attempts,
     * keyset-paged by `taskId` — see {@link TaskAttemptListQuery} for why the key
     * is the task id and not a timestamp, and why the walk terminates on an
     * absent `nextCursor` rather than on an empty page.
     * `active: true` selects in-flight statuses without cancellation markers.
     *
     * A non-positive or non-integer `limit` is rejected
     * (`coordination_input_invalid`), never defaulted: the host names the bound.
     */
    listTaskAttempts(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    /** Store-aggregated task counts, with host cancellation separated from coarse status. */
    countTaskAttempts(tenant: TenantId): Promise<import('./stores/ports').TaskAttemptCounts>;
    /** The recorded terminal for a task — the first one, re-encoded canonically under the frozen v1 codec (see `recordTerminal`, `inbound.ts`: the stored body is `encodeEnvelope` of the zod-parsed envelope, not the device's original byte sequence). Throws `task_content_redacted` after {@link ByokCloud.redactTasks}. */
    readTerminalReceipt(tenant: TenantId, taskId: string): Promise<RequestReceipt | undefined>;
    /** Actual device terminal only; cancellation intent never creates this observation. */
    readDeviceTerminal(tenant: TenantId, taskId: string): Promise<DeviceTerminal | undefined>;
    /** Discover first-message transmission evidence from the frozen execution binding, including pending/held without a Host body. */
    readTaskAgentMessageDraft(tenant: TenantId, deviceId: string, taskId: string, agentRef: AgentRef, cursor?: AgentMessageDraftCursor): Promise<AgentMessageDraftReadback | undefined>;
    readTaskAgentMessage(tenant: TenantId, deviceId: string, taskId: string, agentRef: AgentRef): Promise<TaskAgentMessage | undefined>;
    /**
     * Exact durable message decision, independently of task cancellation/terminal.
     * Missing or pending admission returns undefined; invalid persisted evidence
     * throws. The Host supplies the complete original payload, not a Turn ID.
     */
    readAgentMessageDisposition(tenant: TenantId, deviceId: string, taskId: string, payload: AgentMessagePublishPayload): Promise<AgentMessageDispositionPayload | undefined>;
    /** Exact durable egress fact and receipt selected by (tenant, device, AgentRef, event id). */
    readAgentEgress(tenant: TenantId, deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressRecord | undefined>;
    /**
     * Host control plane: the same first terminal, decoded into the typed read
     * model ({@link TerminalResult}) so a host reads result fields, not envelope
     * prose. An accepted host cancellation tombstone outranks a later device
     * receipt; the raw receipt remains readable as device evidence through
     * {@link ByokCloud.readTerminalReceipt}. `undefined` means neither fact
     * exists. An absent `document` means the winning terminal carried none (a
     * non-complete terminal, or an offer with no `result-document` terminal
     * projection); a
     * receipt whose body is not a terminal envelope throws rather than
     * returning a best-effort shape. After {@link ByokCloud.redactTasks} the
     * receipt read throws `task_content_redacted`; a Host cancellation still
     * returns `state: 'cancelled'`, with its reason cleared. With neither fact,
     * an attempt cloud settled itself — {@link ByokCloud.abandonTask}, device
     * revocation or machine supersession — returns `state: 'cancelled'` with
     * that `terminalCause` and the attempt's `terminalAt` as `recordedAt`.
     */
    readTaskResult(tenant: TenantId, taskId: string): Promise<TerminalResult | undefined>;
    listDevices(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    revokeDevice(tenant: TenantId, deviceId: string): Promise<void>;
    /** Host control plane: create a board row from explicit producer labels. */
    createBoardItem(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
    listBoardItems(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
    /** Human review authority. Device routes cannot produce `done`. */
    acceptBoardItem(tenant: TenantId, itemId: string): Promise<BoardItem>;
    listPresence(tenant: TenantId): Promise<readonly PresenceHint[]>;
    /** SDK-owned observation only; never a scheduler or execution authority. */
    readTenantReadiness(tenant: TenantId): Promise<TenantReadiness>;
    readActivity(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
    readApprovalTimeline(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export declare function createByokCloud(options: ByokCloudOptions): ByokCloud;
export {};
// ==== @byok-sdk/cloud dist/composition/in-memory.d.ts ====
/**
 * The in-memory composition: core's reference stores plus cloud's, wired into
 * a working {@link ByokCloud}.
 *
 * This is what the handler suites and the client-side end-to-end test run
 * against, and it is the honest demonstration of the S3 claim — the daemon
 * cannot tell this from `@byok-sdk/server`, and nothing in the path needs a
 * database to prove it.
 */
import { type CapabilityDeclaration, type Clock, type CoreStores, type SkillPackStore } from '@byok-sdk/core';
import { type TokenSigner } from '../auth/tokens';
import type { CloudCrypto } from '../crypto/port';
import { type ByokCloud, type ByokCloudOptions } from '../cloud';
import type { MailboxWake } from '../mailbox-wake';
import type { BlobContentProxy, CloudStores } from '../stores/ports';
import type { TruthCommitter, TruthObjectDownloads } from '../truth/contract';
import type { AgentMemoryProjectionAuthorizer, AgentMemoryProjectionStore } from '../agent-memory-projection';
export interface InMemoryByokCloudOptions {
    readonly clock?: Clock;
    readonly crypto?: CloudCrypto;
    readonly tokenSigner?: TokenSigner;
    readonly capabilities?: CapabilityDeclaration;
    readonly operatorId?: string;
    /** Single-product instance authority; absent leaves the device row as the whole product authority. */
    readonly instanceProductId?: string;
    readonly maxBlobSizeBytes?: number;
    readonly longPollHoldMs?: number;
    readonly mailboxWake?: MailboxWake;
    readonly eventsPageLimit?: number;
    readonly accessTokenTtlSeconds?: number;
    readonly boardPageLimit?: number;
    readonly boardStreamQueryIntervalMs?: number;
    readonly boardStreamHeartbeatIntervalMs?: number;
    readonly boardStreamReconciliationIntervalMs?: number;
    readonly boardChannelMaxBytes?: number;
    readonly boardTitleMaxBytes?: number;
    readonly presenceTtlMs?: number;
    readonly presenceMinimumIntervalMs?: number;
    readonly presenceDetailMaxBytes?: number;
    readonly activityMaxEvents?: number;
    readonly activityMaxBytes?: number;
    readonly activityCapacity?: number;
    readonly activityTtlMs?: number;
    /** Test/host supplied atomic truth authority; never synthesized from sequential stores. */
    readonly truthCommitter?: TruthCommitter;
    readonly truthObjectDownloads?: TruthObjectDownloads;
    readonly maxTruthRequestBytes?: number;
    /**
     * Host/test supplied skill pack catalogue. Absent by default; the default
     * declaration names `skills.pack` exactly when it is supplied.
     */
    readonly skillPacks?: SkillPackStore;
    readonly skillPackPageLimit?: number;
    readonly agentMessage?: ByokCloudOptions['agentMessage'];
    /** Post-commit relay; absent means nothing is watching. */
    readonly observer?: ByokCloudOptions['observer'];
    /** Unauthenticated-route admission; absent means no limit. */
    readonly publicRouteLimiter?: ByokCloudOptions['publicRouteLimiter'];
    readonly agentMemoryProjectionAuthorizer?: AgentMemoryProjectionAuthorizer;
    readonly agentMemoryProjectionStore?: AgentMemoryProjectionStore;
}
export interface InMemoryByokCloud {
    readonly mailboxWake: MailboxWake;
    readonly cloud: ByokCloud;
    /** The naked stores, for a host that wants to inspect or seed state directly. */
    readonly core: CoreStores;
    readonly stores: CloudStores;
    /** The byte proxy the two `/content` routes were mounted on. */
    readonly blobContentProxy: BlobContentProxy;
    readonly clock: Clock;
    readonly crypto: CloudCrypto;
}
export declare function createInMemoryByokCloud(options?: InMemoryByokCloudOptions): InMemoryByokCloud;
// ==== @byok-sdk/cloud dist/coordination-client.d.ts ====
import { type CapabilityDeclaration } from '@byok-sdk/core';
import { z } from 'zod';
declare const BoardFeedItemSchema: z.ZodObject<{
    tenantId: z.ZodString;
    itemId: z.ZodString;
    channel: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
        closed: "closed";
        done: "done";
        in_progress: "in_progress";
        in_review: "in_review";
        todo: "todo";
    }>;
    assignee: z.ZodOptional<z.ZodObject<{
        holderId: z.ZodString;
        heldSince: z.ZodString;
    }, z.core.$strip>>;
    boardSeq: z.ZodNumber;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
declare const BoardFeedPageSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        tenantId: z.ZodString;
        itemId: z.ZodString;
        channel: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            closed: "closed";
            done: "done";
            in_progress: "in_progress";
            in_review: "in_review";
            todo: "todo";
        }>;
        assignee: z.ZodOptional<z.ZodObject<{
            holderId: z.ZodString;
            heldSince: z.ZodString;
        }, z.core.$strip>>;
        boardSeq: z.ZodNumber;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    nextSeq: z.ZodNumber;
    hasMore: z.ZodBoolean;
}, z.core.$strip>;
export type BoardFeedItem = z.infer<typeof BoardFeedItemSchema>;
export type BoardFeedPage = z.infer<typeof BoardFeedPageSchema>;
export type BoardFeedMode = 'sse' | 'poll';
export type BoardFeedRead = {
    readonly type: 'board';
    readonly item: BoardFeedItem;
} | {
    readonly type: 'reconcile';
} | {
    readonly type: 'poll';
    readonly page: BoardFeedPage;
};
export declare class BoardFeedRetryableError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BoardFeedStoppedError extends Error {
    constructor(message: string);
}
export interface BoardFeedClientOptions {
    readonly baseUrl: string | URL;
    readonly accessToken: string;
    readonly capabilities: CapabilityDeclaration;
    readonly fetch?: typeof globalThis.fetch;
    readonly idleWatchdogMs?: number;
}
/**
 * One board feed consumer with a declaration-fixed transport.
 *
 * The mode is selected once from ADR-010 data. A temporary SSE 5xx or idle
 * watchdog expiry raises {@link BoardFeedRetryableError}; it never mutates the
 * mode to polling. A caller retries the same instance and therefore the same
 * declared transport. Polling exists only when `board.sse` was absent from the
 * declaration in the first place.
 */
export declare class BoardFeedClient {
    #private;
    readonly mode: BoardFeedMode;
    constructor(options: BoardFeedClientOptions);
    readOnce(afterSeq: number, signal?: AbortSignal): Promise<BoardFeedRead>;
}
export {};
// ==== @byok-sdk/cloud dist/coordination.d.ts ====
import type { AgentEventOrUnknown } from '@byok-sdk/protocol';
import { type ActivityAppendInput, type ActivityTail } from './activity';
import type { TenantBoundActivity } from './tenant-stores';
export declare const DEFAULT_BOARD_CHANNEL_MAX_BYTES = 128;
export declare const DEFAULT_BOARD_TITLE_MAX_BYTES = 512;
export { DEFAULT_ACTIVITY_CAPACITY } from './activity';
export declare const DEFAULT_ACTIVITY_TTL_MS: number;
export declare const DEFAULT_PRESENCE_TTL_MS = 90000;
export declare const DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS = 5000;
export declare const DEFAULT_PRESENCE_DETAIL_MAX_BYTES = 512;
export interface ActivityBounds {
    readonly maxEvents: number;
    readonly maxBytes: number;
    readonly capacity: number;
    readonly ttlMs: number;
}
/**
 * The deployment's default activity limits. The device surface advertises the
 * effective `maxEvents`/`maxBytes` as `ingress` (events pages and accepted
 * handshake answers); daemons have no default of their own.
 */
export declare const DEFAULT_ACTIVITY_BOUNDS: ActivityBounds;
export declare function assertBoardLabels(channel: string, title: string, limits: {
    readonly channelMaxBytes: number;
    readonly titleMaxBytes: number;
}): void;
/**
 * The page bound on {@link TaskAttemptStore.list}. Fail-closed rather than
 * defaulted or clamped: a caller that asks for `0`, `-1`, `2.5`, or `Infinity`
 * has a bug, and answering it with a silently substituted limit hides that bug
 * behind a plausible page. Enforced in the STORE rather than only at the
 * façade, because the port is reachable directly by a host composition.
 */
export declare function assertTaskAttemptListLimit(limit: number, active?: true): void;
export declare function validateActivityEvents(events: readonly AgentEventOrUnknown[], dropped: number, bounds: ActivityBounds): void;
type ActivityBatch = ActivityAppendInput extends infer Input ? Input extends ActivityAppendInput ? Omit<Input, 'ttlMs' | 'capacity'> : never : never;
/**
 * A plaintext batch is checked against the event and byte bounds. A sealed
 * batch hides its events; the inbound gate admits it inline only.
 */
export declare function validateActivityBatch(input: ActivityBatch, bounds: ActivityBounds): void;
export declare function appendActivityEvents(activity: TenantBoundActivity, input: ActivityBatch, bounds: ActivityBounds): Promise<ActivityTail>;
// ==== @byok-sdk/cloud dist/crypto/port.d.ts ====
/**
 * The crypto seam.
 *
 * `@byok-sdk/server` reaches straight for `node:crypto`. Cloud cannot: a hosted
 * composition has to load on Workers and Deno too, and `src/__tests__/
 * constraints.test.ts` asserts this package never imports a `node:` module.
 * So every primitive the device surface needs — random identifiers, Ed25519
 * verification of a challenge signature, HMAC for presigned blob URLs,
 * SHA-256 for content addressing — arrives through this port.
 *
 * `web-crypto.ts` in this directory is the reference implementation, built on
 * the WebCrypto API that Node >=20, Workers, and Deno all expose as
 * `globalThis.crypto`. A composition backed by a KMS or an HSM supplies its
 * own instead.
 */
export interface CloudCrypto {
    /** A fresh UUID v4 — envelope ids, device ids, blob ids, task ids. */
    randomUuid(): string;
    /** `byteLength` random bytes, base64url-encoded — nonces and opaque tokens. */
    randomToken(byteLength: number): string;
    /** A short, human-typeable pairing code (uppercase, unambiguous alphabet). */
    randomPairingCode(length: number): string;
    /**
     * Verify `signature` (base64url) over `message` against
     * `publicKeyBase64Url` — a raw 32-byte Ed25519 public key in the same
     * base64url encoding a JWK's `x` field uses, which is what a device
     * registers at pairing time. String input is encoded as UTF-8; byte input is
     * used verbatim so core's frozen device-proof signing bytes are not decoded
     * and re-encoded by the adapter.
     *
     * Never throws: a malformed key or signature is a failed verification, not
     * an exception a route has to translate.
     */
    verifyEd25519(publicKeyBase64Url: string, message: string | Uint8Array, signature: string): Promise<boolean>;
    /** HMAC-SHA-256 over `message`, base64url-encoded. Used for presigned blob URLs. */
    hmacSha256(secret: Uint8Array, message: string): Promise<string>;
    /** SHA-256 of `data`, in core's canonical `sha256:<64 lowercase hex>` form. */
    sha256(data: Uint8Array): Promise<string>;
    /**
     * Length-independent equality for two base64url strings. Signature
     * comparison must not leak a prefix through timing.
     */
    timingSafeEqual(left: string, right: string): boolean;
}
// ==== @byok-sdk/cloud dist/crypto/web-crypto.d.ts ====
/**
 * The reference {@link CloudCrypto}, built entirely on the WebCrypto API that
 * Node >=20, Cloudflare Workers, and Deno all expose as `globalThis.crypto`.
 *
 * No `node:crypto`, no dependency: the point of the port is that a hosted
 * composition stays runtime-neutral, and an adapter that reached for a Node
 * built-in here would make that claim false for the default composition.
 */
import type { CloudCrypto } from './port';
export declare function base64UrlEncode(bytes: Uint8Array): string;
/**
 * Decode base64url. Returns `undefined` rather than throwing for input that
 * is not base64url at all — every caller here is verifying attacker-supplied
 * material, where "not decodable" and "does not verify" must be the same
 * answer.
 */
export declare function base64UrlDecode(value: string): Uint8Array | undefined;
/**
 * WebCrypto's own types are derived from the runtime's `globalThis.crypto`
 * rather than named directly: `CryptoKey`/`SubtleCrypto`/`KeyUsage` are DOM
 * lib globals, and this package compiles without the DOM lib (a Workers build
 * has no DOM either). Deriving keeps the types exact without pulling in a
 * `node:` import or widening `lib`.
 */
export type SubtleCryptoLike = typeof globalThis.crypto.subtle;
export type CryptoKeyLike = Awaited<ReturnType<SubtleCryptoLike['importKey']>>;
export type KeyUsageLike = Parameters<SubtleCryptoLike['importKey']>[4][number];
export declare function createWebCrypto(): CloudCrypto;
// ==== @byok-sdk/cloud dist/e2ee-member.d.ts ====
/**
 * Host storage for member keys, the member chain and scope key packages
 * (#654 design §7.2–§7.4, E2c), and the Host part of crypto-shredding
 * (§11.2, E5b-1).
 *
 * The Host holds no key. It checks shapes, keeps the chain contiguous and
 * first-writer-wins per seq, fixes one `keyId` per scope epoch, and relays
 * the pairing MACs. Members verify everything else (§7.3).
 *
 * A `shred` entry deletes its scope's key packages and epochs in the append
 * that stores it, and later package puts for that scope are refused. The
 * Host verifies no signature, so any paired device of the tenant can append
 * a well-shaped `shred` (owner batch §50g A, `docs/security.md`).
 *
 * Every input is read once into canonical JSON text. The store keeps that
 * text, so a replay compares by bytes and a later read returns the same
 * bytes the writer sent.
 */
import { type TenantId } from '@byok-sdk/core';
import { E2eeScopeKeyPackageV2Schema, type E2eeClientPairingMac, type E2eeKeyPackageAvailablePayload, type E2eeMemberChainEntry, type E2eeMemberKeyBundle, type E2eeScopeKeyPackage } from '@byok-sdk/protocol';
import { z } from 'zod';
import type { DeviceDirectory } from './stores/ports';
/** One stored chain entry: its seq and its canonical JSON. */
export interface E2eeMemberChainRow {
    readonly seq: number;
    readonly entry: string;
}
/**
 * The binding of a device-proof write (owner batch §41a A). The proof's
 * `requestId` is single-use per device, as on the truth put: a store records
 * it with the write and its result. A later write with the same `requestId`
 * and the same binding gets the stored result and writes nothing; one with
 * another binding is refused.
 */
export interface E2eeProofRequest {
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly bodySha256: string;
    readonly bodySize: number;
}
/** A device write: the proven device and its proof binding. A Host control-plane write has none. */
export interface E2eeProvenWrite {
    readonly deviceId: string;
    readonly request: E2eeProofRequest;
}
/** The audit receipt key prefix of a scope shred. It is an identity receipt and never expires. */
export declare const E2EE_SCOPE_SHRED_RECEIPT_PREFIX = "e2ee-scope-shred:";
/** A `shred` entry of an append, read by cloud from the entry's strict subject. */
export interface E2eeScopeShred {
    /** The seq of the `shred` entry. It is one of the appended rows. */
    readonly seq: number;
    readonly scopeId: string;
    /** The audit receipt cloud built. The store writes it in the receipt store, first writer wins. */
    readonly receipt: {
        readonly key: string;
        readonly body: string;
    };
}
export interface E2eeMemberChainAppendInput {
    readonly rows: readonly E2eeMemberChainRow[];
    /** The `shred` entries among `rows`, in seq order. */
    readonly shreds: readonly E2eeScopeShred[];
    /** The `rotate` entries among `rows`, in seq order: each raises its member's KEM floor (owner batch §77a). */
    readonly rotations: readonly {
        readonly seq: number;
        readonly memberId: string;
        readonly kemEpoch: number;
    }[];
    /** Set for a device write, absent for a Host control-plane write. */
    readonly proof?: E2eeProvenWrite;
}
/** Who wrote: the Host control plane, or a device through its proof route. A shred receipt records it. */
export type E2eeMemberWriter = {
    readonly kind: 'host';
} | {
    readonly kind: 'device';
    readonly proof: E2eeProvenWrite;
};
export type E2eeMemberChainAppendResult = {
    readonly outcome: 'appended';
    /** New rows written. */
    readonly appended: number;
    /** Rows already stored with the same bytes. */
    readonly replayed: number;
}
/** A different entry is stored at `seq`. Nothing was written. */
 | {
    readonly outcome: 'conflict';
    readonly seq: number;
}
/** The first new entry does not follow the stored head. Nothing was written. */
 | {
    readonly outcome: 'gap';
    readonly seq: number;
    readonly headSeq: number;
}
/** The device already used this `requestId` with another binding. Nothing was written. */
 | {
    readonly outcome: 'request_conflict';
};
/** One stored scope key package, with the columns the store keys and filters on. */
export interface E2eeScopeKeyPackageRow {
    readonly scopeId: string;
    readonly epoch: number;
    readonly recipient: string;
    readonly keyId: string;
    readonly sender: string;
    /** Canonical JSON of the package. */
    readonly package: string;
}
export interface E2eeScopeKeyPackagePutInput {
    /**
     * Sorted by `(scopeId, epoch, recipient)` in code point order, one row per
     * scope epoch and recipient. `recipientKemEpoch` is the package's own field,
     * for the floor check only; the store keeps it in `package` and nowhere else.
     */
    readonly rows: readonly (E2eeScopeKeyPackageRow & {
        readonly recipientKemEpoch: number;
    })[];
    /** Set for a device write, absent for a Host control-plane write. */
    readonly proof?: E2eeProvenWrite;
}
export type E2eeScopeKeyPackagePutResult = {
    readonly outcome: 'stored';
    readonly stored: number;
}
/** The first package of this scope epoch fixed another `keyId`. Nothing was written. */
 | {
    readonly outcome: 'key_id_conflict';
    readonly scopeId: string;
    readonly epoch: number;
    readonly keyId: string;
}
/** The member chain shredded this scope. Nothing was written. */
 | {
    readonly outcome: 'scope_shredded';
    readonly scopeId: string;
}
/** A package is wrapped to an older KEM epoch than its recipient's floor. Nothing was written. */
 | {
    readonly outcome: 'kem_epoch_stale';
    readonly recipient: string;
    readonly kemEpoch: number;
    readonly floor: number;
}
/** The device already used this `requestId` with another binding. Nothing was written. */
 | {
    readonly outcome: 'request_conflict';
};
export interface E2eeMemberRegistrationInput {
    readonly deviceId: string;
    readonly memberId: string;
    /** Canonical JSON of the device's member key bundle. */
    readonly bundle: string;
    /** The device pairing MAC (§7.2 step 3). */
    readonly deviceMac: string;
    readonly macExpiresAt: string;
    /** The proof binding of the registration write; its device is `deviceId`. */
    readonly request: E2eeProofRequest;
}
/**
 * - `registered`: the bundle and the MAC were stored.
 * - `replayed`: the same bundle was already stored; the MAC and its expiry were replaced.
 * - `device_conflict`: the device registered another bundle. Nothing changed.
 * - `member_conflict`: another device registered this member id. Nothing changed.
 * - `request_conflict`: the device already used this `requestId` with another binding. Nothing changed.
 */
export type E2eeMemberRegisterResult = 'registered' | 'replayed' | 'device_conflict' | 'member_conflict' | 'request_conflict';
export interface E2eeMemberRegistrationRow {
    readonly memberId: string;
    /** Canonical JSON of the bundle. */
    readonly bundle: string;
    /** Absent once the pairing window has passed. */
    readonly deviceMac?: string;
}
/**
 * Durable E2EE member state. Every method is scoped to `tenant`. Each write
 * is atomic: a refused write leaves nothing behind.
 *
 * A device write carries its proof binding (`proof`, or `request` on a
 * registration). In the same atomic write, the store records the device's
 * `requestId`, its binding and the write's result. If that `requestId` is
 * already recorded for the device, the store writes nothing: with the same
 * binding it returns the recorded result, and with another binding it
 * returns `request_conflict`. A refused write records nothing.
 */
export interface E2eeMemberStore {
    /**
     * Rows have contiguous ascending seqs. A row at a stored seq must hold the
     * same bytes (a replay). The first new row must be the stored head plus one.
     *
     * For each shred whose row this call newly stores, in the same atomic
     * write: delete the scope's key packages, then its epochs, record the scope
     * as shredded with the seq of its first shred, and record the shred's
     * receipt in the deployment's request receipt store unless that key is
     * already there. A replayed row shreds nothing again. A refused append
     * deletes nothing. A store that has concurrent writers serializes each
     * shred with every package put of the same scope.
     *
     * For each rotation whose row this call newly stores, in the same atomic
     * write: raise the member's KEM floor to `kemEpoch`; a floor never falls.
     * A store that has concurrent writers serializes it with every package put
     * to that member.
     */
    appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult>;
    /** Entries with `seq > afterSeq`, ascending, at most `limit`. */
    readChainEntries(tenant: TenantId, input: {
        readonly afterSeq: number;
        readonly limit: number;
    }): Promise<readonly E2eeMemberChainRow[]>;
    /**
     * A row of a shredded scope refuses the whole put. Then a row whose
     * `recipientKemEpoch` is below its recipient's KEM floor refuses the whole
     * put, naming the first such row. The first package of a
     * `(scopeId, epoch)` fixes its `keyId`, also within this call: a second
     * `keyId` for that scope epoch refuses the whole put. A package with that
     * `keyId` inserts or replaces the row of its recipient.
     */
    putScopeKeyPackages(tenant: TenantId, input: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult>;
    /** This recipient's packages of one scope with `epoch > afterEpoch`, by epoch, at most `limit`; and the scope's newest epoch. */
    readOwnScopeKeyPackages(tenant: TenantId, input: {
        readonly scopeId: string;
        readonly recipient: string;
        readonly afterEpoch: number;
        readonly limit: number;
    }): Promise<{
        readonly rows: readonly E2eeScopeKeyPackageRow[];
        readonly scopeHeadEpoch: number | undefined;
    }>;
    /** Ordered by epoch, then recipient. */
    readScopeKeyPackages(tenant: TenantId, input: {
        readonly scopeId: string;
        readonly epoch?: number;
        readonly recipient?: string;
    }): Promise<readonly E2eeScopeKeyPackageRow[]>;
    registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult>;
    /** The MAC is returned only while `now` is before its expiry. */
    readMemberRegistration(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly now: string;
    }): Promise<E2eeMemberRegistrationRow | undefined>;
    /** Store or replace the client pairing MAC (§7.2 step 4) of a registered device. */
    putClientPairingMac(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly body: string;
        readonly expiresAt: string;
    }): Promise<'stored' | 'not_registered'>;
    /** Canonical JSON of the client MAC, while `now` is before its expiry. */
    readClientPairingMac(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly now: string;
    }): Promise<string | undefined>;
}
/**
 * The result a store recorded with a device write, read back for a replay.
 * A store records only a successful result, so any other stored text breaks
 * the store contract and fails closed.
 */
export declare function parseRecordedWriteResult(write: 'chainAppend', text: string): Extract<E2eeMemberChainAppendResult, {
    readonly outcome: 'appended';
}>;
export declare function parseRecordedWriteResult(write: 'keyPackagePut', text: string): Extract<E2eeScopeKeyPackagePutResult, {
    readonly outcome: 'stored';
}>;
export declare function parseRecordedWriteResult(write: 'memberKeyRegister', text: string): Extract<E2eeMemberRegisterResult, 'registered' | 'replayed'>;
export interface E2eeMemberContext {
    readonly store: E2eeMemberStore;
    readonly tenant: TenantId;
    readonly devices: DeviceDirectory;
    readonly now: () => Date;
    /** Enqueue `e2ee.key_package.available` for one device; it refuses a device without the gate capability. */
    readonly enqueueKeyPackageNotice: (deviceId: string, payload: E2eeKeyPackageAvailablePayload) => Promise<unknown>;
}
export declare function appendMemberChainEntries(ctx: E2eeMemberContext, input: {
    readonly entries: readonly E2eeMemberChainEntry[];
}, writer: E2eeMemberWriter): Promise<{
    readonly appended: number;
    readonly replayed: number;
}>;
export declare function readMemberChain(ctx: E2eeMemberContext, input?: {
    readonly afterSeq?: number;
    readonly limit?: number;
}): Promise<{
    readonly entries: readonly E2eeMemberChainEntry[];
}>;
export declare function putScopeKeyPackages(ctx: E2eeMemberContext, input: {
    readonly packages: readonly z.infer<typeof E2eeScopeKeyPackageV2Schema>[];
}, writer: E2eeMemberWriter): Promise<{
    readonly stored: number;
    readonly skippedDeviceIds: readonly string[];
}>;
export declare function readScopeKeyPackages(ctx: E2eeMemberContext, input: {
    readonly scopeId: string;
    readonly epoch?: number;
    readonly recipient?: string;
}): Promise<{
    readonly packages: readonly E2eeScopeKeyPackage[];
}>;
/**
 * The bundle a device registered, and its pairing MAC while the pairing
 * window is open. A missing or revoked device has none, even if a cleanup
 * missed its rows.
 */
export declare function readMemberKeyRegistration(ctx: E2eeMemberContext, deviceId: string): Promise<{
    readonly member: E2eeMemberKeyBundle;
    readonly deviceMac?: string;
} | undefined>;
/** Relay the client pairing MAC to a registered device for one pairing window. */
export declare function relayClientPairingMac(ctx: E2eeMemberContext, deviceId: string, input: E2eeClientPairingMac): Promise<void>;
/**
 * A device registers its own member key bundle with the device pairing MAC
 * (§7.2 step 3). The bundle must name the proven device. The MAC is kept for
 * one pairing window; a retry with the same bundle replaces the MAC and its expiry.
 */
export declare function registerDeviceMemberKey(ctx: E2eeMemberContext, proof: E2eeProvenWrite, input: unknown): Promise<{
    readonly memberId: string;
}>;
/**
 * The scope key packages addressed to the device's own registered member,
 * with exactly one of `epoch` (that epoch) or `afterEpoch` (one page after
 * it, by epoch, and the scope's newest epoch or `null`).
 */
export declare function readDeviceScopeKeyPackages(ctx: E2eeMemberContext, deviceId: string, input: {
    readonly scopeId: string;
    readonly epoch?: number;
    readonly afterEpoch?: number;
}): Promise<{
    readonly packages: readonly E2eeScopeKeyPackage[];
    readonly scopeHeadEpoch?: number | null;
}>;
/** The client pairing MAC relayed to the device, while its pairing window is open. */
export declare function readDeviceClientPairingMac(ctx: E2eeMemberContext, deviceId: string): Promise<E2eeClientPairingMac | undefined>;
// ==== @byok-sdk/cloud dist/errors.d.ts ====
/**
 * The one error taxonomy for `@byok-sdk/cloud`.
 *
 * Same idiom as `@byok-sdk/core`'s `errors.ts`: one class, code-based branching,
 * so a composition maps failures onto HTTP with a code table instead of an
 * `instanceof` chain. Cloud does not re-export core's codes — a cloud error is
 * about the hosted surface (a store contract the composition broke, a
 * declaration the host mis-configured), and core errors travel up unchanged.
 */
export declare const CLOUD_ERROR_CODES: {
    readonly maintenance_invalid_input: 'maintenance_invalid_input';
    readonly maintenance_result_invalid: 'maintenance_result_invalid';
    /** A pairing code that is unknown, expired, or already redeemed (§6.1). */
    readonly pairing_code_invalid: 'pairing_code_invalid';
    /** The composition handed a device row whose tenant is not a mintable `TenantId`. */
    readonly device_tenant_invalid: 'device_tenant_invalid';
    /**
     * The mailbox committed a row `seq` that disagrees with the delivery `seq`
     * its body factory baked into the envelope. Loud rather than silent: those
     * two numbers ARE the daemon's redelivery cursor.
     */
    readonly mailbox_seq_mismatch: 'mailbox_seq_mismatch';
    /** A capability declaration the host supplied that core refused. */
    readonly capability_declaration_invalid: 'capability_declaration_invalid';
    /**
     * The declaration names a capability this composition cannot serve, so the
     * deployment would publish a surface it does not have (ADR-010).
     *
     * Construction-time and fatal. A client learns what a deployment supports by
     * READING the declaration and is entitled to act on it without probing, so a
     * declaration that over-states is not a degraded deployment — it is a
     * deployment whose one honest interface lies.
     */
    readonly capability_over_declared: 'capability_over_declared';
    /**
     * The composition was given a port whose capability the declaration does not
     * name (#1096). Construction-time and fatal: the port would never be mounted,
     * so passing it is a wiring mistake, not a rollout switch. Declare the
     * capability or stop passing the port.
     */
    readonly capability_port_undeclared: 'capability_port_undeclared';
    /** Host-supplied board labels or coordination input exceeded the explicit contract. */
    readonly coordination_input_invalid: 'coordination_input_invalid';
    /**
     * A terminal receipt whose stored body is not a terminal envelope — either
     * undecodable or a non-terminal type. Whatever wrote that row broke the
     * receipt-store contract, so the typed read model fails closed instead of
     * projecting a best-effort shape.
     */
    readonly terminal_receipt_unreadable: 'terminal_receipt_unreadable';
    /** A progress/activity batch exceeded the configured event or byte ceiling. */
    readonly activity_batch_too_large: 'activity_batch_too_large';
    /** Host control-plane task lookup is tenant-closed and found no task. */
    readonly task_not_found: 'task_not_found';
    /** A Host read named a task whose content `redactTasks` replaced with a tombstone. */
    readonly task_content_redacted: 'task_content_redacted';
    /** `redactTasks` was called on a deployment that has no `taskRedactionStore`. */
    readonly task_redaction_unavailable: 'task_redaction_unavailable';
    /** An E2EE member call on a deployment that has no `e2eeMemberStore`. */
    readonly e2ee_member_store_unavailable: 'e2ee_member_store_unavailable';
    /** A different member chain entry is stored at that seq, or the first new entry does not follow the head. Read the chain again. */
    readonly e2ee_member_chain_conflict: 'e2ee_member_chain_conflict';
    /** The first package of that scope epoch fixed another `keyId`. */
    readonly e2ee_scope_key_conflict: 'e2ee_scope_key_conflict';
    /** The member chain shredded that scope (design §11.2), so the Host stores no more key packages for it. */
    readonly e2ee_scope_shredded: 'e2ee_scope_shredded';
    /** A package is wrapped to an older KEM epoch than its recipient's latest `rotate` on the member chain. Read the chain again and seal again. */
    readonly e2ee_scope_key_package_stale: 'e2ee_scope_key_package_stale';
    /** The device already used this device-proof `requestId` with another request. A proof is single-use. */
    readonly proof_request_conflict: 'proof_request_conflict';
    /** The device has not registered a member key bundle. */
    readonly e2ee_member_not_registered: 'e2ee_member_not_registered';
    /** The device registered another member key bundle, or another device registered this member id. */
    readonly e2ee_member_key_conflict: 'e2ee_member_key_conflict';
    /** A stored E2EE member row is not the value its schema requires. Whatever wrote it broke the store contract. */
    readonly e2ee_member_state_unreadable: 'e2ee_member_state_unreadable';
    /** Explicit legacy dispatch target is unknown or revoked in this tenant. */
    readonly device_not_found: 'device_not_found';
    /**
     * A host `approveTask`/`rejectTask` names a task with no approval to
     * resolve: the durable timeline holds no unresolved `approval_requested`
     * (including a tail that has expired or was never written), the attempt has
     * already reached a terminal status, or no device ever claimed it so there
     * is nothing to notify. Fail-closed by construction — cloud never invents a
     * pending approval to make the call succeed.
     */
    readonly task_not_awaiting_approval: 'task_not_awaiting_approval';
    /** Durable target-device capability is absent, revoked, or unavailable. */
    readonly agent_capability_missing: 'agent_capability_missing';
    /** Inbound Agent identity did not exactly match the offered identity. */
    readonly agent_ref_mismatch: 'agent_ref_mismatch';
    /** A strict Agent task id already names a durable attempt and cannot be re-enqueued. */
    readonly agent_task_already_exists: 'agent_task_already_exists';
    /**
     * A task attempt was opened but the mailbox refused its offer append, so the
     * device never saw it. Raised as {@link TaskOfferAppendRefusedError}, which
     * names the task so the Host can retry with that `taskId` (the retry
     * converges on the one offer) or cancel it; `cause` is the store's refusal,
     * e.g. a core `storage_quota_exceeded`.
     */
    readonly task_offer_append_refused: 'task_offer_append_refused';
    /** A first-write-wins Agent control record was replayed with a different body. */
    readonly agent_content_request_mismatch: 'agent_content_request_mismatch';
    /** A durable mailbox receipt id resolved to an envelope other than its exact acknowledgement. */
    readonly mailbox_receipt_mismatch: 'mailbox_receipt_mismatch';
    /** A task-free Agent-home request id already names a different immutable desired projection. */
    readonly agent_home_projection_request_conflict: 'agent_home_projection_request_conflict';
    /** A direct Agent-home completion did not identify a stored desired request for this exact device. */
    readonly agent_home_projection_request_not_found: 'agent_home_projection_request_not_found';
    /** A direct Agent-home completion changed the first durable terminal outcome. */
    readonly agent_home_projection_completion_conflict: 'agent_home_projection_completion_conflict';
    /** A task-free completion did not exactly echo its immutable desired projection binding. */
    readonly agent_home_projection_receipt_mismatch: 'agent_home_projection_receipt_mismatch';
    /** A receipt-store row at the projection namespace violated the frozen projection schema. */
    readonly agent_home_projection_receipt_invalid: 'agent_home_projection_receipt_invalid';
    /** A remote input-preparation request id already names a different immutable desired request. */
    readonly input_preparation_request_conflict: 'input_preparation_request_conflict';
    /** A device completion did not identify a stored desired request for this exact device. */
    readonly input_preparation_request_not_found: 'input_preparation_request_not_found';
    /** A device completion changed the first durable terminal outcome. */
    readonly input_preparation_completion_conflict: 'input_preparation_completion_conflict';
    /** A completion did not exactly echo its immutable desired request/Agent/policy binding. */
    readonly input_preparation_receipt_mismatch: 'input_preparation_receipt_mismatch';
    /** A receipt-store row at the preparation namespace violated the frozen schema. */
    readonly input_preparation_receipt_invalid: 'input_preparation_receipt_invalid';
    /** A hosted Agent-memory mutation did not match the durable task/device/AgentRef binding. */
    readonly agent_memory_projection_task_mismatch: 'agent_memory_projection_task_mismatch';
    /** The embedder-owned grant/consent authority denied a hosted memory mutation. */
    readonly agent_memory_projection_authorization_denied: 'agent_memory_projection_authorization_denied';
    /** A redacted snapshot's decoded bytes did not match its declared hash or byte count. */
    readonly agent_memory_projection_hash_mismatch: 'agent_memory_projection_hash_mismatch';
    /** A writer epoch/source sequence already names a different immutable projection mutation. */
    readonly agent_memory_projection_replay_mismatch: 'agent_memory_projection_replay_mismatch';
    /** A hosted memory mutation came from an older writer epoch. */
    readonly agent_memory_projection_stale_epoch: 'agent_memory_projection_stale_epoch';
    /** A server-side erase fence prevents a deleted writer epoch from re-entering. */
    readonly agent_memory_projection_erased_epoch: 'agent_memory_projection_erased_epoch';
    /** A prior erase reached the protocol writer-epoch ceiling and cannot mint a later writer. */
    readonly agent_memory_projection_epoch_exhausted: 'agent_memory_projection_epoch_exhausted';
    /** A hosted memory mutation skipped or reset a required source sequence. */
    readonly agent_memory_projection_sequence_gap: 'agent_memory_projection_sequence_gap';
};
export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];
export declare class ByokCloudError extends Error {
    readonly code: CloudErrorCode;
    constructor(code: CloudErrorCode, message: string, options?: ErrorOptions);
}
/**
 * The one cloud error that carries a task identity: a refused offer append
 * after the attempt opened. Without `taskId` a Host that let cloud allocate the
 * id could neither retry nor cancel the attempt it now owns.
 */
export declare class TaskOfferAppendRefusedError extends ByokCloudError {
    readonly taskId: string;
    constructor(taskId: string, cause: unknown);
}
export declare function isCloudError(value: unknown, code?: CloudErrorCode): value is ByokCloudError;
// ==== @byok-sdk/cloud dist/handlers/board.d.ts ====
import { type BoardPage } from '@byok-sdk/core';
import type { Context } from 'hono';
import { type DeviceRouteDeps } from './shared';
export declare const DEFAULT_BOARD_PAGE_LIMIT = 50;
export declare const DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS = 5000;
export declare const DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS = 15000;
export declare const DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS = 120000;
export interface BoardRouteDeps extends DeviceRouteDeps {
    readonly pageLimit: number;
}
export interface BoardStreamRouteDeps extends BoardRouteDeps {
    readonly queryIntervalMs: number;
    readonly heartbeatIntervalMs: number;
    readonly reconciliationIntervalMs: number;
}
/** Claim and status bodies carry one or two status names. */
export declare const BOARD_MUTATION_MAX_BODY_BYTES: number;
export declare function boardListHandler(deps: BoardRouteDeps): (c: Context) => Promise<Response>;
export declare function boardClaimHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardUnclaimHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardStatusHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardStreamHandler(deps: BoardStreamRouteDeps): (c: Context) => Promise<Response>;
export type BoardPollResponse = BoardPage;
// ==== @byok-sdk/cloud dist/handlers/device-proof-request.d.ts ====
import type { Context } from 'hono';
import { type AuthenticatedDeviceProof, type DeviceProofAuthDeps } from '../auth/device-proof';
export declare const MAX_DEVICE_PROOF_HEADER_BYTES: number;
/** The raw request body, `'too_large'` over `maximum`, or `undefined` for an unreadable body. */
export declare function readProofRequestBody(c: Context, maximum: number): Promise<Uint8Array | 'too_large' | undefined>;
/** `undefined` means "answer 401", for every refused proof alike. */
export declare function authenticateProofRequest(c: Context, deps: DeviceProofAuthDeps, request: {
    readonly body: Uint8Array;
    readonly operation: string;
    readonly resource: string;
}): Promise<AuthenticatedDeviceProof | undefined>;
// ==== @byok-sdk/cloud dist/handlers/shared.d.ts ====
/**
 * The two things every device-facing handler starts from: a JSON body read
 * under that route's own byte ceiling, and admission — the bearer -> principal
 * -> tenant-closed-facade step plus one debit of the device's rate budget.
 *
 * Once {@link admitDeviceRequest} has answered, a handler holds a
 * `TenantStores` and a `DevicePrincipal` and never sees a `TenantId` again.
 */
import type { Context } from 'hono';
import type { DevicePrincipal } from '@byok-sdk/core';
import { type BearerAuthDeps } from '../auth/bearer';
import { type CloudRootStores, type TenantStores } from '../tenant-stores';
/** Every error response on this surface is `{ error }` — the same shape the reference server uses. */
export interface ErrorBody {
    readonly error: string;
}
export interface BoundedJsonBodyResult {
    readonly body: unknown;
    readonly tooLarge: boolean;
}
/**
 * Read and parse one JSON request while retaining a hard byte ceiling before
 * JSON.parse. The declared length is only an early rejection; the stream is
 * still counted because chunked requests may omit Content-Length or lie about
 * it. Invalid JSON remains represented by `body: undefined` for the caller's
 * existing validation status.
 */
export declare function readBoundedJsonBody(c: Context, maximum: number): Promise<BoundedJsonBodyResult>;
/**
 * Count actual request bytes before retaining each chunk. Keep the bytes intact
 * for consumers that authenticate a raw-body hash before decoding JSON.
 * Content-Length policy belongs to the caller; it never replaces this ceiling.
 */
export declare function readBoundedRawBody(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array | 'too_large' | undefined>;
/**
 * Cancellation is a resource-release best effort that is never awaited before
 * rejecting an already oversized request. `ReadableStream.cancel()` is used
 * before a reader exists; `ReadableStreamDefaultReader.cancel()` owns the
 * same underlying request stream after an overflow has been observed.
 */
export declare function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void;
export interface DeviceRouteDeps {
    readonly bearer: BearerAuthDeps;
    readonly root: CloudRootStores;
}
export interface AuthenticatedDeviceContext {
    readonly device: DevicePrincipal;
    readonly stores: TenantStores;
}
/**
 * Admission for every device-class route except `POST /byok/messages`:
 * authenticate the bearer, then spend one `request` unit of the device's rate
 * budget. Answers the refusal itself — 401 for any credential failure (see
 * {@link authenticateDevice}), 429 with `Retry-After` when the budget is spent.
 */
export declare function admitDeviceRequest(c: Context, deps: DeviceRouteDeps): Promise<AuthenticatedDeviceContext | Response>;
/** A spent rate budget: 429 with `Retry-After` rounded up to whole seconds (at least 1). */
export declare function rateLimited(c: Context, retryAfterMs: number): Response;
/**
 * Authentication alone, with no rate debit. Only two callers may skip the
 * debit: `POST /byok/messages`, whose envelopes each spend an `envelope` unit
 * at the inbound gate, and re-checks inside a request that was already
 * admitted (the board stream's pump). Every other device route admits through
 * {@link admitDeviceRequest}.
 *
 * `undefined` means "answer 401" — and it means that for a missing header, a
 * forged token, an expired token, a revoked device, a product mismatch, and a
 * token whose tenant does not own the device, indistinguishably.
 */
export declare function authenticateDevice(c: Context, deps: DeviceRouteDeps): Promise<AuthenticatedDeviceContext | undefined>;
// ==== @byok-sdk/cloud dist/handlers/skill-packs.d.ts ====
/**
 * `GET /byok/skill-packs` and `GET /byok/skill-packs/:name/files/:path` — the
 * hosted half of the skill-pack delivery channel.
 *
 * Two device-class reads, and nothing else. There is no publish route here on
 * purpose: a device is a CONSUMER of packs, and a device-bearer-authed write
 * would let any paired device in a tenant publish content to every other device
 * in it. Publication is a host control-plane action against the store directly,
 * exactly as board item creation is.
 *
 * Both routes answer 404 for a pack this tenant does not have — the same answer
 * a name that never existed anywhere gets — so the surface is not a
 * cross-tenant existence oracle. The store is tenant-first, so that property
 * comes from the lookup key rather than from a comparison a handler could
 * forget.
 *
 * Bytes travel as UTF-8 text inside JSON. A pack carries Markdown, YAML and
 * static text; there is no archive to unpack and no binary channel to
 * negotiate, which is the same reason the manifest has no exec surface — the
 * format cannot express the thing we do not want it to express.
 */
import { type SkillPackStore } from '@byok-sdk/core';
import type { Context } from 'hono';
import { type DeviceRouteDeps } from './shared';
/** Rows per `GET /byok/skill-packs` response. A tenant's pack catalogue is small by design. */
export declare const DEFAULT_SKILL_PACK_PAGE_LIMIT = 50;
export interface SkillPackRouteDeps extends DeviceRouteDeps {
    readonly skillPacks: SkillPackStore;
    readonly pageLimit: number;
}
export declare function skillPackListHandler(deps: SkillPackRouteDeps): (c: Context) => Promise<Response>;
export declare function skillPackFileHandler(deps: SkillPackRouteDeps): (c: Context) => Promise<Response>;
// ==== @byok-sdk/cloud dist/handlers/truth.d.ts ====
import { DEVICE_PROOF_HEADER } from '@byok-sdk/core';
import type { Context } from 'hono';
import type { DeviceProofAuthDeps } from '../auth/device-proof';
import { type TruthCommitter, type TruthObjectDownloads } from '../truth/contract';
export { DEVICE_PROOF_HEADER };
export { MAX_DEVICE_PROOF_HEADER_BYTES } from './device-proof-request';
export declare const DEFAULT_MAX_TRUTH_REQUEST_BYTES: number;
export interface TruthRouteDeps {
    readonly proof: DeviceProofAuthDeps;
    readonly truth: TruthCommitter;
    readonly objectDownloads: TruthObjectDownloads;
    readonly maxRequestBytes: number;
}
export declare function truthManifestHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
export declare function truthGetHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
export declare function truthPutHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
// ==== @byok-sdk/cloud dist/inbound.d.ts ====
/**
 * The single inbound choke point for every daemon -> cloud envelope.
 *
 * The reference server runs this gate inside a live `ConnectionHub`; here it
 * is a pure function over a tenant-closed facade, so the same order holds with
 * no connection, no session, and no cross-request state:
 *
 * Rate admission is not a gate step. `POST /byok/messages` charges its whole
 * batch, one token per envelope, before the first envelope reaches this gate
 * (`handlers/messages.ts`), so a refused batch applies nothing and a flood of
 * garbage-typed envelopes costs the same budget as well-formed ones.
 *
 * 1. **type-allow** — only `DAEMON_TO_SERVER_TYPES` may pass, plus the
 *    authenticated long-poll `conn.hello` capability snapshot handled below.
 *    A server -> daemon type arriving inbound, or anything unrecognized, is
 *    rejected before it is dispatched or counted accepted.
 * 2. **ownership** — an envelope must name an existing task targeted at this
 *    exact device, and a task already owned by a DIFFERENT device is dropped,
 *    never force-failed: force-failing on an authz mismatch
 *    would let an attacker who merely guesses a `taskId` kill the real owner's
 *    task. Unknown task ids are rejected before any task-scoped projection or
 *    dedup fact can be written.
 * 3. **apply/recover** — every lifecycle side effect is idempotent under the
 *    envelope's own durable identity. A retry after a partial failure resumes
 *    this step rather than being hidden by transport admission.
 * 4. **dedup** — only after every authoritative side effect converged do we
 *    mark the envelope complete. The next retry is then a no-op.
 *
 * A duplicate is still a wire-level success (§8.2): it just did not re-run
 * anything. Only `rejected` is excluded from `accepted`.
 *
 * 5. **observe** — an optional {@link ByokCloudObserver} is told, once, about
 *    each envelope whose write committed (`onInboundCommitted`) and about each
 *    envelope the gate refused, with a closed {@link InboundRefusalReason}
 *    (`onInboundRefused`). It runs after the outcome is fixed, it cannot
 *    change it, and it is not the admission hook.
 */
import { type AgentMessageDispositionPayload, type AgentMessagePublishPayload, type AgentMessageServerContext, type Envelope, type MessageType } from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import { type ActivityBounds } from './coordination';
import type { TenantStores } from './tenant-stores';
export type InboundOutcome = 'accepted' | 'duplicate' | 'rejected';
/**
 * Why the gate answered `rejected`. Closed on purpose: every rejection path in
 * this file goes through {@link refuse}, whose parameter is this union, and the
 * gate's internal result type has no `rejected` member without a reason — so a
 * new rejection path that does not name one fails typecheck rather than
 * disappearing into an uncounted `rejected`.
 *
 * Internal observation vocabulary. `POST /byok/messages` maps these names
 * exhaustively to coarse wire codes; the internal names never reach the wire
 * and may be refined without a protocol revision.
 */
export declare const INBOUND_REFUSAL_REASONS: readonly ['protocol_version_unsupported', 'type_not_allowed', 'sealed_payload_unsupported', 'sealed_output_required', 'sealed_ciphertext_invalid', 'task_id_missing', 'device_not_eligible', 'hello_device_mismatch', 'hello_harnesses_without_capability', 'hello_protocol_version_unsupported', 'hello_product_mismatch', 'hello_capabilities_not_recorded', 'agent_message_draft_invalid', 'agent_message_attempt_mismatch', 'agent_message_offer_binding_missing', 'agent_message_binding_corrupt', 'agent_message_binding_mismatch', 'agent_message_too_large', 'agent_message_already_deduplicated', 'agent_message_reservation_conflict', 'agent_message_admission_unconfirmed', 'egress_conflict', 'content_receipt_event_request_mismatch', 'content_receipt_request_unknown', 'content_receipt_request_mismatch', 'content_receipt_conflict', 'task_not_found_for_device', 'task_owned_by_other_device', 'agent_identity_mismatch', 'terminal_harness_mismatch', 'claim_device_mismatch', 'claim_harness_and_runtime_conflict', 'claim_harness_mismatch', 'claim_harness_unavailable', 'claim_offer_mismatch', 'claim_not_won', 'task_settled_by_cloud', 'recovery_report_invalid', 'recovery_offer_mismatch', 'activity_batch_too_large', 'activity_batch_invalid', 'approval_event_invalid'];
export type InboundRefusalReason = (typeof INBOUND_REFUSAL_REASONS)[number];
/** The only way to build a rejection: the reason is required and closed. */
interface Refused {
    readonly outcome: 'rejected';
    readonly reason: InboundRefusalReason;
}
/** The gate's internal result. `rejected` cannot be expressed without a reason. */
export type InboundResult = Refused | {
    readonly outcome: 'accepted' | 'duplicate';
};
/**
 * One envelope whose write COMMITTED, handed to {@link ByokCloudObserver}.
 *
 * `outcome` is constant by construction — `accepted` is the only outcome that
 * committed anything — and is carried anyway because it names the fact in the
 * gate's own vocabulary rather than leaving the reader to infer it from the
 * hook's name. A `duplicate` re-ran nothing and a `rejected` wrote nothing;
 * neither appears here.
 */
export interface InboundCommitted {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly envelope: Envelope;
    readonly outcome: Extract<InboundOutcome, 'accepted'>;
}
/**
 * Post-commit relay for the host (the `TaskHandle` fan-out `@byok-sdk/server`
 * drives off its live hub).
 *
 * Deliberately NOT the admission hook. `ByokCloudOptions.agentMessage.consume`
 * runs BEFORE a write and decides whether it happens; this runs AFTER one and
 * cannot decide anything: it returns `void`, it is called inside a `try`, and
 * a throw from it is swallowed with the outcome already fixed. An observer
 * that wants to refuse work has the admission hook; an observer here is
 * watching, not gating.
 *
 * Synchronous and cheap by contract — it runs inline on the request path.
 */
export interface ByokCloudObserver {
    /** Post-commit wake hint, including exact replays; durable receipts remain authoritative. */
    onAgentHomeProjectionCompleted?(readback: import('@byok-sdk/protocol').AgentHomeProjectionReadback): void;
    onMaintenance?(report: import('./maintenance').MaintenanceReport): void;
    onInboundCommitted(input: InboundCommitted): void;
    /**
     * One envelope the gate refused, with the reason. Same rules as
     * {@link onInboundCommitted}: synchronous, called inside a `try`, a throw is
     * swallowed, and it can never change the response (`rejected` is already
     * counted on the wire). `envelopeId` and `type` come from the device's own
     * envelope, so they are claims, not authority.
     */
    onInboundRefused?(input: InboundRefused): void;
}
/** One refused envelope, handed to {@link ByokCloudObserver.onInboundRefused}. */
export interface InboundRefused {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly envelopeId: string;
    readonly type: MessageType;
    readonly reason: InboundRefusalReason;
}
export declare function handleAgentMessagePublish(stores: TenantStores, deviceId: string, taskId: string, payload: AgentMessagePublishPayload, consume: ((input: {
    readonly tenant: TenantStores['tenant'];
    readonly deviceId: string;
    readonly taskId: string;
    readonly context: AgentMessageServerContext;
    readonly payload: AgentMessagePublishPayload;
}) => Promise<{
    readonly outcome: 'accepted' | 'held' | 'refused';
    readonly reasonCode?: string;
}>) | undefined, alreadyDeduplicated: boolean): Promise<Refused | {
    readonly outcome: Exclude<InboundOutcome, 'rejected'>;
    readonly disposition?: AgentMessageDispositionPayload;
}>;
/** Reads only a terminal immutable admission; pending rows have no disposition to acknowledge. */
export declare function readAgentMessageDisposition(stores: TenantStores, deviceId: string, taskId: string, payload: AgentMessagePublishPayload): Promise<AgentMessageDispositionPayload | undefined>;
/** Receipt key a task's terminal is recorded under — the idempotency seam S3b's journal will share. */
export declare function terminalReceiptKey(taskId: string): string;
export declare function handleInboundEnvelope(stores: TenantStores, deviceId: string, envelope: Envelope, activityBounds?: ActivityBounds, agentMessageConsume?: Parameters<typeof handleAgentMessagePublish>[4], observer?: ByokCloudObserver, now?: string): Promise<InboundResult>;
export {};
// ==== @byok-sdk/cloud dist/index.d.ts ====
/**
 * `@byok-sdk/cloud` — the hosted device surface.
 *
 * Cloud sits BESIDE `@byok-sdk/server`, not above it (§12.1): `cloud → core +
 * protocol`, and never `cloud → server`. The self-hosted embedded coordinator
 * stays the self-hosted option; this package serves the same frozen v1 device
 * wire contract statelessly, over `@byok-sdk/core` ports plus the cloud-local auth
 * and task ports in `stores/ports.ts`.
 *
 * `src/__tests__/constraints.test.ts` asserts the properties this export list
 * implies: no `@byok-sdk/server` import, no `node:` import, no module-level
 * mutable state, no session/Running map, and no route mounted outside the I1
 * registry.
 */
export { isTenantId, tenantId } from '@byok-sdk/core';
export type { TenantId } from '@byok-sdk/core';
export { createByokCloud } from './cloud';
export type { TaskAgentMessage } from './task-agent-message';
export type { ByokCloud, ByokCloudOptions, LimitedPublicRoute, PublicRouteLimiter, AgentDispatchInput, AgentEgressDispatchInput, AgentContentReadInput, AgentHomeProjectionInput, ProviderProvisioningNoticeInput, AgentMemoryIntentNoticeInput, AgentHomeProjectionStatusInput, InputPreparationInput, InputPreparationStatusInput, ApproveTaskOptions, SealedAgentDispatchInput, SealedAgentEgressDispatchInput, RejectTaskOptions, EnqueuedAgentControl, EnqueuedAgentHomeProjection, EnqueuedInputPreparation, EnqueuedOffer, TaskOfferReadback, } from './cloud';
export { agentHomeProjectionCompletionKey, agentHomeProjectionRequestKey, readAgentHomeProjectionStatus, recordAgentHomeProjectionCompletion, } from './agent-home-projections';
export type { AgentHomeProjectionReceiptInput } from './agent-home-projections';
export { inputPreparationCompletionKey, inputPreparationRequestKey, readInputPreparationStatus, recordInputPreparationCompletion, sameInputPreparationRequest, } from './input-preparations';
export type { InputPreparationReceiptInput } from './input-preparations';
export { AGENT_HOME_CONTRACT_CAPABILITY, DEFAULT_EVENTS_PAGE_LIMIT, DEFAULT_LONG_POLL_HOLD_MS, DEFAULT_MAX_BLOB_SIZE_BYTES, } from './cloud';
export { DEFAULT_BOARD_PAGE_LIMIT, DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS, DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS, DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS, } from './handlers/board';
export { DEFAULT_SKILL_PACK_PAGE_LIMIT } from './handlers/skill-packs';
export { createInMemoryByokCloud } from './composition/in-memory';
export type { InMemoryByokCloud, InMemoryByokCloudOptions } from './composition/in-memory';
export { ByokCloudError, CLOUD_ERROR_CODES, TaskOfferAppendRefusedError, isCloudError } from './errors';
export type { CloudErrorCode } from './errors';
export { InMemoryAgentMemoryProjectionAuthorizer, InMemoryAgentMemoryProjectionStore, } from './stores/in-memory/agent-memory-projection';
export type { AgentMemoryProjectionAuthorization, AgentMemoryProjectionEraseResult, AgentMemoryProjectionAuthorizer, AgentMemoryProjectionAuthorizerInput, AgentMemoryProjectionCommitInput, AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionStore, } from './agent-memory-projection';
export { TASK_REDACTION_MAX_TASKS } from './task-redaction';
export type { TaskRedactionCodec, TaskRedactionCounts, TaskRedactionRefusal, TaskRedactionResult, TaskRedactionStore, TaskRedactionStoreInput, TaskRedactionTaskResult, } from './task-redaction';
export { parseRecordedWriteResult } from './e2ee-member';
export type { E2eeMemberChainAppendInput, E2eeMemberChainAppendResult, E2eeMemberChainRow, E2eeMemberRegisterResult, E2eeMemberRegistrationInput, E2eeMemberRegistrationRow, E2eeMemberStore, E2eeProofRequest, E2eeProvenWrite, E2eeScopeKeyPackagePutInput, E2eeScopeKeyPackagePutResult, E2eeScopeKeyPackageRow, E2eeScopeShred, } from './e2ee-member';
export { CLOUD_CAPABILITIES, CapabilitiesResponseSchema, capabilityDeclarationForPorts, declares, fullCapabilityDeclaration, } from './capabilities';
export type { CapabilitiesResponse, CapabilityPorts, CloudCapability, FullCapabilityDeclarationOptions, } from './capabilities';
export { CloudRouteRegistry, ROUTE_CLASSES, ROUTE_METHODS, routeKey } from './router/registry';
export type { CloudRouteHandler, RouteClass, RouteDescriptor, RouteMethod } from './router/registry';
export { ACCESS_TOKEN_TTL_SECONDS, createHmacTokenSigner } from './auth/tokens';
export type { AccessTokenClaims, TokenSigner } from './auth/tokens';
export { NONCE_SIGNING_DOMAIN, verifyNonceSignature } from './auth/verify';
export { authenticateBearer, extractBearerToken } from './auth/bearer';
export type { BearerAuthDeps } from './auth/bearer';
export { DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS, DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS, MAX_DEVICE_PROOF_CLOCK_SKEW_MS, MAX_DEVICE_PROOF_MAX_LIFETIME_MS, authenticateDeviceProof, } from './auth/device-proof';
export type { AuthenticatedDeviceProof, DeviceProofAuthDeps, DeviceProofRequestBinding, } from './auth/device-proof';
export { authenticateHostedDeviceAssertion, authenticateHostedTaskAssertion } from './auth/device-assertion';
export type { HostedDeviceAssertionAuthDeps, HostedTaskAssertionAuthDeps } from './auth/device-assertion';
export { DEVICE_IDENTITY_PROOF_KEY_EPOCH, DEVICE_IDENTITY_PROOF_KEY_ID, PAIRING_CODE_TTL_MS, createAuthPlane, } from './auth/plane';
export type { AuthPlane, AuthPlaneDeps, MintedAccessToken, PairInput } from './auth/plane';
export { createWebCrypto } from './crypto/web-crypto';
export type { CloudCrypto } from './crypto/port';
export { INBOUND_REFUSAL_REASONS, handleInboundEnvelope, terminalReceiptKey } from './inbound';
export type { ByokCloudObserver, InboundCommitted, InboundOutcome, InboundRefusalReason, InboundResult, InboundRefused, } from './inbound';
export { projectTerminalResult } from './terminal-result';
export type { TerminalResult } from './terminal-result';
export { tenantStoresFor } from './tenant-stores';
export type { TenantBoundActivity, TenantBoundApprovalTimeline, TenantBoundBoard, CloudRootStores, TenantBoundBlobs, TenantBoundDedup, TenantBoundDevices, TenantBoundMailbox, TenantBoundObjects, TenantBoundPresence, TenantBoundQuota, TenantBoundRateLimiter, TenantBoundReceipts, TenantBoundTaskAttempts, TenantStores, } from './tenant-stores';
export { ApprovalObservationSchema, ApprovalTimelineEventSchema, APPROVAL_SUMMARY_MAX_BYTES, DEFAULT_APPROVAL_TIMELINE_CAPACITY, DEFAULT_APPROVAL_TIMELINE_TTL_MS, approvalTimelineCursor, parseApprovalObservations, sameApprovalTimelineEvent, validateApprovalTimelineAppend, validateApprovalTimelineResolve, } from './approval-timeline';
export type { ApprovalObservation, ApprovalTimelineAppendInput, ApprovalTimelineEvent, ApprovalTimelineResolvePendingInput, ApprovalTimelineResolvePendingResult, ApprovalTimelineStore, ApprovalTimelineTail, } from './approval-timeline';
export { StaleApprovalError, pendingApproval } from './approval-control';
export type { PendingApproval } from './approval-control';
export { SteerRejectedError } from './steer-control';
export type { SteerRejectionCode } from './steer-control';
export { assertTaskAttemptListLimit, DEFAULT_ACTIVITY_BOUNDS, DEFAULT_ACTIVITY_CAPACITY, DEFAULT_ACTIVITY_TTL_MS, DEFAULT_BOARD_CHANNEL_MAX_BYTES, DEFAULT_BOARD_TITLE_MAX_BYTES, DEFAULT_PRESENCE_DETAIL_MAX_BYTES, DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS, DEFAULT_PRESENCE_TTL_MS, } from './coordination';
export type { ActivityBounds } from './coordination';
export { TimelineEventSchema, SealedActivityBatchSchema, ActivityAppendRequestSchema, activityCursor, activitySourceBatchState, parseTimelineEvents, projectTimelineEvents, validateActivityAppend, } from './activity';
export type { ActivityAppendInput, ActivityCursor, ActivityStore, ActivityTail, ActivityTailEntry, SealedActivityBatch, TimelineEvent, } from './activity';
export { BoardFeedClient, BoardFeedRetryableError, BoardFeedStoppedError } from './coordination-client';
export type { BoardFeedClientOptions, BoardFeedItem, BoardFeedMode, BoardFeedPage, BoardFeedRead, } from './coordination-client';
export { TRUTH_BATCH_MAX_RECORDS, TRUTH_INLINE_CONTENT_TYPE, TRUTH_LABEL_MAX_LENGTH, TRUTH_MANIFEST_MAX_LIMIT, TRUTH_RECORD_CAPABILITY, TRUTH_RECORD_KEY_MAX_LENGTH, TRUTH_REQUEST_ID_MAX_LENGTH, TruthBodyInputSchema, TruthCommitResponseSchema, TruthRecordKeySchema, TruthRecordMetadataSchema, TruthWriteRequestSchema, truthManifestMetadata, truthRecordMetadata, } from './truth/contract';
export { DEFAULT_MAX_TRUTH_REQUEST_BYTES, DEVICE_PROOF_HEADER, MAX_DEVICE_PROOF_HEADER_BYTES, } from './handlers/truth';
export type { PreparedTruthWrite, TruthBodyInput, TruthCommitInput, TruthCommitResponse, TruthCommitResult, TruthCommitter, TruthObjectDownloads, TruthRecordMetadata, TruthWriteRequest, } from './truth/contract';
export { TruthCommitError, isTruthCommitError } from './truth/errors';
export type { TruthCommitErrorCode } from './truth/errors';
export { BLOB_READ_ERROR_CODES, CLOUD_STORE_NAMES, TASK_ABANDON_CAUSES, TASK_ATTEMPT_STATUSES, TASK_ATTEMPT_ACTIVE_STATUSES, TASK_ATTEMPT_UNFINISHED_STATUSES, } from './stores/ports';
export { CLOUD_PORT_INTERFACES, CLOUD_PORT_METHODS } from './stores/ports-contract';
export type { BlobContent, BlobContentProxy, BlobDeclaration, BlobObservation, BlobReadErrorCode, BlobReadResult, BlobWriteResult, CloudBlobStore, CloudStoreName, CloudStores, DeviceDirectory, DeviceRecord, DeviceRegistration, InboundDedupStore, InboundRateLimiter, NonceStore, PairingCodeClaims, PairingCodeInfo, PairingCodeIssueInput, PairingCodeStore, PairingEnrollment, PairingEnrollmentInput, ProofRequestReceipt, ProofRequestReceiptInput, ProofRequestReceiptStore, RateLimitDecision, RateLimitUnit, RequestReceipt, RequestReceiptStore, TaskAttempt, TaskAttemptListQuery, TaskAttemptCounts, TaskAttemptPage, TaskAttemptStatus, TaskAttemptStore, AgentRef, AgentEgressRecord, AgentEgressStore, AgentMessageAdmission, TaskAbandonCause, TaskAbandonRequest, TaskCancellationMutation, TaskCancellationRequest, TaskCancellationStore, } from './stores/ports';
export { AllowAllRateLimiter, BLOB_URL_TTL_MS, DEDUP_RING_CAPACITY, InMemoryBlobContentProxy, InMemoryCloudBlobStore, InMemoryActivityStore, InMemoryAgentMessageDraftStore, InMemoryE2eeMemberStore, InMemoryDeviceDirectory, InMemoryInboundDedupStore, InMemoryNonceStore, InMemoryPairingCodeStore, InMemoryRequestReceiptStore, InMemoryAgentEgressStore, InMemoryProofRequestReceiptStore, InMemoryTaskAttemptStore, InMemoryTaskCancellationStore, NONCE_TTL_MS, createInMemoryBlobs, createInMemoryCloudStores, createInMemoryBlobBytes, InMemoryBlobBytes, } from './stores/in-memory/index';
export type { InMemoryBlobStoreOptions, InMemoryBlobs, InMemoryCloudComposition, } from './stores/in-memory/index';
export type { DeviceTerminal } from './terminal-result';
export { AgentExecutionInputSchema, SealedAgentExecutionInputSchema, type AgentExecutionInput, type SealedAgentExecutionInput, } from './agent-execution';
export { DEFAULT_RETENTION_POLICY, DEFAULT_MAINTENANCE_LIMIT, MAINTENANCE_STEPS, resolveRetentionPolicy, DEFAULT_PROOF_RECEIPT_RETENTION_MS, PROOF_RECEIPT_RETENTION_FLOOR_MS, } from './maintenance';
export type { RetentionPolicy, MaintenanceInput, MaintenanceReport, MaintenanceStep, MaintenanceStepReport, ProofReceiptCollectExpiredInput, ProofReceiptRetentionAuthority, ProofReceiptRetentionOptions, } from './maintenance';
export { RECEIPT_RETENTION, REQUEST_RECEIPT_PREFIXES, receiptRetentionClass } from './receipt-retention';
export type { ReceiptRetentionClass } from './receipt-retention';
export type { ReceiptCollectExpiredInput } from './stores/ports';
export type { MailboxWake, MailboxWakeSubscription } from './mailbox-wake';
export { createInProcessMailboxWake, DEFAULT_MAILBOX_WAKE_FALLBACK_MS } from './stores/in-memory/mailbox-wake';
export type { InProcessMailboxWakeOptions } from './stores/in-memory/mailbox-wake';
export type { AgentMessageDraftStore, AgentMessageDraftRow, AgentMessageDraftCursor, AgentMessageDraftApplyInput, AgentMessageDraftApplyResult, AgentMessageDraftReadback } from './agent-message-draft';
// ==== @byok-sdk/cloud dist/input-preparations.d.ts ====
/**
 * Durable remote input-preparation facts.
 *
 * Exactly the composition `agent-home-projections.ts` uses, for exactly the
 * same reason: the desired request and the terminal completion are two
 * IMMUTABLE first-write-wins receipts in the tenant-scoped receipt store, so
 * this module needs no second mutable authority merely to survive a restart,
 * and a replayed write is decided by comparing bodies rather than by trusting
 * whichever writer arrived last.
 *
 * The one idempotency key is `(deviceId, agentRef, requestId)`, minted by the
 * Host and carried unchanged through the cloud receipt, the device's durable
 * namespace and the completion. A Host that times out therefore RE-READS
 * status; it never mints a second requestId for the same turn, which is what
 * keeps a duplicate from becoming a second counter call downstream.
 */
import { type AgentInputPreparationPayload, type InputPreparationCompletionRequest, type InputPreparationReadback } from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import type { TenantBoundReceipts } from './tenant-stores';
/** Exact request identity a host must echo to read back durable preparation status. */
export interface InputPreparationReceiptInput {
    readonly requestId: string;
    readonly agentRef: AgentInputPreparationPayload['agentRef'];
}
export declare function inputPreparationRequestKey(deviceId: string, agentRef: AgentInputPreparationPayload['agentRef'], requestId: string): string;
export declare function inputPreparationCompletionKey(deviceId: string, agentRef: AgentInputPreparationPayload['agentRef'], requestId: string): string;
/**
 * Whole-body equality, not a field subset.
 *
 * The desired fact is the ENTIRE authorized request — source digest, model
 * selection, deadline, context and required toolsets alike. Comparing only the
 * identity fields would let the same requestId silently re-bind to a different
 * model, a different context or a looser deadline, which is precisely the
 * substitution the immutable receipt exists to prevent. Both sides are already
 * schema-parsed, so key order is the only degree of freedom left, and the
 * stored body is re-serialized from a parse for that reason.
 */
export declare function sameInputPreparationRequest(expected: AgentInputPreparationPayload, actual: AgentInputPreparationPayload): boolean;
export declare function receiptMatchesInputPreparation(request: AgentInputPreparationPayload, receipt: InputPreparationCompletionRequest): boolean;
export declare function statusInputMatchesInputPreparation(request: AgentInputPreparationPayload, input: InputPreparationReceiptInput): boolean;
export declare function readInputPreparationStatus(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, input: InputPreparationReceiptInput): Promise<InputPreparationReadback | undefined>;
export declare function recordInputPreparationCompletion(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, receiptInput: InputPreparationCompletionRequest): Promise<InputPreparationReadback>;
// ==== @byok-sdk/cloud dist/mailbox-wake.d.ts ====
import type { TenantId } from '@byok-sdk/core';
/** A lossy hint over the durable mailbox, never a delivery or cursor authority. */
export interface MailboxWake {
    /** Called after a mailbox commit. Synchronous and non-throwing. */
    appended(tenant: TenantId, deviceId: string): void;
    /** Subscribe before reading so an append between the read and next() is retained. */
    subscribe(tenant: TenantId, deviceId: string, signal: AbortSignal): MailboxWakeSubscription;
}
export interface MailboxWakeSubscription {
    /** Resolves on a hint, the fallback interval, maxWaitMs, abort, or close. */
    next(maxWaitMs: number): Promise<void>;
    close(): void;
}
// ==== @byok-sdk/cloud dist/maintenance.d.ts ====
import { type CollectExpiredCounts, type CollectExpiredInput, type CollectExpiredResult, type CoreStores, type DeviceAssertionReplayAuthority, type Clock, type TenantId } from '@byok-sdk/core';
import type { CloudStores } from './stores/ports';
export interface RetentionPolicy {
    readonly mailboxAckedRetentionMs: bigint;
    readonly mailboxUnackedRetentionMs: bigint;
    readonly requestReceiptRetentionMs: bigint;
    readonly objectOrphanGraceMs: bigint;
}
export declare const DEFAULT_RETENTION_POLICY: RetentionPolicy;
export declare const DEFAULT_MAINTENANCE_LIMIT = 500;
export declare const MAINTENANCE_STEPS: readonly ["mailbox", "receipts", "nonces", "pairingCodes", "presence", "activity", "approvals", "agentMessageDraft", "deviceAssertionReplay", "quota", "objects", "proofReceipts"];
/** Receipts of used device-proof request ids recorded before `recordedBefore` are removed. */
export interface ProofReceiptCollectExpiredInput extends CollectExpiredInput {
    readonly recordedBefore: string;
}
/** The one owner of a deployment's used device-proof request ids (`proof_request_receipt`). */
export interface ProofReceiptRetentionAuthority {
    collectExpired(tenant: TenantId, input: ProofReceiptCollectExpiredInput): Promise<CollectExpiredResult>;
}
export interface ProofReceiptRetentionOptions {
    readonly authority: ProofReceiptRetentionAuthority;
    /** How long a used `requestId` stays single-use. Default 24 hours; at least {@link PROOF_RECEIPT_RETENTION_FLOOR_MS}. */
    readonly proofReceiptRetentionMs?: bigint;
}
/**
 * A receipt recorded at R binds a proof issued no later than R + skew, which
 * authenticates no later than R + 2 x skew at the largest allowed skew. Five
 * more minutes cover clock differences between Host nodes. After that, a
 * replay of the same proof gets 401 before any receipt is read.
 */
export declare const PROOF_RECEIPT_RETENTION_FLOOR_MS: bigint;
export declare const DEFAULT_PROOF_RECEIPT_RETENTION_MS = 86400000n;
export interface ResolvedProofReceiptRetention {
    readonly authority: ProofReceiptRetentionAuthority;
    readonly proofReceiptRetentionMs: bigint;
}
export declare function resolveProofReceiptRetention(input: ProofReceiptRetentionOptions): ResolvedProofReceiptRetention;
export type MaintenanceStep = typeof MAINTENANCE_STEPS[number];
export type MaintenanceStepReport = ({
    readonly step: MaintenanceStep;
    readonly status: 'ok';
} & CollectExpiredResult) | {
    readonly step: MaintenanceStep;
    readonly status: 'failed';
    readonly errorCode: string;
    readonly failedRows: number;
    /** Confirmed commits only; absent when the port could not report them. */
    readonly committed?: CollectExpiredCounts;
    /** Absent when a failed remainder probe left this unknown. */
    readonly more?: boolean;
} | {
    readonly step: 'deviceAssertionReplay' | 'proofReceipts';
    readonly status: 'not-configured';
} | {
    readonly step: 'agentMessageDraft';
    readonly status: 'ok';
};
export interface MaintenanceReport {
    readonly tenantId: TenantId;
    /** Caller-owned cutoff clock; never replaced by the report's execution clock. */
    readonly now: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly steps: readonly MaintenanceStepReport[];
}
export interface MaintenanceInput {
    readonly tenant: TenantId;
    readonly now: string;
    readonly policy: RetentionPolicy;
    readonly limit?: number;
}
export declare function resolveRetentionPolicy(input?: Partial<RetentionPolicy>): RetentionPolicy;
export declare function runMaintenanceSteps(ports: {
    readonly core: CoreStores;
    readonly cloud: CloudStores;
    readonly clock: Clock;
    readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority;
    readonly proofReceiptRetention?: ResolvedProofReceiptRetention;
}, input: MaintenanceInput): Promise<MaintenanceReport>;
// ==== @byok-sdk/cloud dist/receipt-retention.d.ts ====
export type ReceiptRetentionClass = 'identity' | 'request';
/** The sole receipt classification authority. Existing and unknown identities never expire. */
export declare const RECEIPT_RETENTION: readonly Readonly<{
    prefix: string;
    class: ReceiptRetentionClass;
}>[];
export declare const REQUEST_RECEIPT_PREFIXES: readonly string[];
export declare function receiptRetentionClass(key: string): ReceiptRetentionClass;
// ==== @byok-sdk/cloud dist/router/registry.d.ts ====
/**
 * The route inventory (sprint I1).
 *
 * Isolation review starts by asking "what routes exist, and what does each one
 * require?" — a question that is only answerable if the answer cannot drift
 * from what is actually mounted. So mounting goes through {@link
 * CloudRouteRegistry.register} and nowhere else: the registry owns the Hono
 * app, hands out no reference to it that could be mounted on directly, and
 * records a class for every route as it goes.
 *
 * `src/__tests__/route-inventory.test.ts` closes that loop in BOTH directions
 * against Hono's own `app.routes` table: a mounted route missing from the
 * inventory fails the suite, and an inventoried route that never reached the
 * router fails it too. A route whose class is not one of {@link ROUTE_CLASSES}
 * cannot be registered at all.
 */
import { type Context } from 'hono';
/**
 * What a route requires of its caller. Not a description of the handler's
 * work — a description of the credential it is authenticated by, which is the
 * thing an isolation review has to enumerate:
 *
 * - `device` — a bearer access token; resolves to a `DevicePrincipal` and a
 *   tenant-closed facade.
 * - `proof` — a request-bound Ed25519 device proof; tenant/product/key
 *   authority comes from the current device row, not protected claims.
 * - `presigned` — no principal at all; an HMAC signature over the resource id
 *   plus an expiry IS the credential (§7's two `/content` routes).
 * - `public` — deliberately unauthenticated; must expose nothing tenant-scoped.
 */
export declare const ROUTE_CLASSES: readonly ['device', 'proof', 'presigned', 'public'];
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export declare const ROUTE_METHODS: readonly ['GET', 'POST', 'PUT'];
export type RouteMethod = (typeof ROUTE_METHODS)[number];
export interface RouteDescriptor {
    readonly method: RouteMethod;
    readonly path: string;
    readonly class: RouteClass;
}
export type CloudRouteHandler = (c: Context) => Response | Promise<Response>;
export declare function routeKey(route: {
    readonly method: string;
    readonly path: string;
}): string;
export declare class CloudRouteRegistry {
    #private;
    register(descriptor: RouteDescriptor, handler: CloudRouteHandler): void;
    /** The inventory, in registration order. */
    get routes(): readonly RouteDescriptor[];
    /** What the router actually mounted, read back off Hono itself — the other half of the I1 comparison. */
    get mounted(): readonly {
        readonly method: string;
        readonly path: string;
    }[];
    get fetch(): (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
}
// ==== @byok-sdk/cloud dist/steer-control.d.ts ====
/**
 * GAP-2: why a `cloud.steerTask` call was refused, and the one input that
 * decides it.
 *
 * The reference server (`ConnectionHub.steerTask`, `packages/server/src/hub.ts`)
 * reaches this decision from `TaskSnapshot.claimedRuntimeCapabilities` — the
 * capability block the CLAIMING adapter reported for itself on its own
 * `task.claim`, frozen at the `Offered -> Claimed` transition. Cloud keeps the
 * same single source: {@link TaskAttempt.claimedRuntimeCapabilities}, written by
 * the claim that wins the ownership CAS (`stores/ports.ts`) and never again.
 *
 * The gap this closes is not cosmetic: only pi's adapter implements steering,
 * and Claude's and Codex's THROW on receiving `task.steer`, which stalls that
 * device's redelivery cursor at that seq forever. So the refusal has to happen
 * before an envelope exists, from a fact that shares a lifecycle with the
 * task-to-runtime binding.
 *
 * Fail-closed on unknown, deliberately: `steer_unsupported_runtime` covers both
 * "the claiming adapter reported `steer: false`" and "this attempt carries no
 * capability snapshot at all" (a daemon whose claim predates the field, an
 * attempt claimed before migration `0018`). Refusing an unknown is a
 * recoverable, operator-visible error; guessing "supported" reintroduces the
 * permanent cursor stall this gate exists to prevent. There is deliberately NO
 * runtime-id allow-list here either — a table mapping `pi -> steerable` would be
 * a second capability authority in the coordination plane, drifting the moment a
 * runtime gains or loses the feature, and the daemon already reports the truth.
 *
 * SINGLE SOURCE, deliberately: the gate reads the claim snapshot and NOTHING
 * from the connection layer. Cloud's connection-level equivalent is
 * `DeviceRecord.capabilities`, written from a bearer-authenticated `conn.hello`
 * (`inbound.ts`) — discovery data describing a device BUILD, not the adapter
 * that took this task. A device can reconnect later with a different adapter
 * set; a task already running must keep being judged against what was true when
 * it was claimed. Same pin the reference server holds in
 * `packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`.
 */
import type { RuntimeId } from '@byok-sdk/protocol';
import type { TaskAttemptStatus } from './stores/ports';
/**
 * Stable strings a caller switches on (an operator UI, an HTTP surface mapping
 * this to a status code) rather than matching error text. Byte-identical to the
 * reference server's `SteerRejectionCode` (`packages/server/src/hub.ts`), so a
 * host that moves from the embedded server to the hosted kernel keeps its own
 * mapping unchanged.
 *
 * - `task_terminal` — the attempt already reached `complete`/`failed`/
 *   `cancelled`. Checked FIRST, so a terminal attempt that is also (obviously)
 *   not running reports the more specific truth, and a steer racing a terminal
 *   transition always resolves terminal-first.
 * - `task_not_running` — the attempt exists and is live, but is `offered`/
 *   `claimed`/`cancel_requested`; there is no running turn to steer yet.
 * - `steer_unsupported_runtime` — the runtime that CLAIMED this attempt cannot
 *   be steered, per the claim-time capability snapshot. A MISSING snapshot
 *   rejects under this same code: unknown is not supported.
 */
export type SteerRejectionCode = 'steer_unsupported_runtime' | 'task_not_running' | 'task_terminal';
/**
 * Thrown by `ByokCloud.steerTask` instead of a generic `Error`, so a caller can
 * tell WHY a steer was refused without matching on message text — the same
 * typed-error idiom as `StaleApprovalError` (`approval-control.ts`).
 *
 * A distinct class rather than a `CloudErrorCode`, for the same reason as
 * `StaleApprovalError`: it carries the state and the runtime the caller needs to
 * explain the refusal, and a code alone cannot.
 *
 * Thrown before any mailbox row is allocated — a refused steer is a NON-EVENT,
 * exactly like a refused approval.
 */
export declare class SteerRejectedError extends Error {
    readonly taskId: string;
    readonly code: SteerRejectionCode;
    /** The attempt's status at the moment the steer was refused. */
    readonly status: TaskAttemptStatus;
    /** {@link TaskAttempt.claimedRuntime} — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    readonly runtime: RuntimeId | undefined;
    constructor(taskId: string, code: SteerRejectionCode, 
    /** The attempt's status at the moment the steer was refused. */
    status: TaskAttemptStatus, 
    /** {@link TaskAttempt.claimedRuntime} — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    runtime: RuntimeId | undefined);
}
// ==== @byok-sdk/cloud dist/stores/in-memory/activity.d.ts ====
import { type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import type { Clock, TenantId } from '@byok-sdk/core';
import { type ActivityAppendInput, type ActivityStore, type ActivityTail } from '../../activity';
export declare class InMemoryActivityStore implements ActivityStore {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
    read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/agent-egress.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { AgentEgressRecord, AgentEgressStore } from '../ports';
/** Reference egress fact store. Duplicate event ids return, never overwrite, the first receipt. */
export declare class InMemoryAgentEgressStore implements AgentEgressStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, agentRef: AgentEgressRecord['payload']['agentRef'], eventId: string): Promise<AgentEgressRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/agent-memory-projection.d.ts ====
/** In-memory conformance implementation for the one-way hosted memory projection ports. */
import type { Clock, TenantId } from '@byok-sdk/core';
import { type AgentMemoryProjectionEraseResult, type AgentMemoryProjectionReceipt } from '@byok-sdk/protocol';
import type { AgentMemoryProjectionAuthorization, AgentMemoryProjectionAuthorizer, AgentMemoryProjectionAuthorizerInput, AgentMemoryProjectionCommitInput, AgentMemoryProjectionStore } from '../../agent-memory-projection';
import type { CloudCrypto } from '../../crypto/port';
/**
 * Reference transaction semantics: current snapshot bytes and immutable
 * metering receipt advance in the same serialized mutation. Receipts retain
 * metadata only, never a body.
 */
export declare class InMemoryAgentMemoryProjectionStore implements AgentMemoryProjectionStore {
    #private;
    constructor(clock: Clock, crypto: CloudCrypto);
    commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
    erase(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<AgentMemoryProjectionEraseResult>;
}
/** Test/reference authorizer whose grant registry demonstrates revocation without model booleans. */
export declare class InMemoryAgentMemoryProjectionAuthorizer implements AgentMemoryProjectionAuthorizer {
    #private;
    grant(input: AgentMemoryProjectionAuthorizerInput): void;
    authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
    revoke(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<void>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/agent-message-draft.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { AgentMessageDraftStore, AgentMessageDraftRow, AgentMessageDraftApplyInput, AgentMessageDraftApplyResult } from '../../agent-message-draft';
export declare class InMemoryAgentMessageDraftStore implements AgentMessageDraftStore {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    apply(tenant: TenantId, input: AgentMessageDraftApplyInput): Promise<AgentMessageDraftApplyResult>;
    read(tenant: TenantId, taskId: string): Promise<AgentMessageDraftRow | undefined>;
    delete(tenant: TenantId, taskId: string): Promise<void>;
    sweepExpired(now: string): Promise<void>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/approval-timeline.d.ts ====
import { type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import type { Clock, TenantId } from '@byok-sdk/core';
import { type ApprovalTimelineAppendInput, type ApprovalTimelineResolvePendingInput, type ApprovalTimelineResolvePendingResult, type ApprovalTimelineStore, type ApprovalTimelineTail } from '../../approval-timeline';
export declare class InMemoryApprovalTimelineStore implements ApprovalTimelineStore {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    resolvePending(tenant: TenantId, input: ApprovalTimelineResolvePendingInput): Promise<ApprovalTimelineResolvePendingResult>;
    read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/blobs.d.ts ====
/**
 * The in-memory blob pair: metadata and bytes in process memory, HMAC-signed
 * expiring URLs (docs/protocol.md §7).
 *
 * TWO objects, one shared record map, because the contract they satisfy is two
 * things: {@link CloudBlobStore} is the tenant-first port every composition
 * owes, and {@link BlobContentProxy} is the optional byte-carrying half. The
 * in-memory composition is the one that supplies both — it has nowhere else to
 * put bytes — which is why hosted-in-memory behavior is byte-for-byte what it
 * was before the split.
 *
 * They cannot be one object: the port's method inventory is contract data
 * (`CLOUD_PORT_METHODS`) and `@byok-sdk/conformance` asserts a composition's blob
 * store implements EXACTLY the two declared methods. An object carrying all
 * six would fail that assertion, which is the point — the suite is what keeps
 * the narrowed port narrow.
 *
 * The presigned URL form — `/byok/blobs/<id>/content?sig=&exp=` — is the
 * relative shape the daemon's blob client already resolves against its server
 * base, so a hosted deployment is indistinguishable from a self-hosted one on
 * this route too.
 *
 * Tenancy: `createUpload` records the owning tenant and reservation while
 * `observeUpload`/`getDownloadUrl` refuse any other, so the three bearer routes are
 * tenant-closed. The two `/content` routes are presigned by construction and
 * have no principal at all — the signature over the blob id IS the credential
 * (same posture as the reference server, §7).
 */
import { type Clock, type ContentHash, type ObjectStore, type StorageReservation, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { BlobContentProxy, BlobObservation, BlobReadResult, BlobWriteResult, CloudBlobStore } from '../ports';
/** How long a presigned upload/download URL stays valid. */
export declare const BLOB_URL_TTL_MS: number;
interface BlobRecord {
    readonly tenantId: TenantId;
    readonly reservationId: string;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly contentType: string;
    uploaded: boolean;
    data?: Uint8Array;
}
export interface InMemoryBlobStoreOptions {
    readonly urlTtlMs?: number;
}
/**
 * The state both halves read, and the only thing they share.
 *
 * Module-private on purpose: it is not a port, and nothing outside this file
 * should be able to reach a blob record without going through one of the two
 * contracts above.
 */
declare class InMemoryBlobRegistry {
    readonly blobs: Map<string, BlobRecord>;
    readonly reservationBlobs: Map<string, string>;
    readonly clock: Clock;
    readonly crypto: CloudCrypto;
    readonly secret: Uint8Array;
    readonly urlTtlMs: number;
    constructor(clock: Clock, crypto: CloudCrypto, options: InMemoryBlobStoreOptions);
    signUrl(blobId: string, action: 'put' | 'get'): Promise<string>;
    computeSig(blobId: string, action: 'put' | 'get', exp: number): Promise<string>;
}
/** The narrowed port: tenant-first grants, no bytes. */
export declare class InMemoryCloudBlobStore implements CloudBlobStore {
    #private;
    constructor(registry: InMemoryBlobRegistry, objects: ObjectStore);
    createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{
        blobId: string;
        uploadUrl: string;
    }>;
    observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}
/** The optional half: the bytes this composition has nowhere else to put. */
export declare class InMemoryBlobContentProxy implements BlobContentProxy {
    #private;
    constructor(registry: InMemoryBlobRegistry);
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean>;
    expectedUploadBytes(blobId: string): Promise<bigint | undefined>;
    claimUpload(blobId: string): Promise<(() => void) | undefined>;
    writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult>;
    /**
     * Never returns `{ok:false}`: this composition holds the bytes in the same
     * process, so there is no upstream to be unreachable and no stream to be
     * interrupted. Both `BlobReadErrorCode`s are structurally unreachable here
     * — a proxy that fetches from object storage is where they become live.
     */
    readContent(blobId: string): Promise<BlobReadResult | undefined>;
}
/** Both halves over one registry. The only way to obtain either. */
export interface InMemoryBlobs {
    readonly blobs: CloudBlobStore;
    readonly contentProxy: BlobContentProxy;
}
/** Composition-owned bytes, constructed before the core metadata stores. */
export declare class InMemoryBlobBytes {
    #private;
    constructor(clock: Clock, crypto: CloudCrypto, options?: InMemoryBlobStoreOptions);
    deleteObject(tenant: TenantId, hash: ContentHash): void;
    bind(objects: ObjectStore): InMemoryBlobs;
}
export declare function createInMemoryBlobBytes(clock: Clock, crypto: CloudCrypto, options?: InMemoryBlobStoreOptions): InMemoryBlobBytes;
export declare function createInMemoryBlobs(objects: ObjectStore, bytes: InMemoryBlobBytes): InMemoryBlobs;
export {};
// ==== @byok-sdk/cloud dist/stores/in-memory/dedup.d.ts ====
/**
 * In-memory {@link InboundDedupStore} (N3).
 *
 * A bounded ring per physical (tenant, device) or strict (tenant, device,
 * AgentRef) fact, not an unbounded set: the wire is at-least-once (§9), so
 * this makes processing at-most-once without letting a chatty device or Agent
 * grow memory without limit. Check-and-record is one call, so a composition
 * cannot accidentally split it into a racy read-then-write.
 */
import { type TenantId } from '@byok-sdk/core';
import type { AgentRef } from '@byok-sdk/protocol';
import type { InboundDedupStore } from '../ports';
/** Ids retained per physical or Agent-bound key. Same depth as the reference server's ring. */
export declare const DEDUP_RING_CAPACITY = 1024;
export declare class InMemoryInboundDedupStore implements InboundDedupStore {
    #private;
    constructor(capacity?: number);
    checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
    checkAndRecordAgent(tenant: TenantId, deviceId: string, agentRef: AgentRef, envelopeId: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/device-directory.d.ts ====
import type { HarnessInfo } from '@byok-sdk/protocol';
/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below maps a deviceId to that same
 * composite key, so a revocation applied through the composite key is
 * immediately visible to `/byok/challenge` and `/byok/token` with no second
 * copy to keep in sync — and a deleted row is removed from BOTH in one step.
 *
 * Revocation DELETES. `DeviceRecord.revoked` survives as the field every auth
 * path already reads, but no record this store writes ever carries `true`:
 * revocation and machine supersession remove the record outright, so "revoked"
 * and "never registered" are one indistinguishable answer rather than two.
 *
 * A removed device is retired through the task state and the mailbox the
 * composition hands in: its unfinished attempts are settled and its pending
 * rows dead-lettered (see `DeviceDirectory` in `../ports`). Registration and
 * revocation run one at a time, so a retirement never overlaps a later
 * registration of the same device id. A retirement runs in the task state's
 * exclusive section, so no cancellation or abandonment lands between its
 * mailbox and attempt halves, and a failed mailbox expiry puts the
 * registrations back before anything else moved: the in-memory stand-in for
 * the SQL stores' one transaction (#1119).
 */
import { type MailboxStore, type PresenceStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '../ports';
import type { InMemoryTaskAttemptState } from './task-attempts';
export declare class InMemoryDeviceDirectory implements DeviceDirectory {
    #private;
    constructor(tasks: InMemoryTaskAttemptState, mailbox: MailboxStore);
    register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
    get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
    /**
     * Revocation removes the registration. A no-op for a device this tenant does
     * not own: revoking what you cannot address changes nothing.
     */
    revoke(tenant: TenantId, deviceId: string): Promise<void>;
    recordCapabilities(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly harnesses?: readonly HarnessInfo[];
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness>;
    resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/e2ee-member.d.ts ====
import type { TenantId } from '@byok-sdk/core';
import type { E2eeMemberChainAppendInput, E2eeMemberChainAppendResult, E2eeMemberChainRow, E2eeMemberRegisterResult, E2eeMemberRegistrationInput, E2eeMemberRegistrationRow, E2eeMemberStore, E2eeScopeKeyPackagePutInput, E2eeScopeKeyPackagePutResult, E2eeScopeKeyPackageRow } from '../../e2ee-member';
import type { RequestReceiptStore } from '../ports';
/**
 * Reference E2EE member store. Each method checks and writes in one
 * synchronous step, so no other call interleaves with it. A shred receipt
 * goes to `receipts`, the composition's request receipt store, after that
 * step. Appends run one at a time through their receipt writes, so a later
 * shred of a scope cannot record its receipt before the first one.
 */
export declare class InMemoryE2eeMemberStore implements E2eeMemberStore {
    #private;
    constructor(receipts: Pick<RequestReceiptStore, 'record'>);
    appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult>;
    readChainEntries(tenant: TenantId, input: {
        readonly afterSeq: number;
        readonly limit: number;
    }): Promise<readonly E2eeMemberChainRow[]>;
    putScopeKeyPackages(tenant: TenantId, { rows, proof }: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult>;
    readOwnScopeKeyPackages(tenant: TenantId, input: {
        readonly scopeId: string;
        readonly recipient: string;
        readonly afterEpoch: number;
        readonly limit: number;
    }): Promise<{
        readonly rows: readonly E2eeScopeKeyPackageRow[];
        readonly scopeHeadEpoch: number | undefined;
    }>;
    readScopeKeyPackages(tenant: TenantId, input: {
        readonly scopeId: string;
        readonly epoch?: number;
        readonly recipient?: string;
    }): Promise<readonly E2eeScopeKeyPackageRow[]>;
    registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult>;
    readMemberRegistration(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly now: string;
    }): Promise<E2eeMemberRegistrationRow | undefined>;
    putClientPairingMac(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly body: string;
        readonly expiresAt: string;
    }): Promise<'stored' | 'not_registered'>;
    readClientPairingMac(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly now: string;
    }): Promise<string | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/index.d.ts ====
export { InMemoryAgentMessageDraftStore } from './agent-message-draft';
export { InMemoryE2eeMemberStore } from './e2ee-member';
/**
 * The in-memory reference implementation of every cloud-local port.
 *
 * Same posture as `@byok-sdk/core`'s: a reference, not a production store. What it
 * guarantees is that the behavior the handler suites assert is achievable
 * without a database — which is what makes those same assertions meaningful
 * when a durable composition (S3b's journal, S4A's schema) runs them later.
 */
import type { Clock, ObjectStore } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { BlobContentProxy, CloudStores } from '../ports';
import { type InMemoryBlobBytes } from './blobs';
export { AllowAllRateLimiter } from './rate-limiter';
export { BLOB_URL_TTL_MS, InMemoryBlobContentProxy, InMemoryCloudBlobStore, createInMemoryBlobs, createInMemoryBlobBytes, InMemoryBlobBytes, } from './blobs';
export type { InMemoryBlobs, InMemoryBlobStoreOptions } from './blobs';
export { DEDUP_RING_CAPACITY, InMemoryInboundDedupStore } from './dedup';
export { InMemoryDeviceDirectory } from './device-directory';
export { InMemoryNonceStore, NONCE_TTL_MS } from './nonces';
export { InMemoryPairingCodeStore } from './pairing-codes';
export { InMemoryRequestReceiptStore } from './receipts';
export { InMemoryProofRequestReceiptStore } from './proof-receipts';
export { InMemoryTaskAttemptStore } from './task-attempts';
export { InMemoryTaskCancellationStore } from './task-cancellations';
export { InMemoryActivityStore } from './activity';
export { InMemoryApprovalTimelineStore } from './approval-timeline';
export { InMemoryAgentEgressStore } from './agent-egress';
/**
 * The port bundle plus the byte proxy, in the shape `createInMemoryCoreStores`
 * already uses: the composition is an object with a `stores` field, not the
 * bundle itself.
 *
 * `blobContentProxy` sits BESIDE `stores` rather than inside it because it is
 * not a port — `createByokCloud` takes it as its own optional input, and a
 * composition that cannot carry bytes simply has none to hand over.
 */
export interface InMemoryCloudComposition {
    readonly stores: CloudStores;
    readonly blobContentProxy: BlobContentProxy;
}
export declare function createInMemoryCloudStores(clock: Clock, crypto: CloudCrypto, objects: ObjectStore, mailbox: import('@byok-sdk/core').MailboxStore, objectBytes: InMemoryBlobBytes): InMemoryCloudComposition;
// ==== @byok-sdk/cloud dist/stores/in-memory/mailbox-wake.d.ts ====
import type { MailboxWake } from '../../mailbox-wake';
export declare const DEFAULT_MAILBOX_WAKE_FALLBACK_MS = 5000;
export interface InProcessMailboxWakeOptions {
    /** Bounds delivery latency when all hints are lost. Defaults to 5 seconds. */
    readonly fallbackMs?: number;
}
/** Request-local subscriptions behind a port; losing the table only delays reads. */
export declare function createInProcessMailboxWake(options?: InProcessMailboxWakeOptions): MailboxWake;
// ==== @byok-sdk/cloud dist/stores/in-memory/nonces.d.ts ====
import { type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
/**
 * In-memory {@link NonceStore}: single-use challenge nonces, ~5min TTL
 * (docs/protocol.md §6.2).
 *
 * A nonce is bound to the (tenant, device) it was issued for, so a nonce
 * issued to one tenant's device is not validatable by another's even if the
 * value leaks.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { NonceStore } from '../ports';
/** ~5min, matching the reference server (docs/protocol.md §6.2). */
export declare const NONCE_TTL_MS: number;
export declare class InMemoryNonceStore implements NonceStore {
    #private;
    constructor(clock: Clock, crypto: CloudCrypto, ttlMs?: number);
    /** Number of records currently held (post-sweep). Test-facing only. */
    get size(): number;
    issue(tenant: TenantId, deviceId: string): Promise<string>;
    consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/pairing-codes.d.ts ====
/**
 * In-memory {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment answers `undefined` for unknown, expired, and already-used alike.
 * The reference server distinguishes those three in its 401 text; a hosted,
 * multi-tenant surface deliberately does not — the code is a bearer credential
 * addressable across every tenant, and "already used" versus "never existed"
 * is exactly the difference an attacker enumerating codes would pay for.
 *
 * Code issuance and enrollment project this one authority into separate ports.
 * The enrollment path serializes each code through registration and flips
 * `used` only after its shared device directory has accepted the row.
 */
import { type CollectExpiredInput, type CollectExpiredResult, type Clock, type TenantId } from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, PairingEnrollment, PairingEnrollmentInput, PairingCodeInfo, PairingCodeIssueInput, PairingCodeStore } from '../ports';
export declare class InMemoryPairingCodeStore implements PairingCodeStore, PairingEnrollment {
    #private;
    constructor(clock: Clock, devices: DeviceDirectory);
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
    redeemAndRegister(input: PairingEnrollmentInput): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/proof-receipts.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { ProofRequestReceipt, ProofRequestReceiptInput, ProofRequestReceiptStore } from '../ports';
export declare class InMemoryProofRequestReceiptStore implements ProofRequestReceiptStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{
        readonly receipt: ProofRequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/rate-limiter.d.ts ====
/**
 * The reference {@link InboundRateLimiter}: allow-all.
 *
 * S3a's job is to put the seam at gate position 0 — before the type-allow
 * check — not to invent a limiter policy. A hosted deployment's real budget
 * lives at its edge; when it arrives it plugs in here and the gate order does
 * not move.
 */
import type { TenantId } from '@byok-sdk/core';
import type { InboundRateLimiter, RateLimitDecision, RateLimitUnit } from '../ports';
export declare class AllowAllRateLimiter implements InboundRateLimiter {
    consume(_tenant: TenantId, _deviceId: string, _unit: RateLimitUnit, _count: number): Promise<RateLimitDecision>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/receipts.d.ts ====
import { type CollectExpiredResult } from '@byok-sdk/core';
import type { ReceiptCollectExpiredInput } from '../ports';
/**
 * In-memory {@link RequestReceiptStore}: first write wins.
 *
 * The terminal a device reports is a fact, and a retry of the same terminal
 * (the wire is at-least-once) must not overwrite the first one — `created:
 * false` is how the caller learns it was a replay rather than a new fact.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { RequestReceipt, RequestReceiptStore } from '../ports';
export declare class InMemoryRequestReceiptStore implements RequestReceiptStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: {
        key: string;
        body: string;
    }): Promise<{
        receipt: RequestReceipt;
        created: boolean;
    }>;
    get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
    collectExpired(tenant: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/task-attempts.d.ts ====
/**
 * In-memory {@link TaskAttemptStore} — the ownership authority the inbound
 * gate reads (N2).
 *
 * Two deliberate no-ops:
 *
 * - `claim` on a task this tenant never offered writes nothing. A device that
 *   guesses a taskId must not be able to conjure a row (and, cross-tenant,
 *   must not leave a trace in the tenant it guessed into).
 * - `recordStatus` on an unknown task writes nothing, mirroring the reference
 *   server's per-type handlers, whose behavior on a missing record is a no-op
 *   rather than a rejection.
 *
 * Ownership is first-claim-wins and never transfers: reassigning an owner is
 * the one operation that would make the gate's cross-device assertion
 * unfalsifiable.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
import { type AgentMessageAdmission, type AgentRef, type TaskAttempt, type TaskAttemptCounts, type TaskAttemptListQuery, type TaskAttemptPage, type TaskAttemptStatus, type TaskAttemptStore } from '../ports';
interface StoredAgentMessageAdmission extends AgentMessageAdmission {
    readonly deviceId: string;
}
export declare class InMemoryTaskAttemptStore implements TaskAttemptStore {
    #private;
    constructor(clock: Clock, state?: InMemoryTaskAttemptState);
    open(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: AgentRef;
    }): Promise<TaskAttempt>;
    reserveAgentOffer(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: AgentRef;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    reserveAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    recordFirstOutput(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<TaskAttempt | undefined>;
    readTaskAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<AgentMessageAdmission | undefined>;
    readAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    finalizeAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    countByStatus(tenant: TenantId): Promise<TaskAttemptCounts>;
    claim(tenant: TenantId, input: {
        taskId: string;
        deviceId: string;
        runtime?: RuntimeId;
        harnessId?: string;
        capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    recordStatus(tenant: TenantId, input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: AgentRef;
        readonly terminalCause?: string;
    }): Promise<TaskAttempt | undefined>;
}
/** Shared mutable state for the task and cancellation reference ports. */
export declare class InMemoryTaskAttemptState {
    #private;
    readonly attempts: Map<string, TaskAttempt>;
    readonly messageAdmissions: Map<string, StoredAgentMessageAdmission>;
    constructor(clock: Clock);
    now(): string;
    /**
     * Serialize every state-changing operation for one tenant/task key. It also
     * waits for an exclusive section queued before it (see {@link exclusive}).
     */
    mutate<T>(key: string, operation: () => T | Promise<T>): Promise<T>;
    /**
     * Runs `operation` with no task mutation in flight: it starts once every
     * mutation queued before it has settled, and every mutation queued after it
     * waits for it to end. Device retirement runs here, so its attempt and
     * mailbox halves are one step no cancellation or abandonment can split, the
     * in-memory stand-in for the SQL stores' transaction (#1119). `operation`
     * writes `attempts` directly; calling {@link mutate} from it deadlocks.
     */
    exclusive<T>(operation: () => Promise<T>): Promise<T>;
}
export {};
// ==== @byok-sdk/cloud dist/stores/in-memory/task-cancellations.d.ts ====
import { type MailboxStore, type TenantId } from '@byok-sdk/core';
import type { DeviceDirectory, TaskAbandonRequest, TaskAttempt, TaskCancellationMutation, TaskCancellationRequest, TaskCancellationStore } from '../ports';
import { InMemoryTaskAttemptState } from './task-attempts';
/** Failure-free reference composition of the atomic cancellation port. */
export declare class InMemoryTaskCancellationStore implements TaskCancellationStore {
    #private;
    constructor(state: InMemoryTaskAttemptState, mailbox: MailboxStore, devices: Pick<DeviceDirectory, 'get'>);
    request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
    abandon(tenant: TenantId, input: TaskAbandonRequest): Promise<TaskAttempt | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/ports-contract.d.ts ====
/**
 * The declared method inventory of every cloud-local port.
 *
 * The exact counterpart of `@byok-sdk/core`'s `ports-contract.ts`, and it exists
 * for the same reason: the table says what a port IS, so it has to be readable
 * by every enforcer without any of them owning it. `@byok-sdk/conformance` asserts
 * live compositions against it; a durable adapter (`@byok-sdk/cloud-dataplane`) is
 * written against it.
 *
 * This module adds data and nothing else. It does not re-declare, re-shape, or
 * re-interpret a single line of `ports.ts` — that file stays the authority for
 * what the methods mean, and stayed byte-identical through S4A-a.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import type { CloudStoreName } from './ports';
export declare const CLOUD_PORT_METHODS: Readonly<Record<CloudStoreName, readonly string[]>>;
/** The interface each port name is declared as, for a source-side scan. */
export declare const CLOUD_PORT_INTERFACES: Readonly<Record<CloudStoreName, string>>;
// ==== @byok-sdk/cloud dist/stores/ports.d.ts ====
import type { AgentMessageDraftStore } from '../agent-message-draft';
import type { CollectExpiredInput, CollectExpiredResult } from '@byok-sdk/core';
import type { HarnessInfo } from '@byok-sdk/protocol';
/**
 * The cloud-local store ports.
 *
 * `@byok-sdk/core` owns the platform ports every composition shares (mailbox,
 * board, truth, objects, quota). These are the ones only a HOSTED device
 * surface needs — the auth plane and the task-attempt bookkeeping the device
 * routes read. S2 deliberately kept them out of core: they are hosted-surface
 * concerns, and S4A's schema work is the right moment to decide their durable
 * home. Cloud owning them keeps this slice additive and revertible.
 *
 * Two rules, same as core's (`stores.ts`):
 *
 * 1. **Async.** Every method returns a `Promise`, so a SQL or KV composition
 *    can implement the same contract the in-memory reference does.
 * 2. **Tenant-first.** Every method's first parameter is a required
 *    `TenantId` — with one documented lookup exception below. Pairing code
 *    consumption is a separate composition-owned enrollment operation: its
 *    bearer code resolves the tenant internally and it returns only the
 *    resulting device row.
 *
 * The lookup exception:
 *
 * - {@link DeviceDirectory.resolveByDeviceId} — `POST /byok/challenge` and
 *   `POST /byok/token` carry only a deviceId (the pinned wire contract), and
 *   the row is what tells the deployment which tenant to mint for.
 * It is not reachable through {@link TenantStores} (see `tenant-stores.ts`),
 * so a device-facing handler cannot call it.
 *
 * The byte-proxy trio that used to be a third pre-tenant exception is no
 * longer part of this bundle at all: it moved to {@link BlobContentProxy},
 * an OPTIONAL composition input rather than a {@link CloudStores} member,
 * because a composition backed by object storage physically cannot proxy
 * bytes (see the blobs section below).
 */
import type { MailboxBody, MailboxMessage, PresenceStore, StorageReservation, TenantId, TenantReadiness } from '@byok-sdk/core';
import type { AgentEgressReliablePayload, AgentRef, RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
export type { AgentEgressReliablePayload, AgentRef } from '@byok-sdk/protocol';
import type { ActivityStore } from '../activity';
import type { ApprovalTimelineStore } from '../approval-timeline';
export interface DeviceRecord {
    readonly tenantId: TenantId;
    readonly productId: string;
    readonly deviceId: string;
    readonly deviceName: string;
    /** Ed25519 public key, base64url-encoded (JWK `x` form). */
    readonly devicePublicKey: string;
    /** Proof key identity stored on the row; verifier claims never supply a default. */
    readonly proofKeyId: string;
    /** Current proof signing-key rotation generation. */
    readonly proofKeyEpoch: number;
    /**
     * Always `false`. Revocation and machine supersession DELETE the record, so
     * no implementation ever produces a `true` here; the field stays because
     * every auth path reads it and a missing row must fail exactly as a revoked
     * one used to.
     */
    readonly revoked: boolean;
    /**
     * Client-hashed physical machine identity (lowercase hex SHA-256), when the
     * pairing carried one. Absent for every device paired without it — an
     * absent value supersedes nothing, so it is never a filter that silently
     * groups unidentified machines together.
     */
    readonly machineId?: string;
    /**
     * The latest capability snapshot written by an authenticated device
     * handshake. This is deliberately separate from core presence: presence is
     * lossy/TTL-bounded and cannot authorize Agent dispatch.
     */
    readonly capabilities?: readonly string[];
    readonly harnesses?: readonly HarnessInfo[];
}
/** Everything `POST /byok/pair` knows at registration time. `tenantId` is the store's first parameter; `revoked` is the store's own to set (always `false`). */
export interface DeviceRegistration {
    readonly productId: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly proofKeyId: string;
    readonly proofKeyEpoch: number;
    /**
     * Optional client-hashed physical machine identity from `PairRequest`. When
     * present, `register` DELETES this tenant/product's prior rows carrying the
     * same value — and the device-scoped state those rows were the only reason
     * to keep — and retires each one as {@link DeviceDirectory.revoke} does,
     * under `device_superseded`, before inserting, so one physical machine holds
     * one device row per product. It names no tenant and no product of
     * its own — both still come from the redeemed pairing code's claims — so it
     * can only ever supersede rows the caller already addressed.
     */
    readonly machineId?: string;
}
/**
 * Device retirement — revocation, and the supersession of a machine's prior
 * rows on re-pairing — is ONE transaction with the registration change, and
 * every composition, a custom one included, must finalize the retired device
 * in it:
 *
 * 1. Every unfinished attempt of that device ({@link
 *    TASK_ATTEMPT_UNFINISHED_STATUSES}, matched on `deviceId` OR
 *    `ownerDeviceId`) becomes `cancelled` with `terminalCause`
 *    `device_revoked` or `device_superseded` and, when it has none,
 *    `terminalAt`. A terminal attempt is never touched; a cancellation
 *    tombstone stays as it was.
 * 2. Every `pending` mailbox row addressed to that device becomes `expired`
 *    (see `MailboxStore.expirePending`): the rows stop holding mailbox quota
 *    and raise the device's `recoverableFrom`, and nothing is deleted.
 *
 * Neither the task history nor the mailbox rows go away: what the device did
 * and what it was sent stay readable after its grant is gone.
 */
export interface DeviceDirectory {
    /** Registers the device. With `input.machineId` set this ALSO deletes this tenant/product's prior rows carrying that same machine identity — one physical machine, one row — and retires each under `device_superseded`. */
    register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
    /** The row `tenant` owns under `deviceId` — `undefined` including when the device exists under a DIFFERENT tenant. */
    get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
    /**
     * Deletes the registration and the device-scoped state it owned (presence,
     * challenge nonces, assertion-replay entries, inbound dedup), and retires
     * the device under `device_revoked` in the same transaction (see above). A
     * no-op for a device this tenant cannot address. Afterwards every read
     * answers exactly as it does for a device that was never registered.
     *
     * How far the device-state deletion physically reaches is driver-scoped.
     * The durable (Postgres) driver deletes the registration and every
     * dependent device-scoped row in the same transaction, so the state is gone
     * the moment `revoke` resolves. The in-memory reference directory deletes
     * only the registration: presence, nonces and dedup are separate maps it
     * does not own, so a presence hint expires on its own `expiresAt` TTL and,
     * until then, is excluded from every projection by the readiness
     * active-device filter (`activeDeviceIds`, built from the surviving rows).
     * The observable contract above holds either way — no read path can see a
     * revoked device. Retirement of tasks and mailbox rows is not driver-scoped.
     */
    revoke(tenant: TenantId, deviceId: string): Promise<void>;
    list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    /** Set-wise tenant observation. `revokedDeviceCount` is structurally 0 — a revoked device has no row to count. */
    readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness>;
    /**
     * Persist a capability snapshot obtained from an authenticated device
     * message. Implementations may return `undefined` for an unknown (including
     * revoked, which is the same absence) device; callers must fail closed in
     * that case.
     */
    recordCapabilities(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly harnesses?: readonly HarnessInfo[];
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    /** Pre-tenant. Two callers only: `POST /byok/challenge` and `POST /byok/token`. Never exposed through the tenant facade. */
    resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}
/**
 * The identity a pairing code carries. Minted out-of-band by the host's own
 * auth/device-flow UI — the only party that knows which tenant a human is
 * acting for. Deliberately NOT a wire field: `PairRequest` has no tenant of
 * its own, so a device can never name the tenant it lands in.
 */
export interface PairingCodeClaims {
    readonly tenantId: TenantId;
    readonly productId: string;
}
export interface PairingCodeInfo {
    readonly code: string;
    /** Canonical ISO-8601 UTC instant. */
    readonly expiresAt: string;
}
export interface PairingCodeIssueInput {
    readonly code: string;
    readonly productId: string;
    readonly expiresAt: string;
}
export interface PairingCodeStore {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
}
/**
 * The pre-tenant facts a pairing request carries into enrollment. Tenant and
 * product are deliberately absent: the guarded pairing-code row is their sole
 * authority, and no caller can choose the registration scope.
 */
export interface PairingEnrollmentInput {
    readonly pairingCode: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly proofKeyId: string;
    readonly proofKeyEpoch: number;
    readonly machineId?: string;
}
/**
 * The only pairing-code consumption operation. Implementations atomically
 * consume a valid code, apply machine supersession/state cleanup, and register
 * the device; failures leave the code retryable. Unknown, expired, and already
 * consumed codes all return `undefined`.
 */
export interface PairingEnrollment {
    redeemAndRegister(input: PairingEnrollmentInput): Promise<DeviceRecord | undefined>;
}
export interface NonceStore {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    issue(tenant: TenantId, deviceId: string): Promise<string>;
    /**
     * Atomically consume a nonce only when it belongs to this exact (tenant,
     * device), is unexpired, and has not already been consumed. Returns `true`
     * for the sole winner; every other case returns `false`.
     */
    consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
}
export interface InboundDedupStore {
    /**
     * Device-physical envelope ledger (`conn.hello` and facts with no Agent
     * binding). `true` when `envelopeId` was already seen for this (tenant,
     * device); otherwise records it and returns `false`.
     */
    checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
    /**
     * Agent-bound envelope ledger. The AgentRef is required: a same-device
     * second Agent must never resolve or suppress this Agent's completed fact.
     * Retention remains bounded per exact (tenant, device, AgentRef).
     */
    checkAndRecordAgent(tenant: TenantId, deviceId: string, agentRef: AgentRef, envelopeId: string): Promise<boolean>;
}
export declare const TASK_ATTEMPT_STATUSES: readonly ['offered', 'claimed', 'running', 'cancel_requested', 'complete', 'failed', 'cancelled'];
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number];
/** Attempts that can still be in flight, provided no host cancellation is recorded. */
export declare const TASK_ATTEMPT_ACTIVE_STATUSES: readonly ["offered", "claimed", "running"];
/** Every non-terminal status, `cancel_requested` included: the attempts device retirement and abandonment settle. */
export declare const TASK_ATTEMPT_UNFINISHED_STATUSES: readonly ["offered", "claimed", "running", "cancel_requested"];
/**
 * The `terminalCause` cloud itself writes when it settles an attempt no device
 * will ever finish: `device_revoked` and `device_superseded` from device
 * retirement ({@link DeviceDirectory.revoke}, machine supersession in
 * {@link DeviceDirectory.register}), and any of the three from
 * `ByokCloud.abandonTask`. An attempt settled this way is `cancelled` and
 * carries no device terminal receipt.
 */
export declare const TASK_ABANDON_CAUSES: readonly ['operator', 'device_revoked', 'device_superseded'];
export type TaskAbandonCause = (typeof TASK_ABANDON_CAUSES)[number];
export declare function isTaskAbandonCause(value: unknown): value is TaskAbandonCause;
/** One store aggregate; host cancellation is counted separately because it outranks status. */
export interface TaskAttemptCounts {
    /** Every status is present. Rows carrying a cancellation marker are excluded. */
    readonly byStatus: Readonly<Record<TaskAttemptStatus, number>>;
    /** Rows carrying a host cancellation marker, regardless of their status. */
    readonly cancellationRequested: number;
}
/** The durable first-message reservation and, once present, its terminal disposition. */
export interface AgentMessageAdmission {
    readonly messageId: string;
    readonly payloadBody: string;
    readonly terminalBody?: string;
}
export interface TaskAttempt {
    readonly tenantId: TenantId;
    readonly taskId: string;
    /** The device the offer was addressed to. */
    readonly deviceId: string;
    /** Exact Agent identity sealed when the strict Agent offer was opened. */
    readonly agentRef?: AgentRef;
    /** Set by `task.claim`, and only by the first one. Legacy attempts remain claimable by any tenant device until then; strict Agent attempts are target-device bound before this field is consulted. */
    readonly ownerDeviceId?: string;
    readonly status: TaskAttemptStatus;
    /**
     * The runtime the CLAIMING daemon reported for itself on its own
     * `task.claim` (`TaskClaimPayload.runtime`), snapshotted at the
     * `offered -> claimed` transition and never written again — a redelivered or
     * losing claim leaves it exactly as the winning claim left it.
     *
     * ADR-028 forbids cloud holding EXECUTION state (a live `running`/`thinking`
     * phase, a turn, a PID, the current tool call) — quantities that keep
     * changing while an attempt runs. This is not one: it is written once, at
     * the moment ownership is decided, and is an attribution fact about the
     * attempt. Byte-for-byte the same semantics as the reference server's
     * `TaskSnapshot.claimedRuntime` (`packages/server/src/types.ts`).
     *
     * Absent for a daemon whose `task.claim` carried no `runtime` at all.
     */
    readonly claimedRuntime?: RuntimeId;
    readonly claimedHarnessId?: string;
    /**
     * The capability block the CLAIMING adapter reported for ITSELF on that same
     * `task.claim` (`TaskClaimPayload.capabilities`), snapshotted under exactly
     * the same write-once rule as {@link TaskAttempt.claimedRuntime}.
     *
     * This is the ONLY input to the steer gate (`steer-control.ts`,
     * `ByokCloud.steerTask`). The connection-level snapshot cloud keeps —
     * `DeviceRecord.capabilities`, written from `conn.hello`
     * (`inbound.ts`) — describes a device BUILD and never feeds it: a device can
     * reconnect later with a different adapter set, while a task that is already
     * running must keep being judged against what was true when it was claimed.
     * Same single-source rule the reference server pins
     * (`packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`).
     *
     * Absent for a daemon that predates the field, which the gate reads as
     * "unknown" and refuses — unknown is not supported.
     */
    readonly claimedRuntimeCapabilities?: RuntimeCapabilities;
    /** Runtime-reported terminal cause from the first winning terminal. */
    readonly terminalCause?: string;
    /** Durable host cancellation authority. Its presence outranks later device terminal receipts. */
    readonly cancellation?: {
        readonly requestedAt: string;
        readonly reason?: string;
    };
    /**
     * When the offer created this attempt. This and the three phase instants
     * below are written once, by the store operation that makes the transition,
     * from the same clock and in the same format as `updatedAt`, and never again.
     *
     * Like {@link TaskAttempt.claimedRuntime}, they are attribution facts, not
     * the EXECUTION state ADR-028 keeps out of cloud: each stops changing at the
     * transition that sets it. Each is absent until its transition happens, and
     * on attempts stored before the field existed, which are never backfilled.
     */
    readonly offeredAt?: string;
    /** The winning `task.claim` (`offered -> claimed`); a redelivered or losing claim leaves it as the winner left it. */
    readonly claimedAt?: string;
    /**
     * The first visible output after the claim: an Agent message draft with
     * text, or a message body.
     * `task.progress` is not output. Output before the claim is not recorded, so
     * this is never earlier than `claimedAt`.
     */
    readonly firstOutputAt?: string;
    /** The first entry into `complete`, `failed` or `cancelled`. */
    readonly terminalAt?: string;
    readonly updatedAt: string;
}
/**
 * One bounded page request over a tenant's task attempts.
 *
 * Keyset-paged by `taskId` ASCENDING, deliberately, and NOT chronologically: an
 * attempt carries no monotonic sequence, and `updatedAt` moves under an
 * in-flight page (a status transition would re-order rows mid-walk and let a
 * caller skip or repeat one). `taskId` is `task_<uuid>` — stable, unique per
 * tenant, and never rewritten — so it is the only column that gives a walk the
 * exactly-once property. The order is therefore arbitrary but TOTAL, which is
 * what a paged read model needs; a caller that wants recency sorts a page
 * itself.
 *
 * Adding a sequence column to get chronological order was rejected: it is a
 * migration across every composition to serve a read-model nicety, and a second
 * ordering authority to keep consistent with the row it decorates.
 */
export interface TaskAttemptListQuery {
    /** Maximum attempts in the page. Required and fail-closed: a non-positive or non-integer limit is rejected, never silently defaulted or clamped. */
    readonly limit: number;
    /**
     * The `nextCursor` from the previous page — opaque to the caller, and an
     * EXCLUSIVE lower bound on `taskId`. Absent starts at the beginning. A cursor
     * naming a task that has since been deleted still resolves: it is a bound,
     * not a lookup.
     */
    readonly cursor?: string;
    /** Only TASK_ATTEMPT_ACTIVE_STATUSES without a cancellation marker; the same keyset order applies. */
    readonly active?: true;
}
export interface TaskAttemptPage {
    readonly attempts: readonly TaskAttempt[];
    /**
     * Pass as the next request's `cursor`. ABSENT means this page is the end of
     * the walk — not "start over" — so a caller stops on absence rather than on
     * an empty page, and a page that exactly fills `limit` with nothing after it
     * still terminates.
     */
    readonly nextCursor?: string;
}
export interface TaskAttemptStore {
    /** Called when an offer is enqueued: records the pending attempt with no owner yet. */
    open(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: AgentRef;
    }): Promise<TaskAttempt>;
    /**
     * Atomically reserve one strict Agent offer. `created: false` means the task
     * id already had durable authority and no caller may append another offer.
     */
    reserveAgentOffer(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: AgentRef;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    /**
     * Atomically binds one message payload to a live task before an external
     * consumer can run. `pending` is an existing exact reservation whose terminal
     * receipt has not been recorded yet; callers retry the same product consumer
     * contract so its own durable idempotency can reconcile a commit whose local
     * finalization failed. Exact pending lookup precedes the live-task gate, while
     * every new reservation remains lifecycle-gated.
     */
    reserveAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    /**
     * Write-once {@link TaskAttempt.firstOutputAt} for an Agent message draft,
     * written separately after the draft has landed in its own store. Sets it
     * only on an attempt of this device that is already claimed, is not yet
     * terminal and has none; any other call is a no-op. Returns the attempt as stored, or `undefined`
     * for an unknown task.
     *
     * A process that crashes between the draft write and this one leaves the
     * instant to a later output, never to an instant with no output. A message
     * body needs no call: `reserveAgentMessage` stamps it in the reservation's
     * own write.
     */
    recordFirstOutput(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<TaskAttempt | undefined>;
    /** Discover the unique immutable message for a tenant/device/task; caller validates its frozen Agent binding. */
    readTaskAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<AgentMessageAdmission | undefined>;
    /** Read only an exact reservation; conflicting task/message bindings are not observable. */
    readAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    /** CAS the exact reservation to one immutable terminal disposition body. */
    finalizeAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    /** Batch lookup used by mailbox projection; implementations must not turn one poll into N queries. */
    getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    /**
     * One bounded page of this tenant's attempts, keyset-paged by `taskId` — see
     * {@link TaskAttemptListQuery} for why that key and not a timestamp.
     * Implementations must read one page in one query (`taskId > cursor ORDER BY
     * taskId LIMIT limit + 1`), never the whole tenant filtered in memory.
     */
    list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    /** One aggregate over this tenant's stored rows, never an application-side page walk. */
    countByStatus(tenant: TenantId): Promise<TaskAttemptCounts>;
    /**
     * First claim wins the ownership; a later claim by the same device is
     * idempotent. No-op (returns `undefined`) for a task this tenant never
     * offered.
     *
     * `runtime`/`capabilities` are the claiming daemon's self-report, written
     * ONLY by the claim that actually wins the ownership CAS — an idempotent
     * re-claim (and a losing one) must leave the recorded snapshot untouched,
     * including when it carries a different or absent value.
     */
    claim(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly runtime?: RuntimeId;
        readonly harnessId?: string;
        readonly capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    /** Record a lifecycle transition. No-op (returns `undefined`) for an unknown task — same shape as the reference server's per-type handlers. */
    recordStatus(tenant: TenantId, input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: AgentRef;
        readonly terminalCause?: string;
    }): Promise<TaskAttempt | undefined>;
}
export interface TaskCancellationRequest {
    readonly taskId: string;
    readonly proposedMessageId: string;
    readonly reason?: string;
    readonly materialize: (seq: number, messageId: string) => MailboxBody | Promise<MailboxBody>;
}
export interface TaskCancellationMutation {
    readonly attempt: TaskAttempt;
    /** Absent when the task was terminal before cancellation, or once the delivery row is gone. */
    readonly message?: MailboxMessage;
}
export interface TaskAbandonRequest {
    readonly taskId: string;
    readonly cause: TaskAbandonCause;
}
/**
 * One atomic authority for Host-side task termination plus its mailbox
 * effect. Implementations must commit both halves or neither.
 */
export interface TaskCancellationStore {
    /** The cancellation tombstone plus its durable device delivery. */
    request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
    /**
     * Settles an attempt no device will finish, in one transaction: an
     * unfinished attempt becomes `cancelled` with `terminalCause = cause` (and
     * `terminalAt` when it has none), and every `pending` mailbox row of the
     * task — a row whose envelope's top-level `task_id` names it — on a target
     * or owner device that is no longer registered becomes `expired`. A
     * registered device keeps its rows pending, so its `recoverableFrom` never
     * passes a row it has not read. The same transition device retirement
     * applies ({@link DeviceDirectory}). A terminal attempt is
     * returned unchanged and nothing is written; a cancellation tombstone stays
     * as it was. `undefined` for a task this tenant never offered.
     */
    abandon(tenant: TenantId, input: TaskAbandonRequest): Promise<TaskAttempt | undefined>;
}
export interface RequestReceipt {
    readonly tenantId: TenantId;
    readonly key: string;
    /** Opaque payload the caller recorded — for terminals, the encoded envelope. */
    readonly body: string;
    readonly recordedAt: string;
}
export interface RequestReceiptStore {
    collectExpired(tenant: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult>;
    /**
     * Record a receipt under `key`, or return the existing one untouched.
     * `created` is `false` for a replay — the FIRST terminal is the fact
     * (§12.6.4: 不覆写第一份事实), and a retry of the same terminal must not
     * overwrite it.
     */
    record(tenant: TenantId, input: {
        readonly key: string;
        readonly body: string;
    }): Promise<{
        readonly receipt: RequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
}
export interface AgentEgressRecord {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly payload: AgentEgressReliablePayload;
    /** Stable cloud-generated receipt identity echoed on every exact replay. */
    readonly receiptId: string;
    readonly recordedAt: string;
}
export interface AgentEgressStore {
    /** First event-id write wins; callers reject mismatches rather than updating. */
    record(tenant: TenantId, input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    /** Exact reliable fact lookup; device plus event id alone is ambiguous. */
    get(tenant: TenantId, deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressRecord | undefined>;
}
export interface ProofRequestReceipt {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly bodySha256: string;
    readonly bodySize: bigint;
    readonly responseStatus: number;
    readonly responseBody: string;
    readonly recordedAt: string;
}
export type ProofRequestReceiptInput = Omit<ProofRequestReceipt, 'tenantId' | 'recordedAt'>;
/**
 * First-result-wins replay store. The application layer compares every stored
 * binding before returning an exact replay; a reused request id with any
 * different binding is a conflict, never a second write.
 */
export interface ProofRequestReceiptStore {
    record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{
        readonly receipt: ProofRequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined>;
}
export interface BlobDeclaration {
    readonly size: number;
    readonly contentType: string;
    /** Canonical `sha256:<64 lowercase hex>` — the schema rejected anything else before this store sees it. */
    readonly contentHash: string;
}
/** What object-store metadata can actually observe at finalize (ADR-024). */
export interface BlobObservation {
    readonly observedByteSize: bigint;
    readonly observedContentType: string;
}
export type BlobWriteResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: string;
};
export interface BlobContent {
    readonly data: Uint8Array;
    readonly contentType: string;
}
/**
 * How a byte-proxying read can fail while the blob itself is known to exist.
 *
 * The split is about WHERE the failure landed relative to the upstream
 * response, because that is the only part a proxy can observe and the only
 * part an operator can act on: `blob_upstream_unavailable` means nothing came
 * back at all (the upstream was unreachable/refused before its response
 * started), so a retry may succeed unchanged; `blob_upstream_stream_interrupted`
 * means the response HAD started and died mid-transfer, so whatever the caller
 * already has is a truncated prefix, not a short blob.
 *
 * Both are 502 on the wire (see `BLOB_READ_ERROR_HTTP_STATUS` in
 * `handlers/blobs.ts`) — the CODE carries the distinction, not the status.
 */
export declare const BLOB_READ_ERROR_CODES: readonly ['blob_upstream_unavailable', 'blob_upstream_stream_interrupted'];
export type BlobReadErrorCode = (typeof BLOB_READ_ERROR_CODES)[number];
/**
 * The result of {@link BlobContentProxy.readContent}, in the same union idiom
 * as {@link BlobWriteResult}. Note what is NOT in here: not-found stays
 * `undefined` at the method's return type, so "no such blob" keeps its
 * existing 404 meaning and never has to be spelled as a failure code.
 */
export type BlobReadResult = {
    readonly ok: true;
    readonly content: BlobContent;
} | {
    readonly ok: false;
    readonly code: BlobReadErrorCode;
};
/**
 * The capability-minting half of blobs: what EVERY composition can honestly
 * provide, whoever holds the bytes.
 *
 * Both methods are tenant-first, and both are reachable through {@link
 * TenantStores}. There is no pre-tenant method left on this port — see
 * {@link BlobContentProxy} for where the other three went and why.
 */
export interface CloudBlobStore {
    /** Mint only from an already-admitted object reservation. */
    createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{
        readonly blobId: string;
        readonly uploadUrl: string;
    }>;
    /** Observe existence/size/type while proving this blob belongs to this reservation. */
    observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    /** A presigned GET URL for a blob THIS tenant owns that has finished uploading; `undefined` otherwise — including for another tenant's blob. */
    getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}
/**
 * The byte-proxying half: an OPTIONAL composition input, not a port.
 *
 * These three serve the two `/byok/blobs/:id/content` routes, which exist
 * because the in-memory and self-hosted compositions have nowhere else to put
 * bytes — cloud has to carry them. A composition whose bytes live in object
 * storage (S3/R2) hands the device a presigned URL to the object store itself
 * and never sees a byte, so it cannot implement these at all.
 *
 * That is why this is a separate interface supplied at composition time rather
 * than a member of {@link CloudStores}: "this deployment cannot proxy bytes"
 * becomes a type-level fact (the proxy is simply absent) instead of three
 * methods that throw. The alternatives were both anti-patterns — a conformance
 * suite that skips three methods for one composition is a subset waiver, and
 * one that asserts a typed rejection proves nothing
 * (docs/researches/s4a-dataplane-design.md §6).
 *
 * All three are pre-tenant by construction: the `/content` routes are
 * presigned, not bearer-authed, so there is no principal in scope at all and
 * the HMAC signature over the blob id is the whole credential. They stay off
 * {@link TenantStores} for the same reason the two exceptions above do.
 *
 * A deployment supplying a proxy must also declare `blobs.contentproxy`
 * (ADR-010): the routes mount on proxy-presence AND declaration, never on
 * either alone.
 */
export interface BlobContentProxy {
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean>;
    /** Authoritative declared size for a signed PUT; no byte buffering precedes this lookup. */
    expectedUploadBytes(blobId: string): Promise<bigint | undefined>;
    /**
     * Claim the one upload a blob may have in flight. `undefined` means another
     * upload of this blob is in flight (409 `upload_in_progress`); otherwise the
     * returned release must run once the request ends, however it ends. Claims
     * are process memory, never persisted, so a crash cannot leave one stuck.
     */
    claimUpload(blobId: string): Promise<(() => void) | undefined>;
    writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult>;
    /** `undefined` = no such blob (404); a `{ok:false}` result = the blob exists but its bytes could not be proxied (502, distinguished by {@link BlobReadErrorCode}). */
    readContent(blobId: string): Promise<BlobReadResult | undefined>;
}
/**
 * What a debit spends: the envelopes of one `POST /byok/messages` batch,
 * charged together before the first one reaches the inbound gate (so a flood
 * of garbage-typed envelopes costs the same as a flood of well-formed ones),
 * or one authenticated device-class request at route admission.
 * `POST /byok/messages` spends only its envelopes.
 */
export type RateLimitUnit = 'envelope' | 'request';
/** A refusal always says how long until the device's budget admits it again. */
export type RateLimitDecision = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly retryAfterMs: number;
};
/**
 * The one per-device admission budget. Both units debit the same budget; the
 * unit lets a composition count envelopes and requests separately. A refusal
 * answers 429 with `Retry-After` derived from `retryAfterMs`. The in-memory
 * reference is allow-all; the Postgres composition and the embedded server
 * compose token buckets.
 *
 * `count` is how many units one admission charges: 1 for a request, the batch
 * length (0 to `MAX_MESSAGES_PER_BATCH`) for envelopes. A token bucket admits
 * while it holds at least one token and then charges the full `count`, even
 * past zero, so a batch larger than the burst is still admissible and the
 * debt it leaves is repaid before the device's next admission. Requiring
 * `count` tokens up front instead would refuse every batch larger than the
 * burst forever.
 */
export interface InboundRateLimiter {
    consume(tenant: TenantId, deviceId: string, unit: RateLimitUnit, count: number): Promise<RateLimitDecision>;
}
/**
 * All-or-nothing: a composition supplies every port here or it is not a
 * composition. {@link BlobContentProxy} is deliberately absent — it is an
 * optional input to `createByokCloud`, not a port, precisely so that the
 * bundle can stay all-or-nothing while byte proxying stays optional.
 */
export interface CloudStores {
    readonly activity: ActivityStore;
    readonly approvals: ApprovalTimelineStore;
    readonly agentMessageDraft: AgentMessageDraftStore;
    readonly devices: DeviceDirectory;
    readonly pairingCodes: PairingCodeStore;
    readonly pairing: PairingEnrollment;
    readonly nonces: NonceStore;
    readonly dedup: InboundDedupStore;
    readonly tasks: TaskAttemptStore;
    readonly cancellations: TaskCancellationStore;
    readonly receipts: RequestReceiptStore;
    readonly egress: AgentEgressStore;
    readonly proofReceipts: ProofRequestReceiptStore;
    readonly blobs: CloudBlobStore;
    readonly rateLimiter: InboundRateLimiter;
}
/** Names of every port in {@link CloudStores}, in contract order. */
export declare const CLOUD_STORE_NAMES: readonly ['activity', 'approvals', 'agentMessageDraft', 'devices', 'pairingCodes', 'pairing', 'nonces', 'dedup', 'tasks', 'cancellations', 'receipts', 'egress', 'proofReceipts', 'blobs', 'rateLimiter'];
export type CloudStoreName = (typeof CLOUD_STORE_NAMES)[number];
export interface ReceiptCollectExpiredInput extends CollectExpiredInput {
    readonly requestBefore: string;
}
// ==== @byok-sdk/cloud dist/task-agent-message.d.ts ====
import { type AgentRef, type AgentMessagePublishPayload, type AgentMessageServerContext, type AgentMessageDispositionPayload } from '@byok-sdk/protocol';
import type { TenantStores } from './tenant-stores';
/** SDK transmission evidence; payload remains untrusted and never authors a Host product message. */
export interface TaskAgentMessage {
    readonly payload: AgentMessagePublishPayload;
    readonly context: AgentMessageServerContext;
    /** Absent while the exact first-message reservation remains pending. */
    readonly disposition?: AgentMessageDispositionPayload;
}
/** Discover the one durable message without requiring the Host to have received its body. */
export declare function readTaskAgentMessage(stores: TenantStores, deviceId: string, taskId: string, expectedRef: AgentRef): Promise<TaskAgentMessage | undefined>;
/** One frozen identity check shared by message and draft readers. */
export declare function readTaskAgentMessageBinding(stores: TenantStores, deviceId: string, taskId: string, agentRef: AgentRef): Promise<{
    attempt: import(".").TaskAttempt;
    frozen: {
        agentRef: {
            agentId: string;
            profileRevision: string;
        };
        sessionRef?: string | undefined;
        requirement: {
            mode: "required";
            contract: string;
            contentType: "text/markdown" | "text/plain";
            maxBytes: number;
        };
        context: {
            destinationBinding: string;
            freshnessCursor?: string | undefined;
        };
    };
} | undefined>;
// ==== @byok-sdk/cloud dist/task-redaction.d.ts ====
/**
 * Scoped row-delete for plaintext task content (#654 E5a).
 *
 * The Host names terminal tasks. A store replaces each stored body of those
 * tasks with a body-free tombstone, deletes the task's ephemeral rows and the
 * objects its bodies name, and writes one audit receipt. The rows themselves
 * stay, so every identity fence keeps working: a replay of the same body
 * compares equal to the tombstone of that body, and a different body is still
 * a conflict.
 *
 * This module is the one authority for the tombstone format. A store builds
 * tombstones only through the {@link TaskRedactionCodec} that cloud passes in.
 */
import { type ContentHash, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from './crypto/port';
/** The largest number of task ids that one `redactTasks` call accepts. */
export declare const TASK_REDACTION_MAX_TASKS = 100;
export interface TaskRedactionCounts {
    /** Receipt bodies replaced by a tombstone. */
    readonly receiptsRedacted: number;
    /** `agent_message_admission` rows whose bodies were replaced. */
    readonly admissionsRedacted: number;
    /** Acked or expired mailbox rows whose bodies were replaced. */
    readonly outboxRedacted: number;
    /** Activity, approval-timeline and message-draft rows deleted. */
    readonly ephemeralRowsDeleted: number;
    /** Stored objects deleted because a redacted body named them. */
    readonly objectsDeleted: number;
}
export type TaskRedactionRefusal = 'task_not_terminal' | 'pending_delivery';
export type TaskRedactionTaskResult = {
    readonly taskId: string;
    /** `already_redacted`: an earlier call wrote the audit receipt and this call changed nothing. */
    readonly outcome: 'redacted' | 'already_redacted';
    readonly counts: TaskRedactionCounts;
} | {
    readonly taskId: string;
    readonly outcome: 'not_found';
}
/** Retry later. `pending_delivery` clears when the device acks or the row expires. */
 | {
    readonly taskId: string;
    readonly outcome: 'refused';
    readonly reason: TaskRedactionRefusal;
};
export interface TaskRedactionResult {
    readonly tasks: readonly TaskRedactionTaskResult[];
}
/** The tombstone rules a store applies inside its own transaction. */
export interface TaskRedactionCodec {
    /** The body-free replacement. One body always gives the same tombstone. */
    tombstone(body: string): Promise<{
        readonly body: string;
        readonly bodyHash: ContentHash;
        readonly byteSize: bigint;
    }>;
    /**
     * The tombstone for a body that was never stored. A store writes it under an
     * absent terminal receipt key, so a late device terminal stores nothing.
     */
    readonly absent: string;
    isTombstone(body: string): boolean;
    /** The object hashes of every BlobRef in `body`. A body that is not JSON names none. */
    blobHashes(body: string): readonly ContentHash[];
}
export interface TaskRedactionStoreInput {
    readonly tenantId: TenantId;
    readonly taskId: string;
    /** Every receipt key that holds this task's content. Cloud derives them; the store does not. */
    readonly receiptKeys: readonly string[];
    /** The device terminal receipt key. It is one of `receiptKeys`. When it is absent, the store writes `codec.absent` there. */
    readonly terminalReceiptKey: string;
    /**
     * The object references this task holds (#654: its sealed ciphertext
     * blobs). The store removes them inside the redaction, after its refusal
     * checks, so the objects that the bodies name can then be deleted.
     */
    readonly releaseObjectReferences: readonly {
        readonly refKind: string;
        readonly refId: string;
    }[];
    /** The identity receipt that records this redaction. */
    readonly auditReceiptKey: string;
    readonly codec: TaskRedactionCodec;
}
/**
 * Durable redaction authority for one task. It must be tenant-closed, refuse a
 * task that is not terminal or still has an undelivered mailbox row, and be
 * safe to call again after any failure. Inside the transaction that holds the
 * task lock, and before it reads the receipts, it must write `codec.absent`
 * under `terminalReceiptKey` when that key is absent. Without this fence a late
 * device terminal stores new plaintext after the redaction.
 */
export interface TaskRedactionStore {
    redactTask(input: TaskRedactionStoreInput): Promise<TaskRedactionTaskResult>;
}
/** The audit receipt key. It is an identity receipt and never expires. */
export declare function taskRedactionReceiptKey(taskId: string): string;
export declare function isTaskRedactionTombstone(body: string): boolean;
/** Readers call this before they parse a task body. */
export declare function assertTaskContentPresent(taskId: string, body: string): void;
/** True when `stored` holds `proposed` or the tombstone of `proposed`. */
export declare function sameTaskBody(stored: string, proposed: string, crypto: Pick<CloudCrypto, 'sha256'>): Promise<boolean>;
export declare function parseTaskRedactionInput(input: {
    readonly taskIds: readonly string[];
}): readonly string[];
export declare function taskRedactionCodec(crypto: Pick<CloudCrypto, 'sha256'>): TaskRedactionCodec;
// ==== @byok-sdk/cloud dist/tenant-stores.d.ts ====
import type { AgentMessageDraftStore } from './agent-message-draft';
import type { HarnessInfo } from '@byok-sdk/protocol';
/**
 * Layer 2 of the six-layer isolation model (§12.6.2) — the tenant-closed
 * facade a handler actually receives.
 *
 * `@byok-sdk/core`'s `stores.ts` deliberately left this undefined: it is shaped by
 * how handlers are written, and the first handlers live here. This is that
 * shape, and the two properties it exists to enforce are:
 *
 * 1. **It can only be built from an authenticated principal.** {@link
 *    tenantStoresFor} is the only constructor, and its first parameter is a
 *    `Principal` — a value that only `authenticateBearer` (`auth/bearer.ts`)
 *    mints, and only from a device ROW. There is no path from a device-supplied
 *    string to a facade.
 * 2. **No handler ever passes a `TenantId` again.** Every method below has the
 *    tenant pre-applied, so a handler cannot read `principal.tenantId` off one
 *    principal and hand a different tenant to a store. Grep the handler tree
 *    for `TenantId` and you will not find one — asserted by
 *    `src/__tests__/constraints.test.ts`.
 *
 * The three pre-tenant store methods (`resolveByDeviceId`, `redeem`, the
 * presigned blob calls) are deliberately absent from this surface: a
 * device-facing handler must not be able to reach them.
 */
import { type BoardClaimInput, type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type BoardStatusUpdateInput, type BoardUnclaimInput, type ContentHash, type CoreStores, type MailboxAdvanceCursorInput, type MailboxAppendInput, type MailboxCursorState, type MailboxMessage, type MailboxPage, type MailboxReadQuery, type MailboxRecordDeliveryInput, type ObjectManifestEntry, type ObjectReferenceInput, type Principal, type PresenceHint, type PresenceHintInput, type TenantReadiness, type StorageFinalizeInput, type StorageFinalizeResult, type StorageReservation, type StorageReservationInput, type TenantId } from '@byok-sdk/core';
import type { AgentRef, RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
import type { MailboxWake, MailboxWakeSubscription } from './mailbox-wake';
import type { ActivityAppendInput, ActivityTail } from './activity';
import type { ApprovalTimelineAppendInput, ApprovalTimelineTail } from './approval-timeline';
import type { BlobObservation, CloudStores, DeviceRecord, AgentEgressRecord, RateLimitDecision, RateLimitUnit, RequestReceipt, TaskAbandonRequest, TaskCancellationMutation, TaskCancellationRequest, TaskAttempt, TaskAttemptStatus } from './stores/ports';
export interface TenantBoundMailbox {
    /** Subscribe before reading; hints never replace durable mailbox reads. */
    watch(deviceId: string, signal: AbortSignal): MailboxWakeSubscription;
    append(input: MailboxAppendInput): Promise<MailboxMessage>;
    /** Pure read. Never advances the cursor — the daemon's next poll is the only ack. */
    readAfter(query: MailboxReadQuery): Promise<MailboxPage>;
    recordDelivery(input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    advanceCursor(input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    readCursor(deviceId: string): Promise<MailboxCursorState>;
}
export interface TenantBoundBoard {
    create(input: BoardItemInput): Promise<BoardItem>;
    get(itemId: string): Promise<BoardItem | undefined>;
    list(query: BoardListQuery): Promise<BoardPage>;
    claim(input: BoardClaimInput): Promise<BoardItem>;
    unclaim(input: BoardUnclaimInput): Promise<BoardItem>;
    updateStatus(input: BoardStatusUpdateInput): Promise<BoardItem>;
}
export interface TenantBoundPresence {
    publish(input: PresenceHintInput): Promise<PresenceHint>;
    read(deviceId: string): Promise<PresenceHint | undefined>;
    list(): Promise<readonly PresenceHint[]>;
}
export interface TenantBoundActivity {
    append(input: ActivityAppendInput): Promise<ActivityTail>;
    read(taskId: string): Promise<ActivityTail | undefined>;
}
export interface TenantBoundApprovalTimeline {
    append(input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    read(taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export interface TenantBoundDevices {
    get(deviceId: string): Promise<DeviceRecord | undefined>;
    list(): Promise<readonly DeviceRecord[]>;
    revoke(deviceId: string): Promise<void>;
    /** Persist the authenticated device's own capability snapshot. */
    recordCapabilities(input: {
        readonly harnesses?: readonly HarnessInfo[];
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    readiness(): Promise<TenantReadiness>;
}
export interface TenantBoundTaskAttempts {
    open(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: TaskAttempt['agentRef'];
    }): Promise<TaskAttempt>;
    reserveAgentOffer(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: NonNullable<TaskAttempt['agentRef']>;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    reserveAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    recordFirstOutput(input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<TaskAttempt | undefined>;
    readTaskAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<import('./stores/ports').AgentMessageAdmission | undefined>;
    readAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<import('./stores/ports').AgentMessageAdmission | undefined>;
    finalizeAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<import('./stores/ports').AgentMessageAdmission | undefined>;
    get(taskId: string): Promise<TaskAttempt | undefined>;
    getMany(taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    countByStatus(): Promise<import('./stores/ports').TaskAttemptCounts>;
    list(query: import('./stores/ports').TaskAttemptListQuery): Promise<import('./stores/ports').TaskAttemptPage>;
    claim(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly runtime?: RuntimeId;
        readonly harnessId?: string;
        readonly capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    recordStatus(input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: TaskAttempt['agentRef'];
        readonly terminalCause?: TaskAttempt['terminalCause'];
    }): Promise<TaskAttempt | undefined>;
}
export interface TenantBoundTaskCancellations {
    request(input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
    abandon(input: TaskAbandonRequest): Promise<TaskAttempt | undefined>;
}
export interface TenantBoundDedup {
    /** Device-physical envelope ledger. */
    checkAndRecord(deviceId: string, envelopeId: string): Promise<boolean>;
    /** Strict Agent-bound envelope ledger. */
    checkAndRecordAgent(deviceId: string, agentRef: AgentRef, envelopeId: string): Promise<boolean>;
}
export interface TenantBoundReceipts {
    record(input: {
        readonly key: string;
        readonly body: string;
    }): Promise<{
        readonly receipt: RequestReceipt;
        readonly created: boolean;
    }>;
    get(key: string): Promise<RequestReceipt | undefined>;
}
export interface TenantBoundAgentEgress {
    record(input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressRecord | undefined>;
}
export interface TenantBoundBlobs {
    createUpload(reservation: StorageReservation): Promise<{
        readonly blobId: string;
        readonly uploadUrl: string;
    }>;
    observeUpload(blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    getDownloadUrl(blobId: string): Promise<string | undefined>;
}
/** The object manifest reads and references a task needs for the blobs it names (#654). */
export interface TenantBoundObjects {
    get(hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
    addReference(input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    removeReference(input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
}
export interface TenantBoundQuota {
    readReservation(reservationId: string): Promise<StorageReservation | undefined>;
    reserve(input: StorageReservationInput): Promise<StorageReservation>;
    finalizeReservation(input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    abortReservation(reservationId: string): Promise<StorageReservation>;
}
export interface TenantBoundRateLimiter {
    consume(deviceId: string, unit: RateLimitUnit, count: number): Promise<RateLimitDecision>;
}
export interface TenantStores {
    readonly tenant: TenantId;
    readonly principal: Principal;
    readonly mailbox: TenantBoundMailbox;
    readonly board: TenantBoundBoard;
    readonly presence: TenantBoundPresence;
    readonly activity: TenantBoundActivity;
    readonly approvals: TenantBoundApprovalTimeline;
    readonly agentMessageDraft: {
        apply(input: Parameters<AgentMessageDraftStore['apply']>[1]): ReturnType<AgentMessageDraftStore['apply']>;
        read(taskId: string): ReturnType<AgentMessageDraftStore['read']>;
        delete(taskId: string): Promise<void>;
    };
    readonly devices: TenantBoundDevices;
    readonly tasks: TenantBoundTaskAttempts;
    readonly cancellations: TenantBoundTaskCancellations;
    readonly dedup: TenantBoundDedup;
    readonly receipts: TenantBoundReceipts;
    readonly egress: TenantBoundAgentEgress;
    readonly blobs: TenantBoundBlobs;
    readonly objects: TenantBoundObjects;
    readonly quota: TenantBoundQuota;
    readonly rateLimiter: TenantBoundRateLimiter;
}
/** Every naked store a composition supplies. Only {@link tenantStoresFor} reads this. */
export interface CloudRootStores {
    readonly core: CoreStores;
    readonly cloud: CloudStores;
    readonly mailboxWake: MailboxWake;
}
export declare function tenantStoresFor(principal: Principal, root: CloudRootStores): TenantStores;
// ==== @byok-sdk/cloud dist/terminal-result.d.ts ====
import { type AgentRef, type BlobRef, type Envelope, type TerminalInferenceUsage, type TerminalPreparedObservation, type TerminalAgentHomeProjection, type TerminalAgentHomeMemoryChange, type TaskFailPayload, type TaskFailure, type TaskDeclinePayload } from '@byok-sdk/protocol';
import type { RequestReceipt } from './stores/ports';
declare const DEVICE_TERMINAL_TYPES: readonly ['task.complete', 'task.fail', 'task.decline', 'task.cancelled'];
/**
 * Canonical device evidence, independent of the Host cancellation projection.
 * A sealed terminal keeps its sealed member, which a member opens (#654 12e).
 */
export interface DeviceTerminal {
    readonly envelope: Extract<Envelope, {
        type: (typeof DEVICE_TERMINAL_TYPES)[number];
    }>;
    readonly recordedAt: string;
}
export declare function readDeviceTerminalReceipt(taskId: string, receipt: RequestReceipt): DeviceTerminal;
/**
 * The typed terminal read model — the hosted counterpart of the embedded
 * coordinator's `TaskResult`, projected off the receipt the inbound gate
 * stores. Every field is copied verbatim from the payload the gate already
 * zod-parsed before storing (`recordTerminal`, `inbound.ts`); this projection
 * neither re-validates nor synthesizes one.
 */
export interface TerminalResult {
    readonly taskId: string;
    readonly harnessId?: string;
    /** Local interruption observation; claimed ownership remains on TaskAttempt. */
    readonly recovery?: TaskFailPayload['recovery'];
    readonly state: 'complete' | 'failed' | 'cancelled';
    /** Exact Agent identity echoed by the winning terminal, when Agent-bound. */
    readonly agentRef?: AgentRef;
    /**
     * The task-free Agent-home projection applied when the Attempt started,
     * verbatim from the winning terminal. Compare it with `agentRef` to see
     * which persona revision the task ran with. Absent when not Agent-bound or
     * when the home had no applied projection.
     */
    readonly agentHomeProjection?: TerminalAgentHomeProjection;
    /**
     * Memory-change evidence of a `memory-reader` Attempt, verbatim from the
     * winning terminal: whether `MEMORY.md` or `notes/` changed while the reader
     * ran, and which files. Absent for a writer Attempt, for a claimed failure
     * before the Attempt became active, and for an older daemon.
     */
    readonly agentHomeMemoryChange?: TerminalAgentHomeMemoryChange;
    readonly summary?: string;
    /**
     * The runtime's closing reply, verbatim `task.complete.finalMessage`. Absent
     * when the run ended with no closing text, or when an older daemon sent none.
     */
    readonly finalMessage?: string;
    readonly sessionRef?: string;
    readonly artifactRefs?: readonly BlobRef[];
    /**
     * The product's structured terminal result, verbatim `task.complete.document`.
     * Absent — key missing, never null — when the daemon sent none: on every
     * non-complete terminal, and on a completion whose offer selected no
     * `result-document` terminal projection (a result-document run without a
     * submitted outcome ends in `task.fail`, not a document-less completion).
     */
    readonly document?: unknown;
    /**
     * Device/runtime terminal observation copied from the canonical winning
     * receipt. It is telemetry only — never cloud storage usage, billing, quota
     * or entitlement authority.
     */
    readonly usage?: TerminalInferenceUsage;
    /**
     * The prepared-only observation copied verbatim from a prepared Execution's
     * winning `task.complete` / `task.fail`: the frozen request digest, the
     * first provider call's prompt tokens and the largest. Unlike `usage` it is
     * evidence the Host checks its own budget ruling against; the cloud performs
     * no arithmetic over it.
     */
    readonly preparedObservation?: TerminalPreparedObservation;
    readonly reason?: string;
    /** Verbatim home-busy decline code; reason is display text only. */
    readonly code?: TaskDeclinePayload['code'];
    /** Terminal cause projection; currently the protocol's terminal reason. */
    readonly terminalCause?: string;
    readonly retryable?: boolean;
    /**
     * The machine-readable runtime failure class, verbatim `task.fail.failure`
     * (plaintext on a sealed `task.fail` too). Read the class here, never from
     * `reason`. Absent when the daemon or the server predates the field, or the
     * daemon built the terminal while it had no live connection.
     */
    readonly failure?: TaskFailure;
    /** When the receipt store wrote the terminal fact — the first one, by its own first-write-wins rule. */
    readonly recordedAt: string;
}
/**
 * Pure projection of a terminal receipt onto {@link TerminalResult}. A sealed
 * terminal projects only its plaintext fields; its moved fields stay in the
 * sealed member, which {@link DeviceTerminal} carries. `taskId`
 * names the task the receipt was read for (the receipt's key carries it, its
 * body does not); `recordedAt` is the receipt store's write time.
 *
 * Fail closed on anything but a terminal envelope: the stored body is
 * `encodeEnvelope` of what the inbound gate accepted, so an undecodable body
 * or a non-terminal type means the receipt-store contract itself broke — an
 * error, never a best-effort shape.
 */
export declare function projectTerminalResult(taskId: string, receipt: RequestReceipt): TerminalResult;
export {};
// ==== @byok-sdk/cloud dist/truth/contract.d.ts ====
import type { ContentHash, TenantId, TruthBodyRef, TruthManifestEntry, TruthManifestQuery, TruthRecord, TruthRecordKind, TruthRecordSelector } from '@byok-sdk/core';
import { z } from 'zod';
export declare const TRUTH_RECORD_CAPABILITY = "truth.records";
export declare const TRUTH_INLINE_CONTENT_TYPE = "application/vnd.byok.truth+utf8";
export declare const TRUTH_REQUEST_ID_MAX_LENGTH = 120;
export declare const TRUTH_RECORD_KEY_MAX_LENGTH = 200;
export declare const TRUTH_LABEL_MAX_LENGTH = 200;
export declare const TRUTH_BATCH_MAX_RECORDS = 32;
export declare const TRUTH_MANIFEST_MAX_LIMIT = 100;
export declare const TruthRecordKeySchema: z.ZodString;
export declare const TruthBodyInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"inline">;
    content: z.ZodString;
    contentHash: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"object">;
    contentHash: z.ZodString;
    byteSize: z.ZodNumber;
}, z.core.$strict>], "kind">;
export declare const TruthWriteRequestSchema: z.ZodObject<{
    expectedRev: z.ZodOptional<z.ZodNumber>;
    body: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"inline">;
        content: z.ZodString;
        contentHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"object">;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
    }, z.core.$strict>], "kind">;
    label: z.ZodOptional<z.ZodString>;
    snapshots: z.ZodOptional<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
        }>;
        recordKey: z.ZodString;
        expectedRev: z.ZodNumber;
        body: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"inline">;
            content: z.ZodString;
            contentHash: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"object">;
            contentHash: z.ZodString;
            byteSize: z.ZodNumber;
        }, z.core.$strict>], "kind">;
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type TruthBodyInput = z.infer<typeof TruthBodyInputSchema>;
export type TruthWriteRequest = z.infer<typeof TruthWriteRequestSchema>;
export type PreparedTruthWrite = {
    readonly kind: 'task.terminal';
    readonly recordKey: string;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
} | {
    readonly kind: 'profile' | 'memory';
    readonly recordKey: string;
    readonly expectedRev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
};
export interface TruthCommitInput {
    readonly deviceId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly proofBodySha256: string;
    readonly proofBodySize: bigint;
    readonly writes: readonly [PreparedTruthWrite, ...PreparedTruthWrite[]];
}
export interface TruthRecordMetadata {
    readonly kind: TruthRecordKind;
    readonly recordKey: string;
    readonly rev: number;
    readonly contentHash: string;
    readonly byteSize: number;
    readonly label?: string;
    readonly updatedAt: string;
}
export declare const TruthRecordMetadataSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        memory: "memory";
        profile: "profile";
        "task.terminal": "task.terminal";
    }>;
    recordKey: z.ZodString;
    rev: z.ZodNumber;
    contentHash: z.ZodString;
    byteSize: z.ZodNumber;
    label: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodString;
}, z.core.$strict>;
export interface TruthCommitResponse {
    readonly primary: TruthRecordMetadata;
    readonly snapshots: readonly TruthRecordMetadata[];
}
export declare const TruthCommitResponseSchema: z.ZodObject<{
    primary: z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
            "task.terminal": "task.terminal";
        }>;
        recordKey: z.ZodString;
        rev: z.ZodNumber;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
        label: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodString;
    }, z.core.$strict>;
    snapshots: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
            "task.terminal": "task.terminal";
        }>;
        recordKey: z.ZodString;
        rev: z.ZodNumber;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
        label: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export interface TruthCommitResult {
    readonly response: TruthCommitResponse;
    readonly replayed: boolean;
}
export interface TruthCommitter {
    commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult>;
    getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
    listManifest(tenant: TenantId, query: TruthManifestQuery): Promise<readonly TruthManifestEntry[]>;
}
/**
 * Object download grant authority for truth bodies. The input is the canonical
 * content hash stored in `TruthBodyRef`, never an opaque upload id.
 */
export interface TruthObjectDownloads {
    getDownloadUrl(tenant: TenantId, hash: ContentHash): Promise<string | undefined>;
}
export declare function truthRecordMetadata(record: TruthRecord): TruthRecordMetadata;
export declare function truthManifestMetadata(entry: TruthManifestEntry): TruthRecordMetadata;
// ==== @byok-sdk/cloud dist/truth/errors.d.ts ====
export declare const TRUTH_COMMIT_ERROR_CODES: readonly ['proof_request_conflict', 'truth_object_not_committed'];
export type TruthCommitErrorCode = (typeof TRUTH_COMMIT_ERROR_CODES)[number];
export declare class TruthCommitError extends Error {
    readonly code: TruthCommitErrorCode;
    readonly current?: unknown;
    constructor(code: TruthCommitErrorCode, message: string, current?: unknown);
}
export declare function isTruthCommitError(value: unknown): value is TruthCommitError;
