/** A single encrypted entry stored on disk */
export interface EncryptedEntry {
  /** Base64-encoded AES-256-GCM ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (unique per encryption) */
  iv: string;
  /** Base64-encoded 16-byte auth tag */
  authTag: string;
}

/** The on-disk vault file format */
export interface VaultFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

/** How the master key was obtained */
export type KeySource = "keyring" | "passphrase";

/** Result of unlocking the vault */
export interface UnlockResult {
  key: Buffer;
  source: KeySource;
}

/** Options for vault initialization */
export interface VaultOptions {
  /** Path to the vault file on disk */
  path: string;
  /** Application name for keyring storage */
  appName?: string;
}
