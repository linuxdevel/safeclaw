import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  return {
    publicKey: pubRaw.toString("hex"),
    privateKey: privDer.toString("hex"),
  };
}

export function signManifest(content: string, privateKeyHex: string): string {
  const keyObj = createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(content, "utf8"), keyObj);
  return signature.toString("hex");
}
