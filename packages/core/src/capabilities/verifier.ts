import { verify, createPublicKey } from "node:crypto";
import type { VerifyResult } from "./types.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyManifestSignature(
  content: string,
  signatureHex: string,
  publicKeyHex: string,
): VerifyResult {
  try {
    const pubRaw = Buffer.from(publicKeyHex, "hex");
    if (pubRaw.length !== 32) {
      return { valid: false, error: "Invalid public key length" };
    }
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]);
    const keyObj = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const sig = Buffer.from(signatureHex, "hex");
    const valid = verify(null, Buffer.from(content, "utf8"), keyObj, sig);
    return { valid, publicKey: publicKeyHex };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}
