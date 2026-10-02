import { parseAttestedOfficialExternalCli, parseDescendantLaunch, type AttestedOfficialExternalCliV2, type PiDescendantLaunchV2 } from '@byok-sdk/implementation-identity';
import { loadCustodyLaunchRecord, BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV } from './custody-commitments';
import { parseRuntimeDescendantPlan, type RuntimeDescendantPlanV2 } from '../adapters/pi/runtime-descendant-plan';
import type { RuntimeEntryV1, ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';

const KEY = 'byok.custody.externalInstallations';
let rootInstallations: readonly AttestedOfficialExternalCliV2[] = Object.freeze([]);
let verifiedRunner: PiDescendantLaunchV2 | undefined;
let rootPlan: RuntimeDescendantPlanV2 | undefined;
export const CUSTODY_ROOT_PLAN_METADATA_KEY = 'byok.custody.rootPlan';
/** Called only by the digest-bound SDK runtime host after verifying its own binding. */
export function configureCustodyExternalInstallations(values: readonly AttestedOfficialExternalCliV2[]): void {
  rootInstallations = validateCustodyExternalInstallations(values);
  verifiedRunner = undefined;
  rootPlan = undefined;
}
/** The runtime host has already verified its own binding and this exact plan. */
export function configureCustodyRuntimePlan(plan: RuntimeDescendantPlanV2 | null): void {
  configureCustodyExternalInstallations(plan?.externalCliInstallations ?? []);
  rootPlan = plan ?? undefined;
}
export function custodyRuntimePlan(env = process.env): RuntimeDescendantPlanV2 | undefined {
  if (!env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]) return rootPlan;
  const parent = parseDescendantLaunch(loadCustodyLaunchRecord(env));
  const raw = parent.perLaunch.mcp.metadata[CUSTODY_ROOT_PLAN_METADATA_KEY];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('custody_root_plan_invalid');
  const value = raw as Record<string,unknown>;
  const rows = value.templates;
  if (!Array.isArray(rows)) throw new Error('custody_root_plan_invalid');
  const self = rows.find(row => row?.kind === value.selfKind);
  if (!self) throw new Error('custody_root_plan_invalid');
  const plan = parseRuntimeDescendantPlan(raw,value.selfKind as RuntimeEntryV1,self.template as ImplementationSpawnBindingV1);
  if (!plan || JSON.stringify(plan.policy) !== JSON.stringify(parent.policy)
    || !plan.templates.some(row => row.kind === parent.perLaunch.templateKind && JSON.stringify(row.template) === JSON.stringify(parent.template))) throw new Error('custody_root_plan_parent_mismatch');
  return plan;
}
/** SDK entry calls this only AFTER independent parent/physical validation, before payload load.
 * This process-local proof cannot be supplied by a config/env "verified" flag. */
export function activateVerifiedCustodyRunner(launch: PiDescendantLaunchV2): void {
  activateVerifiedCustodyParent(launch);
}
export function activateVerifiedCustodyParent(launch: PiDescendantLaunchV2): void {
  const parsed = parseDescendantLaunch(launch);
  if (parsed.perLaunch.templateKind !== 'pi-subagent-runner' && parsed.perLaunch.templateKind !== 'pi-subagent-print') throw new Error('custody_verified_parent_required');
  verifiedRunner = parsed;
}
export function verifiedCustodyParent(): PiDescendantLaunchV2 | undefined { return verifiedRunner; }
export function verifiedCustodyRunner(): PiDescendantLaunchV2 | undefined { return verifiedRunner?.perLaunch.templateKind === 'pi-subagent-runner' ? verifiedRunner : undefined; }
export function validateCustodyExternalInstallations(values: unknown): readonly AttestedOfficialExternalCliV2[] {
  if (!Array.isArray(values)) throw new Error('external_cli_installations_invalid');
  const parsed = values.map(parseAttestedOfficialExternalCli);
  if (parsed.some(v => !v) || new Set(parsed.map(v => v!.adapter)).size !== parsed.length) throw new Error('external_cli_installations_invalid');
  return Object.freeze(parsed as AttestedOfficialExternalCliV2[]);
}
export function custodyExternalInstallations(env = process.env): readonly AttestedOfficialExternalCliV2[] {
  if (!env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]) return rootInstallations;
  const parent = parseDescendantLaunch(loadCustodyLaunchRecord(env));
  return validateCustodyExternalInstallations(parent.perLaunch.mcp.metadata[KEY] ?? []);
}
export const EXTERNAL_INSTALLATIONS_METADATA_KEY = KEY;
