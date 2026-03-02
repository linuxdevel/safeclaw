import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, signManifest } from "./signer.js";

describe("generateSigningKeyPair", () => {
  it("generates a key pair with 64-char hex public key", () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a key pair with 96+ char hex private key", () => {
    const kp = generateSigningKeyPair();
    expect(kp.privateKey).toMatch(/^[0-9a-f]+$/);
    expect(kp.privateKey.length).toBeGreaterThanOrEqual(96);
  });
});

describe("signManifest", () => {
  it("signs content deterministically", () => {
    const kp = generateSigningKeyPair();
    const content = "hello world";
    const sig1 = signManifest(content, kp.privateKey);
    const sig2 = signManifest(content, kp.privateKey);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different signatures for different content", () => {
    const kp = generateSigningKeyPair();
    const sig1 = signManifest("content A", kp.privateKey);
    const sig2 = signManifest("content B", kp.privateKey);
    expect(sig1).not.toBe(sig2);
  });
});
