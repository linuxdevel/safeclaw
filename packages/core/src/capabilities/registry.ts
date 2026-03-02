import type { Capability, CapabilityGrant, SkillManifest } from "./types.js";

export class CapabilityRegistry {
  private skills = new Map<string, SkillManifest>();
  private grants = new Map<string, CapabilityGrant[]>();

  registerSkill(manifest: SkillManifest): void {
    this.skills.set(manifest.id, manifest);
  }

  getSkill(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  listSkills(): SkillManifest[] {
    return [...this.skills.values()];
  }

  removeSkill(id: string): boolean {
    return this.skills.delete(id);
  }

  grantCapability(grant: CapabilityGrant): void {
    const existing = this.grants.get(grant.skillId) ?? [];
    existing.push(grant);
    this.grants.set(grant.skillId, existing);
  }

  getGrants(skillId: string): CapabilityGrant[] {
    return this.grants.get(skillId) ?? [];
  }

  revokeGrants(skillId: string): void {
    this.grants.delete(skillId);
  }

  hasGrant(skillId: string, capability: Capability): boolean {
    const grants = this.grants.get(skillId);
    if (!grants) return false;
    return grants.some((g) => g.capability === capability);
  }
}
