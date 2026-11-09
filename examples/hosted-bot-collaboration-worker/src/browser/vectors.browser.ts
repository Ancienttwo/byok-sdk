import { beforeAll, inject, it } from 'vitest';
import sealed from '../../../../packages/core/src/__tests__/golden/sealed-payload-v1.json';
import members from '../../../../packages/core/src/__tests__/golden/member-rules-v1.json';
import { checkSealedPayloadVectors, type SealedPayloadVectors } from '../../../../packages/core/src/__tests__/support/sealed-payload-vectors';
import { checkMemberRulesVectors, type MemberRulesVectors } from '../../../../packages/core/src/__tests__/support/member-rules-vectors';

declare module 'vitest' {
  export interface ProvidedContext { playwrightVersion: string }
}

beforeAll(() => {
  console.info(JSON.stringify({ layer: 'vectors', userAgent: navigator.userAgent, playwright: inject('playwrightVersion') }));
});

// The unchanged checkers throw on any vector mismatch, just as in the Bun leg.
it('sealed-payload-vectors', async () => {
  // SAFETY: the checked-in golden JSON is shared with the Node/Bun legs; JSON imports widen tuples and string literals.
  console.info(JSON.stringify({ suite: 'sealed-payload-vectors', counts: await checkSealedPayloadVectors(sealed as unknown as SealedPayloadVectors) }));
});

it('member-rules-vectors', async () => {
  // SAFETY: the checked-in golden JSON is shared with the Node/Bun legs; JSON imports widen tuples and string literals.
  console.info(JSON.stringify({ suite: 'member-rules-vectors', counts: await checkMemberRulesVectors(members as unknown as MemberRulesVectors) }));
});
