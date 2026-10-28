export type {
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeAdapterPrepareInput,
  RuntimeAdapterPrepareResult,
  RuntimeAdapterRejectedOperation,
  RuntimeAdapterPreparedOperation,
  PreparedRuntimeOperation,
  RuntimeOperationManifest,
  RuntimeOperationStartInput,
  RuntimeCapabilities,
  RuntimeDetectResult,
  RuntimeDetectionAdvisory,
  RuntimeDetectionRefusalReason,
} from '../types';
export { isWireRuntimeId, observeRuntimeDetection, projectRuntimeObservation, taskRuntimeTarget, validateRuntimeDetectResult } from '../runtime-detection';
export type { RuntimeObservation } from '../runtime-detection';
export { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
export type {
  RuntimeDisposalFailureInput,
  RuntimeDisposalStage,
  RuntimeExecutionFailureInput,
  RuntimeFailureCategory,
  RuntimeFailurePhase,
  RuntimeRetryDisposition,
} from '../runtime-failure';

export { PiAdapter } from './pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig, PiBuiltinToolName, PiAgentExtensionName } from './pi/pi-adapter';
export { PI_PACKAGE_NAME } from './pi/resolve-bin';

export { ClaudeAdapter } from './claude/claude-adapter';
export type { ClaudeAdapterOptions } from './claude/claude-adapter';

export { CodexAdapter } from './codex/codex-adapter';
export type { CodexAdapterOptions, CodexSandboxSetting } from './codex/codex-adapter';

export { GrokAdapter } from './grok/grok-adapter';
export type { GrokAdapterOptions } from './grok/grok-adapter';
export { HermesAdapter } from './hermes/hermes-adapter';
export type { HermesAdapterOptions, HermesModelSelection, HermesByokLauncher } from './hermes/hermes-adapter';

export { NativeInteractionController, NativeInteractionError } from '../native-interactions';
export type {
  NativeApprovalDecision, NativeInteractionCapabilities, NativeInteractionIdentity,
  NativeQuestion, NativeQuestionAnswer, NativeInteractionInput, NativeInteractionRequest,
  NativeInteractionResponse, NativeInteractionReceipt, NativeInteractionEndReason,
  NativeInteractionChannel, NativeInteractionOptions, NativeInteractionHostOptions, NativeInteractionTransport, NativeInteractionErrorCode,
} from '../native-interactions';

export { buildRuntimeEnv } from '../daemon/environment';

export { createExecutionScratch, ScratchRootPathError } from '../daemon/retention/scratch';
export type { ExecutionScratch } from '../daemon/retention/scratch';
