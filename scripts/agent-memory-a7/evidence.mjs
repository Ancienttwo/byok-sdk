import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

export const BEFORE = '04add5d414bbe6ed0301f1bded3c6a40cb76dfa0';
export const SCHEMA = 'byok.a7/v1';
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseJson(text, context) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`${context}: invalid JSON`, { cause }); }
}

// This file lives on the surviving Host. Receipt and ack timestamps are Host
// observations, not the guest's completion timestamp. Fsync precedes replies.
export class Recorder {
  constructor(file) {
    this.fd = openSync(file, 'wx', 0o600);
    this.sequence = 0;
    this.previous = null;
  }
  append(event) {
    const payload = { sequence: this.sequence++, at: new Date().toISOString(), previous: this.previous, event };
    const row = { ...payload, digest: digest(payload) };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    let written = 0;
    while (written < bytes.length) written += writeSync(this.fd, bytes, written);
    fsyncSync(this.fd);
    this.previous = row.digest;
    return row;
  }
  close() { closeSync(this.fd); }
}

export function readEvidence(file) {
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) throw new Error('truncated Host evidence');
  const rows = text.slice(0, -1).split('\n').map((line) => parseJson(line, 'Host evidence'));
  let previous = null;
  for (const [index, row] of rows.entries()) {
    const { digest: actual, ...payload } = row;
    if (row.sequence !== index || row.previous !== previous || actual !== digest(payload)
      || !Number.isFinite(Date.parse(row.at))) throw new Error(`invalid Host evidence row ${index}`);
    previous = actual;
  }
  return rows;
}

export function validateProfile(profile) {
  for (const field of ['id', 'osBuild', 'disk', 'virtualController', 'cacheMode', 'filesystem', 'hypervisor', 'hostStorage', 'cutMechanism']) {
    if (typeof profile?.[field] !== 'string' || profile[field].trim() === '') throw new Error(`storageProfile.${field} is required`);
  }
  if (typeof profile.dropsUnflushedWrites !== 'boolean') throw new Error('storageProfile.dropsUnflushedWrites is required');
  return profile;
}
