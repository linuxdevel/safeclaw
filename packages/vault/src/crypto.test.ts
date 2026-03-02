import { describe, it, expect } from "vitest";
import { encrypt, decrypt, deriveKeyFromPassphrase } from "./crypto.js";
import { randomBytes } from "node:crypto";

describe("encrypt/decrypt", () => {
  const key = randomBytes(32);

  it("roundtrips a simple string", () => {
    const plaintext = "hello world";
    const entry = encrypt(plaintext, key);
    const result = decrypt(entry, key);
    expect(result).toBe(plaintext);
  });

  it("produces unique IV per encryption", () => {
    const plaintext = "same content";
    const entry1 = encrypt(plaintext, key);
    const entry2 = encrypt(plaintext, key);
    expect(entry1.iv).not.toBe(entry2.iv);
    expect(entry1.ciphertext).not.toBe(entry2.ciphertext);
  });

  it("throws with wrong key", () => {
    const entry = encrypt("secret", key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(entry, wrongKey)).toThrow();
  });

  it("throws with tampered ciphertext", () => {
    const entry = encrypt("secret", key);
    const tampered = Buffer.from(entry.ciphertext, "base64");
    tampered[0] = tampered[0]! ^ 0xff;
    const tamperedEntry = {
      ...entry,
      ciphertext: tampered.toString("base64"),
    };
    expect(() => decrypt(tamperedEntry, key)).toThrow();
  });

  it("roundtrips an empty string", () => {
    const entry = encrypt("", key);
    const result = decrypt(entry, key);
    expect(result).toBe("");
  });

  it("roundtrips unicode content", () => {
    const plaintext = "こんにちは世界 🌍 Ñoño";
    const entry = encrypt(plaintext, key);
    const result = decrypt(entry, key);
    expect(result).toBe(plaintext);
  });
});

describe("deriveKeyFromPassphrase", () => {
  it("returns a 32-byte Buffer", async () => {
    const key = await deriveKeyFromPassphrase("test-passphrase");
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("returns the same key for same passphrase and salt", async () => {
    const salt = randomBytes(16);
    const key1 = await deriveKeyFromPassphrase("my-pass", salt);
    const key2 = await deriveKeyFromPassphrase("my-pass", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("returns different keys for different passphrases", async () => {
    const salt = randomBytes(16);
    const key1 = await deriveKeyFromPassphrase("pass-one", salt);
    const key2 = await deriveKeyFromPassphrase("pass-two", salt);
    expect(key1.equals(key2)).toBe(false);
  });
});
