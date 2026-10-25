import { initializeInputPreparation, runInputPreparation, initializeOwnedHostedStorage, provenAgentMemoryIntentBackend } from './services';
import { memberClient, startDeviceMember } from './member';
import { checkServerUrl, pair, pairUnderLease, unpair, unpairUnderLease } from './pairing';
import { runLifecycleMutation, replaceControlServer, setLifecycle, halted, crashed, start, startupHaltReason, startUnderLease, stop, requestShutdown } from './lifecycle';
import { runStartUnderLease } from './start';
import { taskContextCapabilityAvailable, applyCapabilityDeclaration, setHelloCapability, startPresenceProducer, waitForHostTaskContext, runPresenceDiscovery } from './presence';
import { runShutdownSequence, performControlShutdown } from './shutdown';
import { approve, reject, subscribe, tasks, reloadMcpToolsets, reportMcpToolsetObservation } from './operations';
import { buildStorageStatus, buildControlStatus, agentHomeExecutionStatus, outboundStatus, status } from './status';
import { dispatchReliableRecord, publishReliableAgentEgress } from './egress';
import type { DaemonScope } from './scope';

const daemonFunctions = {
  initializeInputPreparation, runInputPreparation, initializeOwnedHostedStorage,
  provenAgentMemoryIntentBackend, memberClient, startDeviceMember, checkServerUrl, pair,
  pairUnderLease, unpair, unpairUnderLease, runLifecycleMutation, replaceControlServer, setLifecycle,
  halted, crashed, start, startupHaltReason, startUnderLease, stop, requestShutdown,
  runStartUnderLease, taskContextCapabilityAvailable, applyCapabilityDeclaration, setHelloCapability,
  startPresenceProducer, waitForHostTaskContext, runPresenceDiscovery, runShutdownSequence,
  performControlShutdown, approve, reject, subscribe, tasks, reloadMcpToolsets,
  reportMcpToolsetObservation, buildStorageStatus, buildControlStatus, agentHomeExecutionStatus,
  outboundStatus, status, dispatchReliableRecord, publishReliableAgentEgress,
};

type Bound<F> = F extends (daemonScope: DaemonScope, ...args: infer A) => infer R ? (...args: A) => R : never;

/** Every daemon function, bound to one {@link DaemonScope}. */
export type DaemonFunctions = {
  readonly [K in Exclude<keyof typeof daemonFunctions, 'runLifecycleMutation'>]: Bound<(typeof daemonFunctions)[K]>;
} & {
  // Generic: a conditional type would erase its type parameter.
  readonly runLifecycleMutation: <T>(operation: () => Promise<T>) => Promise<T>;
};

/**
 * Binds each daemon function to the scope once, so a function keeps one
 * identity for the daemon's lifetime and its callers' code is unchanged (#926).
 */
export function bindDaemonFunctions(scope: () => DaemonScope): DaemonFunctions {
  return {
    initializeInputPreparation: (...args) => initializeInputPreparation(scope(), ...args),
    runInputPreparation: (...args) => runInputPreparation(scope(), ...args),
    initializeOwnedHostedStorage: (...args) => initializeOwnedHostedStorage(scope(), ...args),
    provenAgentMemoryIntentBackend: (...args) => provenAgentMemoryIntentBackend(scope(), ...args),
    memberClient: (...args) => memberClient(scope(), ...args),
    startDeviceMember: (...args) => startDeviceMember(scope(), ...args),
    checkServerUrl: (...args) => checkServerUrl(scope(), ...args),
    pair: (...args) => pair(scope(), ...args),
    pairUnderLease: (...args) => pairUnderLease(scope(), ...args),
    unpair: (...args) => unpair(scope(), ...args),
    unpairUnderLease: (...args) => unpairUnderLease(scope(), ...args),
    runLifecycleMutation: operation => runLifecycleMutation(scope(), operation),
    replaceControlServer: (...args) => replaceControlServer(scope(), ...args),
    setLifecycle: (...args) => setLifecycle(scope(), ...args),
    halted: (...args) => halted(scope(), ...args),
    crashed: (...args) => crashed(scope(), ...args),
    start: (...args) => start(scope(), ...args),
    startupHaltReason: (...args) => startupHaltReason(scope(), ...args),
    startUnderLease: (...args) => startUnderLease(scope(), ...args),
    stop: (...args) => stop(scope(), ...args),
    requestShutdown: (...args) => requestShutdown(scope(), ...args),
    runStartUnderLease: (...args) => runStartUnderLease(scope(), ...args),
    taskContextCapabilityAvailable: (...args) => taskContextCapabilityAvailable(scope(), ...args),
    applyCapabilityDeclaration: (...args) => applyCapabilityDeclaration(scope(), ...args),
    setHelloCapability: (...args) => setHelloCapability(scope(), ...args),
    startPresenceProducer: (...args) => startPresenceProducer(scope(), ...args),
    waitForHostTaskContext: (...args) => waitForHostTaskContext(scope(), ...args),
    runPresenceDiscovery: (...args) => runPresenceDiscovery(scope(), ...args),
    runShutdownSequence: (...args) => runShutdownSequence(scope(), ...args),
    performControlShutdown: (...args) => performControlShutdown(scope(), ...args),
    approve: (...args) => approve(scope(), ...args),
    reject: (...args) => reject(scope(), ...args),
    subscribe: (...args) => subscribe(scope(), ...args),
    tasks: (...args) => tasks(scope(), ...args),
    reloadMcpToolsets: (...args) => reloadMcpToolsets(scope(), ...args),
    reportMcpToolsetObservation: (...args) => reportMcpToolsetObservation(scope(), ...args),
    buildStorageStatus: (...args) => buildStorageStatus(scope(), ...args),
    buildControlStatus: (...args) => buildControlStatus(scope(), ...args),
    agentHomeExecutionStatus: (...args) => agentHomeExecutionStatus(scope(), ...args),
    outboundStatus: (...args) => outboundStatus(scope(), ...args),
    status: (...args) => status(scope(), ...args),
    dispatchReliableRecord: (...args) => dispatchReliableRecord(scope(), ...args),
    publishReliableAgentEgress: (...args) => publishReliableAgentEgress(scope(), ...args),
  };
}
