import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, signManifest } from "./signer.js";
import { verifyManifestSignature } from "./verifier.js";

describe("verifyManifestSignature", () => {
  it("accepts a valid signature", () => {
    const kp = generateSigningKeyPair();
    const content = "manifest content";
    const sig = signManifest(content, kp.privateKey);
    const result = verifyManifestSignature(content, sig, kp.publicKey);
    expect(result.valid).toBe(true);
    expect(result.publicKey).toBe(kp.publicKey);
    expect(result.error).toBeUndefined();
  });

  it("rejects tampered content", () => {
    const kp = generateSigningKeyPair();
    const sig = signManifest("original", kp.privateKey);
    const result = verifyManifestSignature("tampered", sig, kp.publicKey);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong public key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const sig = signManifest("content", kp1.privateKey);
    const result = verifyManifestSignature("content", sig, kp2.publicKey);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid signature format gracefully", () => {
    const kp = generateSigningKeyPair();
    const result = verifyManifestSignature("content", "not-hex", kp.publicKey);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid public key length", () => {
    const result = verifyManifestSignature("content", "aabb", "0011");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid public key length");
  });
});
