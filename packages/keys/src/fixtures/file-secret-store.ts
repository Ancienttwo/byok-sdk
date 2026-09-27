import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

import { assertSecretName, assertSecretNamespace } from '../secret-name';
import { assertSharedSecretValue, type SecretStore } from '../secret-store';

/**
 * Test-only SecretStore persisted to a JSON file, so a credential written by a
 * child process that is then SIGKILLed is still observable by the parent —
 * the property the crash tests need from a real OS credential store. Every
 * write is a whole-file atomic rename.
 */
export class FileSecretStore<TName extends string = string> implements SecretStore<TName> {
  readonly providerLabel = 'test file store';
  readonly #path: string;
  readonly #prefix: string;

  constructor(path: string, prefix = 'test') {
    this.#path = path;
    this.#prefix = prefix;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async delete(name: TName): Promise<boolean> {
    const entries = this.#read();
    const key = this.#key(name);
    const existed = Object.hasOwn(entries, key);
    delete entries[key];
    this.#write(entries);
    return existed;
  }

  async get(name: TName): Promise<string | undefined> {
    return this.#read()[this.#key(name)];
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new FileSecretStore<TName>(this.#path, `${this.#prefix}.scope.${assertSecretNamespace(namespace)}`);
  }

  async set(name: TName, secret: string): Promise<void> {
    assertSharedSecretValue(secret);
    const entries = this.#read();
    entries[this.#key(name)] = secret;
    this.#write(entries);
  }

  #key(name: TName): string {
    return `${this.#prefix}.${assertSecretName(name)}`;
  }

  #read(): Record<string, string> {
    return existsSync(this.#path) ? (JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, string>) : {};
  }

  #write(entries: Record<string, string>): void {
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(entries));
    renameSync(`${this.#path}.tmp`, this.#path);
  }
}
