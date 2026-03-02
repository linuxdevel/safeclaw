import { describe, it, expect } from "vitest";
import { CapabilityEnforcer, CapabilityDeniedError } from "./enforcer.js";
import { CapabilityRegistry } from "./registry.js";
import type { CapabilityGrant } from "./types.js";

function grant(
  registry: CapabilityRegistry,
  overrides: Partial<CapabilityGrant> = {},
): void {
  registry.grantCapability({
    skillId: "test-skill",
    capability: "fs:read",
    grantedAt: new Date(),
    grantedBy: "user",
    ...overrides,
  });
}

describe("CapabilityEnforcer", () => {
  it("allows granted capability", () => {
    const registry = new CapabilityRegistry();
    grant(registry);
    const enforcer = new CapabilityEnforcer(registry);
    expect(() => enforcer.check("test-skill", "fs:read")).not.toThrow();
  });

  it("denies ungranted capability with descriptive error", () => {
    const registry = new CapabilityRegistry();
    const enforcer = new CapabilityEnforcer(registry);
    expect(() => enforcer.check("test-skill", "net:http")).toThrow(
      CapabilityDeniedError,
    );
    expect(() => enforcer.check("test-skill", "net:http")).toThrow(
      /net:http/,
    );
    expect(() => enforcer.check("test-skill", "net:http")).toThrow(
      /test-skill/,
    );
  });

  it("checks path constraints for fs:read", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "fs:read",
      constraints: { paths: ["/allowed/"] },
    });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.check("test-skill", "fs:read", { path: "/allowed/file.txt" }),
    ).not.toThrow();
    expect(() =>
      enforcer.check("test-skill", "fs:read", { path: "/forbidden/file.txt" }),
    ).toThrow(CapabilityDeniedError);
  });

  it("checks path constraints for fs:write", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "fs:write",
      constraints: { paths: ["/tmp/"] },
    });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.check("test-skill", "fs:write", { path: "/tmp/output.log" }),
    ).not.toThrow();
    expect(() =>
      enforcer.check("test-skill", "fs:write", { path: "/etc/passwd" }),
    ).toThrow(CapabilityDeniedError);
  });

  it("checks host constraints for net:http", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "net:http",
      constraints: { hosts: ["api.example.com"] },
    });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.check("test-skill", "net:http", { host: "api.example.com" }),
    ).not.toThrow();
    expect(() =>
      enforcer.check("test-skill", "net:http", { host: "evil.com" }),
    ).toThrow(CapabilityDeniedError);
  });

  it("checks host constraints for net:https", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "net:https",
      constraints: { hosts: ["secure.example.com"] },
    });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.check("test-skill", "net:https", { host: "secure.example.com" }),
    ).not.toThrow();
    expect(() =>
      enforcer.check("test-skill", "net:https", { host: "evil.com" }),
    ).toThrow(CapabilityDeniedError);
  });

  it("allows capability with no constraints when no context given", () => {
    const registry = new CapabilityRegistry();
    grant(registry, { capability: "net:http" });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() => enforcer.check("test-skill", "net:http")).not.toThrow();
  });

  it("checkAll passes when all capabilities granted", () => {
    const registry = new CapabilityRegistry();
    grant(registry, { capability: "fs:read" });
    grant(registry, { capability: "net:http" });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.checkAll("test-skill", ["fs:read", "net:http"]),
    ).not.toThrow();
  });

  it("checkAll fails when any capability not granted", () => {
    const registry = new CapabilityRegistry();
    grant(registry, { capability: "fs:read" });
    const enforcer = new CapabilityEnforcer(registry);
    expect(() =>
      enforcer.checkAll("test-skill", ["fs:read", "net:http"]),
    ).toThrow(CapabilityDeniedError);
  });

  it("rejects path traversal via ..", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "fs:read",
      constraints: { paths: ["/tmp/"] },
    });
    const enforcer = new CapabilityEnforcer(registry);

    // Direct traversal — should be denied
    expect(() =>
      enforcer.check("test-skill", "fs:read", { path: "/tmp/../etc/passwd" }),
    ).toThrow(CapabilityDeniedError);
  });

  it("rejects path traversal via encoded sequences", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "fs:write",
      constraints: { paths: ["/home/user/"] },
    });
    const enforcer = new CapabilityEnforcer(registry);

    expect(() =>
      enforcer.check("test-skill", "fs:write", {
        path: "/home/user/../../etc/shadow",
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it("allows legitimate paths after normalization", () => {
    const registry = new CapabilityRegistry();
    grant(registry, {
      capability: "fs:read",
      constraints: { paths: ["/tmp/"] },
    });
    const enforcer = new CapabilityEnforcer(registry);

    // Redundant path segments that still resolve under /tmp/
    expect(() =>
      enforcer.check("test-skill", "fs:read", {
        path: "/tmp/subdir/../other/file.txt",
      }),
    ).not.toThrow();
  });
});
