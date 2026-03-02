import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  encrypt,
  decrypt,
  deriveKeyFromPassphrase,
  assertFilePermissions,
  assertDirectoryPermissions,
  PermissionError,
} from "@safeclaw/vault";
import type { EncryptedEntry } from "@safeclaw/vault";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Crypto validation (end-to-end, no mocks)", () => {
  const key = randomBytes(32);

  describe("encrypt/decrypt round-trip", () => {
    it("encrypts and decrypts back to original plaintext", () => {
      const plaintext = "sensitive data that must be protected";
      const entry = encrypt(plaintext, key);
      const result = decrypt(entry, key);
      expect(result).toBe(plaintext);
    });

    it("encrypts same plaintext twice and produces different ciphertext (unique IVs)", () => {
      const plaintext = "duplicate content";
      const entry1 = encrypt(plaintext, key);
      const entry2 = encrypt(plaintext, key);

      // IVs must differ
      expect(entry1.iv).not.toBe(entry2.iv);
      // Ciphertext must differ due to different IVs
      expect(entry1.ciphertext).not.toBe(entry2.ciphertext);
      // But both must decrypt to the same plaintext
      expect(decrypt(entry1, key)).toBe(plaintext);
      expect(decrypt(entry2, key)).toBe(plaintext);
    });
  });

  describe("tamper detection (GCM authentication)", () => {
    it("decrypt with wrong key fails", () => {
      const entry = encrypt("secret", key);
      const wrongKey = randomBytes(32);
      expect(() => decrypt(entry, wrongKey)).toThrow();
    });

    it("decrypt with tampered ciphertext fails", () => {
      const entry = encrypt("secret", key);
      const tampered = Buffer.from(entry.ciphertext, "base64");
      tampered[0] = tampered[0]! ^ 0xff;
      const tamperedEntry: EncryptedEntry = {
        ...entry,
        ciphertext: tampered.toString("base64"),
      };
      expect(() => decrypt(tamperedEntry, key)).toThrow();
    });

    it("decrypt with tampered auth tag fails", () => {
      const entry = encrypt("secret", key);
      const tampered = Buffer.from(entry.authTag, "base64");
      tampered[0] = tampered[0]! ^ 0xff;
      const tamperedEntry: EncryptedEntry = {
        ...entry,
        authTag: tampered.toString("base64"),
      };
      expect(() => decrypt(tamperedEntry, key)).toThrow();
    });

    it("decrypt with tampered IV fails", () => {
      const entry = encrypt("secret", key);
      const tampered = Buffer.from(entry.iv, "base64");
      tampered[0] = tampered[0]! ^ 0xff;
      const tamperedEntry: EncryptedEntry = {
        ...entry,
        iv: tampered.toString("base64"),
      };
      expect(() => decrypt(tamperedEntry, key)).toThrow();
    });
  });

  describe("key derivation", () => {
    it("same passphrase + same salt = same key", async () => {
      const salt = randomBytes(16);
      const key1 = await deriveKeyFromPassphrase("my-passphrase", salt);
      const key2 = await deriveKeyFromPassphrase("my-passphrase", salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it("same passphrase + different salt = different key", async () => {
      const salt1 = randomBytes(16);
      const salt2 = randomBytes(16);
      const key1 = await deriveKeyFromPassphrase("my-passphrase", salt1);
      const key2 = await deriveKeyFromPassphrase("my-passphrase", salt2);
      expect(key1.equals(key2)).toBe(false);
    });

    it("different passphrase + same salt = different key", async () => {
      const salt = randomBytes(16);
      const key1 = await deriveKeyFromPassphrase("passphrase-one", salt);
      const key2 = await deriveKeyFromPassphrase("passphrase-two", salt);
      expect(key1.equals(key2)).toBe(false);
    });
  });
});

describe("Vault file permission enforcement (real filesystem)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "safeclaw-perm-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("assertFilePermissions", () => {
    it("rejects file with mode 0o644 (world-readable)", () => {
      const filePath = join(tmpDir, "bad-perms-644.txt");
      writeFileSync(filePath, "secret data");
      chmodSync(filePath, 0o644);

      expect(() => assertFilePermissions(filePath)).toThrow(PermissionError);
    });

    it("rejects file with mode 0o666 (world-writable)", () => {
      const filePath = join(tmpDir, "bad-perms-666.txt");
      writeFileSync(filePath, "secret data");
      chmodSync(filePath, 0o666);

      expect(() => assertFilePermissions(filePath)).toThrow(PermissionError);
    });

    it("accepts file with mode 0o600 (owner-only)", () => {
      const filePath = join(tmpDir, "good-perms-600.txt");
      writeFileSync(filePath, "secret data");
      chmodSync(filePath, 0o600);

      expect(() => assertFilePermissions(filePath)).not.toThrow();
    });
  });

  describe("assertDirectoryPermissions", () => {
    it("rejects directory with mode 0o755 (world-accessible)", () => {
      const dirPath = join(tmpDir, "bad-dir-755");
      mkdirSync(dirPath);
      chmodSync(dirPath, 0o755);

      expect(() => assertDirectoryPermissions(dirPath)).toThrow(
        PermissionError,
      );
    });

    it("rejects directory with mode 0o777 (world-writable)", () => {
      const dirPath = join(tmpDir, "bad-dir-777");
      mkdirSync(dirPath);
      chmodSync(dirPath, 0o777);

      expect(() => assertDirectoryPermissions(dirPath)).toThrow(
        PermissionError,
      );
    });

    it("accepts directory with mode 0o700 (owner-only)", () => {
      const dirPath = join(tmpDir, "good-dir-700");
      mkdirSync(dirPath);
      chmodSync(dirPath, 0o700);

      expect(() => assertDirectoryPermissions(dirPath)).not.toThrow();
    });
  });
});
