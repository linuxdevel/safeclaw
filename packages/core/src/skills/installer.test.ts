import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, signManifest } from "../capabilities/signer.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import type { SkillManifest } from "../capabilities/types.js";
import { SkillInstaller } from "./installer.js";

function createTestManifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    id: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    description: "A test skill",
    signature: "",
    publicKey: "",
    requiredCapabilities: [
      {
        capability: "fs:read",
        constraints: { paths: ["/tmp"] },
        reason: "Read temp files",
      },
    ],
    tools: [{ name: "test-tool", description: "A tool", parameters: {} }],
    ...overrides,
  };
}

function signTestManifest(manifest: SkillManifest): SkillManifest {
  const kp = generateSigningKeyPair();
  const withKey = { ...manifest, publicKey: kp.publicKey, signature: "" };
  const canonical = canonicalContent(withKey);
  const signature = signManifest(canonical, kp.privateKey);
  return { ...withKey, signature };
}

function canonicalContent(manifest: SkillManifest): string {
  const { signature: _, ...rest } = manifest;
  const sorted = JSON.stringify(rest, Object.keys(rest).sort());
  return sorted;
}

describe("SkillInstaller", () => {
  it("installs signed manifest successfully", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = signTestManifest(createTestManifest());

    const result = installer.install(manifest);

    expect(result).toEqual(manifest);
  });

  it("rejects unsigned manifest by default", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = createTestManifest();

    expect(() => installer.install(manifest)).toThrow(/unsigned/i);
  });

  it("allows unsigned manifest with allowUnsigned flag", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = createTestManifest();

    const result = installer.install(manifest, { allowUnsigned: true });

    expect(result).toEqual(manifest);
  });

  it("rejects manifest with invalid signature", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const kp = generateSigningKeyPair();
    const manifest = createTestManifest({
      publicKey: kp.publicKey,
      signature: "deadbeef".repeat(16),
    });

    expect(() => installer.install(manifest)).toThrow(/signature/i);
  });

  it("registers manifest in capability registry", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = signTestManifest(createTestManifest());

    installer.install(manifest);

    const registered = registry.getSkill("test-skill");
    expect(registered).toEqual(manifest);
  });

  it("auto-approves capabilities when autoApprove is true", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = signTestManifest(createTestManifest());

    installer.install(manifest, { autoApprove: true });

    expect(registry.hasGrant("test-skill", "fs:read")).toBe(true);
  });

  it("does not auto-approve by default", () => {
    const registry = new CapabilityRegistry();
    const installer = new SkillInstaller(registry);
    const manifest = signTestManifest(createTestManifest());

    installer.install(manifest);

    expect(registry.hasGrant("test-skill", "fs:read")).toBe(false);
  });
});
