import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import type { EncryptedEntry } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_KEYLEN = 32;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DEFAULT_SALT_LENGTH = 16;

/**
 * Encrypts plaintext using AES-256-GCM with a random 12-byte IV.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypts an EncryptedEntry using AES-256-GCM.
 * Throws on tampered data or wrong key.
 */
export function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, "base64");
  const ciphertext = Buffer.from(entry.ciphertext, "base64");
  const authTag = Buffer.from(entry.authTag, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Derives a 32-byte key from a passphrase using scrypt.
 * If no salt is provided, a random 16-byte salt is generated.
 */
export function deriveKeyFromPassphrase(
  passphrase: string,
  salt?: Buffer,
): Promise<Buffer> {
  const effectiveSalt = salt ?? randomBytes(DEFAULT_SALT_LENGTH);
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      effectiveSalt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      },
    );
  });
}
