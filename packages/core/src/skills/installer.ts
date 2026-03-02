import { verifyManifestSignature } from "../capabilities/verifier.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { SkillManifest, VerifyResult } from "../capabilities/types.js";
import type { InstallOptions } from "./types.js";

export class SkillInstaller {
  private readonly registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  install(manifest: SkillManifest, options?: InstallOptions): SkillManifest {
    const allowUnsigned = options?.allowUnsigned === true;
    const autoApprove = options?.autoApprove === true;

    if (!manifest.signature) {
      if (!allowUnsigned) {
        throw new Error(
          `Skill "${manifest.id}" is unsigned. Use --allow-unsigned to install unsigned skills.`,
        );
      }
    } else {
      const result = this.verifySignature(manifest);
      if (!result.valid) {
        throw new Error(
          `Skill "${manifest.id}" has an invalid signature: ${result.error ?? "verification failed"}`,
        );
      }
    }

    this.registry.registerSkill(manifest);

    if (autoApprove) {
      for (const cap of manifest.requiredCapabilities) {
        const grant = {
          skillId: manifest.id,
          capability: cap.capability,
          grantedAt: new Date(),
          grantedBy: "builtin" as const,
          ...(cap.constraints !== undefined ? { constraints: cap.constraints } : {}),
        };
        this.registry.grantCapability(grant);
      }
    }

    return manifest;
  }

  private verifySignature(manifest: SkillManifest): VerifyResult {
    const content = this.getCanonicalContent(manifest);
    return verifyManifestSignature(content, manifest.signature, manifest.publicKey);
  }

  private getCanonicalContent(manifest: SkillManifest): string {
    const { signature: _, ...rest } = manifest;
    return JSON.stringify(rest, Object.keys(rest).sort());
  }
}
