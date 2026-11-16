/**
 * `@byok-sdk/core/sealed-payload` — sealed payload v1 (#654): sealed contents,
 * scope keys and key packages, and member chain entries. The browser, the
 * device and the hosted Host run this same WebCrypto code.
 *
 * It is a subpath, not part of the package root, so the root bundle and every
 * closure that imports the root do not grow. Only a consumer that seals or
 * opens content imports it.
 */
export {
  SEALED_CATEGORIES,
  SEALED_CONTENT_SUITE,
  SEALED_CONTENT_VERSION,
  SealedContentHeaderV1Schema,
  openSealedContent,
  sealContent,
} from './sealed-content.js';
export type {
  SealedBinding,
  SealedCategory,
  SealedContent,
  SealedContentHeaderV1,
  SealedContentOpenFailure,
} from './sealed-content.js';
export { deriveScopeKeyId, generateScopeKey, openScopeKeyPackage, sealScopeKeyPackage } from './scope-key.js';
export type {
  ScopeKeyPackage,
  ScopeKeyPackageOpenResult,
} from './scope-key.js';
export {
  MEMBER_CHAIN_OPS,
  deriveMemberId,
  memberChainEntryHash,
  signMemberChainEntry,
  verifyMemberChainEntry,
} from './member-chain.js';
export type {
  MemberChainEntryV1,
  MemberChainOp,
  UnsignedMemberChainEntryV1,
} from './member-chain.js';
export {
  createMemberKeyBundle,
  parseMemberKeyBundle,
  verifyMemberKem,
} from './member-bundle.js';
export type {
  MemberKeyBundleV1,
} from './member-bundle.js';
export {
  beginMemberKemRotation,
  finishMemberKemRotation,
  generateMemberKeyRecord,
  openMemberKeyRecord,
} from './member-key-record.js';
export type { MemberKemKey, MemberKeyBinding, MemberKeyStore, MemberKeys } from './member-key-record.js';
export {
  memberApprovalCode,
} from './member-fingerprint.js';

export {
  computeClientPairingMac,
  computeDevicePairingMac,
  decodePairingVerificationSecret,
  encodePairingVerificationSecret,
  formatPairingInput,
  generatePairingVerificationSecret,
  parsePairingInput,
  verifyClientPairingMac,
  verifyDevicePairingMac,
} from './pairing-verification.js';

export { applyMemberChainEntries, emptyMemberChainState, memberChainScopeRecipients, verifyMemberChainFromAnchor } from './member-chain-walk.js';
export type {
  MemberChainScope,
  MemberChainState,
} from './member-chain-walk.js';
