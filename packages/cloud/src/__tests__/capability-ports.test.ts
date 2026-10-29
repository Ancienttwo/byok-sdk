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
  { capability: CLOUD_CAPABILITIES.blobsContentProxy, ports: { blobContentProxy: {} } },
  { capability: CLOUD_CAPABILITIES.truthRecords, ports: { truthCommitter: {}, truthObjectDownloads: {} } },
  { capability: CLOUD_CAPABILITIES.skillPacks, ports: { skillPacks: {} } },
  { capability: CLOUD_CAPABILITIES.agentMemoryProjection, ports: { agentMemoryProjectionAuthorizer: {}, agentMemoryProjectionStore: {} } },
  { capability: CLOUD_CAPABILITIES.e2eeMember, ports: { e2eeMemberStore: {} } },
] as unknown as readonly { readonly capability: string; readonly ports: CapabilityPorts }[];

function cloudWith(capabilities: CapabilityDeclaration, ports: CapabilityPorts) {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const objectBytes = createInMemoryBlobBytes(clock, crypto);
  const core = createInMemoryCoreStores({ clock, objectBytes }).stores;
  const { stores } = createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, objectBytes);
  return createByokCloud({
    mailboxWake: createInProcessMailboxWake(),
    core,
    cloud: stores,
    crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock),
    clock,
    capabilities,
    ...ports,
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
      const { ...ports } = allPorts as Record<string, unknown>;
      for (const name of Object.keys(row.ports)) delete ports[name];
      expect(() => cloudWith(all, ports as CapabilityPorts)).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
    });

    for (const name of Object.keys(row.ports)) {
      it(`refuses ${name} passed without declaring ${row.capability}, naming the port and the capability`, () => {
        const ports = { ...PORTS.filter((other) => other !== row).reduce((acc, other) => ({ ...acc, ...other.ports }), {}),
          [name]: {} } as CapabilityPorts;
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
        message: expect.stringMatching(/skillPacks \(skills\.pack\).*e2eeMemberStore \(e2ee\.member\)/),
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
});
