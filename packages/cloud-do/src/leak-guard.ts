import { CloudDoError } from './errors';

const FRAGMENT_LENGTH = 16;

function percentPattern(secret: string): RegExp {
  return new RegExp(Array.from(secret, character => {
    const literal = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hex = character.charCodeAt(0).toString(16).padStart(2, '0')
      .replace(/[a-f]/g, digit => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${literal}|%${hex})`;
  }).join(''));
}

function addEncodedForms(forms: Set<string>, secret: string): void {
  forms.add(secret);
  const encoded = btoa(secret);
  forms.add(encoded);
  forms.add(encoded.replace(/=+$/, ''));
  forms.add(encoded.replace(/\+/g, '-').replace(/\//g, '_'));
  forms.add(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  for (let offset = 0; offset < 3; offset++) {
    // Only six-bit characters wholly inside the secret are independent of the
    // unknown surrounding bytes. Drop both boundary characters if necessary.
    const interior = btoa('\0'.repeat(offset) + secret).slice(
      Math.ceil(8 * offset / 6), Math.floor(8 * (offset + secret.length) / 6),
    );
    forms.add(interior);
    forms.add(interior.replace(/\+/g, '-').replace(/\//g, '_'));
  }
}

/** Scans decoded model text, before any of it reaches pi or persistence. */
export class RollingLeakGuard {
  readonly tailLength: number;
  private readonly forms: readonly string[];
  private readonly percentForms: readonly RegExp[];
  private pending = '';
  private closed = false;

  constructor(key: string) {
    // The credential boundary validates visible ASCII token characters and
    // 16 <= K <= 512 before constructing a guard. The largest matching form is
    // the all-percent-encoded full key (3K). Base64, including alignment, is at
    // most 4*ceil((K+2)/3), which is <= 3K for K >= 16. Fragments are shorter.
    // Thus L=3K and tail=L-1 <= 1535 characters, with O(K) candidates.
    this.tailLength = 3 * key.length - 1;
    const secrets = new Set([key]);
    const sensitive = key.replace(/^(?:sk-(?:ant-|proj-)?|zai[-_])/, '');
    for (let start = 0; start <= sensitive.length - FRAGMENT_LENGTH; start++) {
      // Every longer sensitive fragment contains one of these exact windows.
      secrets.add(sensitive.slice(start, start + FRAGMENT_LENGTH));
    }
    const forms = new Set<string>();
    const percentForms: RegExp[] = [];
    for (const secret of secrets) {
      addEncodedForms(forms, secret);
      percentForms.push(percentPattern(secret));
    }
    this.forms = [...forms];
    this.percentForms = percentForms;
  }

  push(text: string): string {
    if (this.closed) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
    const combined = this.pending + text;
    this.scan(combined);
    // Any future-completed form has length <= L. Its unfinished prefix has
    // length <= L-1 and must remain here, never inside the released prefix.
    const releaseLength = Math.max(0, combined.length - this.tailLength);
    this.pending = combined.slice(releaseLength);
    return combined.slice(0, releaseLength);
  }

  finish(): string {
    if (this.closed) throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
    this.scan(this.pending);
    const safe = this.pending;
    this.discard();
    return safe;
  }

  discard(): void {
    this.pending = '';
    this.closed = true;
  }

  private scan(text: string): void {
    if (this.forms.some(form => text.includes(form))
        || this.percentForms.some(pattern => pattern.test(text))) {
      this.discard();
      throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
    }
  }
}
