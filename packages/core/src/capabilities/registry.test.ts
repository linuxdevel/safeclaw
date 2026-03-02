import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "./registry.js";
import type { SkillManifest, CapabilityGrant } from "./types.js";

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    description: "A test skill",
    signature: "aabb",
    publicKey: "ccdd",
    requiredCapabilities: [],
    tools: [],
    ...overrides,
  };
}

function makeGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    skillId: "test-skill",
    capability: "fs:read",
    grantedAt: new Date(),
    grantedBy: "user",
    ...overrides,
  };
}

describe("CapabilityRegistry", () => {
  it("registers and retrieves a skill manifest", () => {
    const registry = new CapabilityRegistry();
    const manifest = makeManifest();
    registry.registerSkill(manifest);
    expect(registry.getSkill("test-skill")).toEqual(manifest);
  });

  it("returns undefined for unknown skill", () => {
    const registry = new CapabilityRegistry();
    expect(registry.getSkill("unknown")).toBeUndefined();
  });

  it("lists all skills", () => {
    const registry = new CapabilityRegistry();
    registry.registerSkill(makeManifest({ id: "a" }));
    registry.registerSkill(makeManifest({ id: "b" }));
    const skills = registry.listSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.id)).toContain("a");
    expect(skills.map((s) => s.id)).toContain("b");
  });

  it("removes a skill", () => {
    const registry = new CapabilityRegistry();
    registry.registerSkill(makeManifest());
    expect(registry.removeSkill("test-skill")).toBe(true);
    expect(registry.getSkill("test-skill")).toBeUndefined();
  });

  it("returns false when removing non-existent skill", () => {
    const registry = new CapabilityRegistry();
    expect(registry.removeSkill("nope")).toBe(false);
  });

  it("grants and checks capabilities", () => {
    const registry = new CapabilityRegistry();
    registry.grantCapability(makeGrant());
    expect(registry.hasGrant("test-skill", "fs:read")).toBe(true);
  });

  it("returns all grants for a skill", () => {
    const registry = new CapabilityRegistry();
    registry.grantCapability(makeGrant({ capability: "fs:read" }));
    registry.grantCapability(makeGrant({ capability: "fs:write" }));
    const grants = registry.getGrants("test-skill");
    expect(grants).toHaveLength(2);
  });

  it("revokes all grants for a skill", () => {
    const registry = new CapabilityRegistry();
    registry.grantCapability(makeGrant());
    registry.revokeGrants("test-skill");
    expect(registry.hasGrant("test-skill", "fs:read")).toBe(false);
    expect(registry.getGrants("test-skill")).toHaveLength(0);
  });

  it("hasGrant returns false for ungranted capability", () => {
    const registry = new CapabilityRegistry();
    expect(registry.hasGrant("test-skill", "net:http")).toBe(false);
  });
});
