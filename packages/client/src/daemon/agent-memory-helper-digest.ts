import { createHash } from 'node:crypto';

/**
 * mach-o-content-v1: thin, little-endian Mach-O 64 only.
 * Hash the complete file except the LC_CODE_SIGNATURE blob. Canonicalize the
 * signature command and __LINKEDIT sizes, which codesign changes. Bind every
 * other header, load command, segment and data byte. Reject unaccounted tails.
 * This detects deployment errors. It does not establish signer trust.
 */
export function agentMemoryHelperDigest(bytes: Buffer, arch: string): string {
  const fail = (): never => { throw new Error('Invalid Agent memory helper Mach-O image'); };
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) fail();
  const cpu = bytes.readUInt32LE(4);
  if (cpu !== (arch === 'arm64' ? 0x100000c : arch === 'x64' ? 0x1000007 : -1)) fail();
  const count = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (count > 4096 || commandBytes > bytes.length - 32) fail();
  const header = Buffer.from(bytes.subarray(0, 32));
  const commands: Buffer[] = [];
  let offset = 32;
  let signatureStart = bytes.length;
  let signatureSize = 0;
  let linkedit: Buffer | undefined;
  let linkeditStart = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > 32 + commandBytes) fail();
    const kind = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > 32 + commandBytes) fail();
    const command = Buffer.from(bytes.subarray(offset, offset + size));
    if (kind === 0x1d) {
      if (size !== 16 || signatureSize !== 0) fail();
      signatureStart = command.readUInt32LE(8);
      signatureSize = command.readUInt32LE(12);
      if (signatureSize === 0 || signatureStart < 32 + commandBytes || signatureStart + signatureSize !== bytes.length) fail();
    } else {
      if (kind === 0x19) {
        if (size < 72) fail();
        const start = Number(command.readBigUInt64LE(40));
        const length = Number(command.readBigUInt64LE(48));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > bytes.length) fail();
        if (command.subarray(8, 24).toString('ascii').replace(/\0.*$/u, '') === '__LINKEDIT') {
          if (linkedit !== undefined) fail();
          linkedit = command;
          linkeditStart = start;
        }
      }
      commands.push(command);
    }
    offset += size;
  }
  if (offset !== 32 + commandBytes || linkedit === undefined || linkeditStart > signatureStart) fail();
  // amd64 Go output has a zero-filled reserved load-command slot. codesign
  // consumes that slot. Require the exact zeros rather than skip data.
  const bodyStart = 32 + commandBytes + (signatureSize === 0 ? 16 : 0);
  if (signatureSize === 0 && (bodyStart > bytes.length || bytes.subarray(32 + commandBytes, bodyStart).some(byte => byte !== 0))) fail();
  if (signatureStart % 16 !== 0) fail();
  const originalLinkeditSize = Number(linkedit!.readBigUInt64LE(48));
  const originalLinkeditVMSize = Number(linkedit!.readBigUInt64LE(32));
  // Go uses the byte size. Apple codesign may round to a 4 or 16 KiB page.
  if (linkeditStart + originalLinkeditSize !== bytes.length
    || ![originalLinkeditSize, Math.ceil(originalLinkeditSize / 4096) * 4096,
      Math.ceil(originalLinkeditSize / 16384) * 16384].includes(originalLinkeditVMSize)) fail();
  linkedit!.writeBigUInt64LE(BigInt(signatureStart - linkeditStart), 32);
  linkedit!.writeBigUInt64LE(BigInt(signatureStart - linkeditStart), 48);
  header.writeUInt32LE(count - (signatureSize === 0 ? 0 : 1), 16);
  header.writeUInt32LE(commandBytes - (signatureSize === 0 ? 0 : 16), 20);
  return createHash('sha256').update('mach-o-content-v1\0').update(header)
    .update(Buffer.concat(commands)).update(bytes.subarray(bodyStart, signatureStart)).digest('hex');
}
