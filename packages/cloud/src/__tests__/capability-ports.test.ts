import { createInMemoryCoreStores, createMutableClock, type CapabilityDeclaration } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { CLOUD_CAPABILITIES, capabilityDeclarationForPorts, fullCapabilityDeclaration, type CapabilityPorts } from '../capabilities';
import { createByokCloud } from '../cloud';
import { createWebCrypto } from '../crypto/web-crypto';
import { createInMemoryBlobBytes } from '../stores/in-memory/blobs';
import { createInMemoryCloudStores } from '../stores/in-memory/index';
import { createInProcessMailboxWake } from '../stores/in-memory/mailbox-wake';

/** Every capability port, each with the capability it is bound to. Presence is all the check reads. */
const PORTS = [
  { capability: CLOUD_CAPABILITIES.blobsContentProxy, names: ['blobContentProxy'] },
  { capability: CLOUD_CAPABILITIES.truthRecords, names: ['truthCommitter', 'truthObjectDownloads'] },
  { capability: CLOUD_CAPABILITIES.skillPacks, names: ['skillPacks'] },
  { capability: CLOUD_CAPABILITIES.agentMemoryProjection, names: ['agentMemoryProjectionAuthorizer', 'agentMemoryProjectionStore'] },
  // A store of the composition, so it travels in `cloud` (#2267).
  { capability: CLOUD_CAPABILITIES.e2eeMember, names: ['cloud.e2eeMember'] },
].map((row) => ({ ...row, ports: supply(row.names) }));

/** Placeholder ports for `names`, where `cloud.e2eeMember` goes into the `cloud` stores. */
function supply(names: readonly string[]): CapabilityPorts {
  return Object.fromEntries(names.map((name) => (name === 'cloud.e2eeMember' ? ['cloud', { e2eeMember: {} }] : [name, {}]))) as CapabilityPorts;
}

function cloudWith(capabilities: CapabilityDeclaration, ports: CapabilityPorts) {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const objectBytes = createInMemoryBlobBytes(clock, crypto);
  const core = createInMemoryCoreStores({ clock, objectBytes }).stores;
  const composition = createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, core.presence, objectBytes);
  const { stores } = composition;
  return createByokCloud({
    proofReceiptRetention: { authority: composition.proofReceiptAuthority },
    mailboxWake: createInProcessMailboxWake(),
    core,
    crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock),
    clock,
    capabilities,
    ...ports,
    cloud: { ...stores, ...ports.cloud },
  });
}

const without = (declaration: CapabilityDeclaration, capability: string): CapabilityDeclaration => ({
  ...declaration,
  capabilities: declaration.capabilities.filter((name) => name !== capability && !name.startsWith(`${capability}.`)),
});
const all = fullCapabilityDeclaration(1, {
  includeTruthRecords: true, includeSkillPacks: true, includeAgentMemoryProjection: true, includeE2eeMember: true,
});
const allPorts = Object.assign({}, ...PORTS.map((row) => row.ports)) as CapabilityPorts;

describe('capability declaration ⇄ ports, both directions (#1096)', () => {
  it('constructs when every port-bound capability is declared with its ports, or neither is present', () => {
    expect(() => cloudWith(all, allPorts)).not.toThrow();
    expect(() => cloudWith(PORTS.reduce((declaration, row) => without(declaration, row.capability), all), {})).not.toThrow();
  });

  for (const row of PORTS) {
    it(`refuses ${row.capability} declared without its ports`, () => {
      const ports = supply(PORTS.flatMap((other) => other.names).filter((name) => !row.names.includes(name)));
      expect(() => cloudWith(all, ports)).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
    });

    for (const name of row.names) {
      it(`refuses ${name} passed without declaring ${row.capability}, naming the port and the capability`, () => {
        const ports = supply([...PORTS.filter((other) => other !== row).flatMap((other) => other.names), name]);
        expect(() => cloudWith(without(all, row.capability), ports)).toThrowError(expect.objectContaining({
          code: 'capability_port_undeclared',
          message: expect.stringContaining(`${name} (${row.capability})`),
        }));
      });
    }
  }

  it('lists every extra port in one error', () => {
    expect(() => cloudWith(without(without(all, CLOUD_CAPABILITIES.skillPacks), CLOUD_CAPABILITIES.e2eeMember), allPorts))
      .toThrowError(expect.objectContaining({
        code: 'capability_port_undeclared',
        message: expect.stringMatching(/skillPacks \(skills\.pack\).*cloud\.e2eeMember \(e2ee\.member\)/),
      }));
  });

  it('derives a declaration that names exactly the capabilities whose ports are all present', () => {
    expect(capabilityDeclarationForPorts(allPorts)).toEqual(all);
    const none = capabilityDeclarationForPorts({});
    for (const row of PORTS) expect(none.capabilities).not.toContain(row.capability);
    expect(none.capabilities).not.toContain(CLOUD_CAPABILITIES.e2eeMemberKemEpoch);
    expect(none.capabilities).not.toContain(CLOUD_CAPABILITIES.hostMcpTaskContext);
    // A half-supplied pair backs nothing, so the construction check names the half that was passed.
    const half = { truthCommitter: {} } as CapabilityPorts;
    expect(capabilityDeclarationForPorts(half).capabilities).not.toContain(CLOUD_CAPABILITIES.truthRecords);
    expect(() => cloudWith(capabilityDeclarationForPorts(half), half))
      .toThrowError(expect.objectContaining({ code: 'capability_port_undeclared', message: expect.stringContaining('truthCommitter (truth.records)') }));
    for (const row of PORTS) {
      expect(() => cloudWith(capabilityDeclarationForPorts(row.ports), row.ports)).not.toThrow();
      expect(capabilityDeclarationForPorts(row.ports).capabilities).toContain(row.capability);
    }
  });

  it('derives host-mcp-task-context only when includeHostMcpTaskContext is explicitly true', () => {
    expect(capabilityDeclarationForPorts({}, 1, { includeHostMcpTaskContext: false }).capabilities)
      .not.toContain(CLOUD_CAPABILITIES.hostMcpTaskContext);
    const enabled = capabilityDeclarationForPorts({}, 1, { includeHostMcpTaskContext: true });
    expect(enabled.capabilities).toContain(CLOUD_CAPABILITIES.hostMcpTaskContext);
    expect(() => cloudWith(enabled, {})).not.toThrow();
  });
});
