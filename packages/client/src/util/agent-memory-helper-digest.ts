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

/**
 * pe-content-v1: PE32+ x64 only.
 * Hash the complete file except the CheckSum field, the certificate table
 * directory entry and the certificate table, which Authenticode signing
 * writes. A table must start on an 8-byte boundary after the headers and the
 * raw data of every section, and must end the file, so it cannot hide code.
 * The content is padded with zeros to 8 bytes, as a signer pads it.
 * This detects deployment errors. It does not establish signer trust.
 */
export function agentMemoryHelperPeDigest(bytes: Buffer): string {
  const fail = (): never => { throw new Error('Invalid Agent memory helper PE image'); };
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const coff = bytes.readUInt32LE(0x3c) + 4;
  if (coff + 20 > bytes.length || bytes.readUInt32LE(coff - 4) !== 0x4550) fail();
  const sections = bytes.readUInt16LE(coff + 2);
  const optional = coff + 20;
  const sectionTable = optional + bytes.readUInt16LE(coff + 16);
  if (bytes.readUInt16LE(coff) !== 0x8664 || sectionTable < optional + 152 || sectionTable + sections * 40 > bytes.length
    || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 5) fail();
  const headers = bytes.readUInt32LE(optional + 60);
  if (headers < sectionTable + sections * 40) fail();
  let dataEnd = headers;
  for (let index = 0; index < sections; index++) {
    const section = sectionTable + index * 40;
    dataEnd = Math.max(dataEnd, bytes.readUInt32LE(section + 20) + bytes.readUInt32LE(section + 16));
  }
  if (dataEnd > bytes.length) fail();
  const checksum = optional + 64;
  const certificates = optional + 144;
  const tableStart = bytes.readUInt32LE(certificates);
  const tableSize = bytes.readUInt32LE(certificates + 4);
  let contentEnd = bytes.length;
  if (tableStart !== 0 || tableSize !== 0) {
    if (tableStart % 8 !== 0 || tableStart < dataEnd || tableStart + tableSize !== bytes.length) fail();
    // Each WIN_CERTIFICATE fits in the table; entries are 8-byte aligned.
    for (let offset = tableStart; offset < bytes.length; offset += Math.ceil(bytes.readUInt32LE(offset) / 8) * 8) {
      if (offset + 8 > bytes.length || bytes.readUInt32LE(offset) < 8 || offset + bytes.readUInt32LE(offset) > bytes.length) fail();
    }
    contentEnd = tableStart;
  }
  return createHash('sha256').update('pe-content-v1\0').update(bytes.subarray(0, checksum))
    .update(bytes.subarray(checksum + 4, certificates)).update(bytes.subarray(certificates + 8, contentEnd))
    .update(Buffer.alloc((8 - contentEnd % 8) % 8)).digest('hex');
}

/** The pinned digest of one release target. The target, never the manifest, selects the algorithm. */
export function agentMemoryHelperTargetDigest(target: string, bytes: Buffer): string {
  if (target === 'win32-x64') return agentMemoryHelperPeDigest(bytes);
  if (target === 'darwin-arm64' || target === 'darwin-x64') return agentMemoryHelperDigest(bytes, target.slice(7));
  throw new Error('Unknown Agent memory helper target');
}
