import type { Capability } from "./types.js";
import type { CapabilityRegistry } from "./registry.js";

export class CapabilityDeniedError extends Error {
  constructor(
    public readonly skillId: string,
    public readonly capability: Capability,
    reason: string,
  ) {
    super(
      `Capability denied: skill "${skillId}" requires "${capability}" — ${reason}`,
    );
    this.name = "CapabilityDeniedError";
  }
}

interface CheckContext {
  path?: string;
  host?: string;
  executable?: string;
}

export class CapabilityEnforcer {
  constructor(private readonly registry: CapabilityRegistry) {}

  check(skillId: string, capability: Capability, context?: CheckContext): void {
    const grants = this.registry.getGrants(skillId);
    const matching = grants.filter((g) => g.capability === capability);

    if (matching.length === 0) {
      throw new CapabilityDeniedError(skillId, capability, "no grant found");
    }

    if (context) {
      this.checkConstraints(skillId, capability, matching, context);
    }
  }

  checkAll(skillId: string, capabilities: Capability[]): void {
    for (const cap of capabilities) {
      this.check(skillId, cap);
    }
  }

  private checkConstraints(
    skillId: string,
    capability: Capability,
    grants: { constraints?: { paths?: string[]; hosts?: string[]; executables?: string[] } }[],
    context: CheckContext,
  ): void {
    if (context.path) {
      const pathGrants = grants.filter((g) => g.constraints?.paths);
      if (pathGrants.length > 0) {
        const allowed = pathGrants.some((g) =>
          g.constraints!.paths!.some((p) => context.path!.startsWith(p)),
        );
        if (!allowed) {
          throw new CapabilityDeniedError(
            skillId,
            capability,
            `path "${context.path}" not in allowed paths`,
          );
        }
      }
    }

    if (context.host) {
      const hostGrants = grants.filter((g) => g.constraints?.hosts);
      if (hostGrants.length > 0) {
        const allowed = hostGrants.some((g) =>
          g.constraints!.hosts!.includes(context.host!),
        );
        if (!allowed) {
          throw new CapabilityDeniedError(
            skillId,
            capability,
            `host "${context.host}" not in allowed hosts`,
          );
        }
      }
    }

    if (context.executable) {
      const execGrants = grants.filter((g) => g.constraints?.executables);
      if (execGrants.length > 0) {
        const allowed = execGrants.some((g) =>
          g.constraints!.executables!.includes(context.executable!),
        );
        if (!allowed) {
          throw new CapabilityDeniedError(
            skillId,
            capability,
            `executable "${context.executable}" not in allowed executables`,
          );
        }
      }
    }
  }
}
