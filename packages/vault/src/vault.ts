import { readFileSync, writeFileSync } from "node:fs";
import { assertFilePermissions } from "./permissions.js";
import { encrypt, decrypt } from "./crypto.js";
import type { EncryptedEntry, VaultFile } from "./types.js";

/**
 * Encrypted secrets vault. Stores entries encrypted at rest with AES-256-GCM.
 */
export class Vault {
  private readonly filePath: string;
  private readonly key: Buffer;
  private entries: Record<string, EncryptedEntry>;

  private constructor(
    filePath: string,
    key: Buffer,
    entries: Record<string, EncryptedEntry>,
  ) {
    this.filePath = filePath;
    this.key = key;
    this.entries = entries;
  }

  /**
   * Create a new empty vault file at the given path.
   * The file is written with mode 0o600.
   */
  static create(path: string, key: Buffer): Vault {
    const data: VaultFile = { version: 1, entries: {} };
    writeFileSync(path, JSON.stringify(data), { mode: 0o600, encoding: "utf8" });
    return new Vault(path, key, {});
  }

  /**
   * Open an existing vault file. Checks file permissions before reading.
   */
  static open(path: string, key: Buffer): Vault {
    assertFilePermissions(path);
    const raw = readFileSync(path, { encoding: "utf8" });
    const data = JSON.parse(raw) as VaultFile;
    return new Vault(path, key, data.entries);
  }

  /**
   * Encrypt and store a secret.
   */
  set(name: string, value: string): void {
    this.entries[name] = encrypt(value, this.key);
  }

  /**
   * Decrypt and return a secret, or undefined if not found.
   */
  get(name: string): string | undefined {
    const entry = this.entries[name];
    if (!entry) {
      return undefined;
    }
    return decrypt(entry, this.key);
  }

  /**
   * Delete a secret. Returns true if it existed, false otherwise.
   */
  delete(name: string): boolean {
    if (!(name in this.entries)) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.entries[name];
    return true;
  }

  /**
   * List all secret names.
   */
  keys(): string[] {
    return Object.keys(this.entries);
  }

  /**
   * Persist the vault to disk with mode 0o600.
   */
  save(): void {
    const data: VaultFile = { version: 1, entries: this.entries };
    writeFileSync(this.filePath, JSON.stringify(data), {
      mode: 0o600,
      encoding: "utf8",
    });
  }
}
