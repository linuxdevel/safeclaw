import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityRegistry,
  CapabilityEnforcer,
  CapabilityDeniedError,
  generateSigningKeyPair,
  signManifest,
  verifyManifestSignature,
} from "@safeclaw/core";
import type { CapabilityGrant } from "@safeclaw/core";

function makeGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    skillId: "test-skill",
    capability: "fs:read",
    grantedAt: new Date(),
    grantedBy: "user",
    ...overrides,
  };
}

describe("Permission escalation prevention", () => {
  let registry: CapabilityRegistry;
  let enforcer: CapabilityEnforcer;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    enforcer = new CapabilityEnforcer(registry);
  });

  describe("capability enforcement basics", () => {
    it("rejects operations with no grants registered", () => {
      expect(() => enforcer.check("test-skill", "fs:read")).toThrow(
        CapabilityDeniedError,
      );
    });

    it("rejects operations when skill has grants for a different capability", () => {
      registry.grantCapability(
        makeGrant({ capability: "fs:write" }),
      );

      expect(() => enforcer.check("test-skill", "fs:read")).toThrow(
        CapabilityDeniedError,
      );
    });

    it("allows operations with matching grant", () => {
      registry.grantCapability(makeGrant({ capability: "fs:read" }));

      expect(() => enforcer.check("test-skill", "fs:read")).not.toThrow();
    });
  });

  describe("path constraints", () => {
    it("grant for /tmp/ allows /tmp/foo", () => {
      registry.grantCapability(
        makeGrant({
          capability: "fs:read",
          constraints: { paths: ["/tmp/"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "fs:read", { path: "/tmp/foo" }),
      ).not.toThrow();
    });

    it("grant for /tmp/ rejects /etc/passwd", () => {
      registry.grantCapability(
        makeGrant({
          capability: "fs:read",
          constraints: { paths: ["/tmp/"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "fs:read", { path: "/etc/passwd" }),
      ).toThrow(CapabilityDeniedError);
    });

    it("path traversal: grant for /tmp/ rejects /tmp/../etc/passwd after normalization", () => {
      registry.grantCapability(
        makeGrant({
          capability: "fs:read",
          constraints: { paths: ["/tmp/"] },
        }),
      );

      // Path normalization resolves /tmp/../etc/passwd to /etc/passwd,
      // which is outside the /tmp/ grant — correctly denied.
      expect(() =>
        enforcer.check("test-skill", "fs:read", {
          path: "/tmp/../etc/passwd",
        }),
      ).toThrow(CapabilityDeniedError);
    });
  });

  describe("host constraints", () => {
    it("grant for example.com allows example.com", () => {
      registry.grantCapability(
        makeGrant({
          capability: "net:http",
          constraints: { hosts: ["example.com"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "net:http", { host: "example.com" }),
      ).not.toThrow();
    });

    it("grant for example.com rejects evil.com", () => {
      registry.grantCapability(
        makeGrant({
          capability: "net:http",
          constraints: { hosts: ["example.com"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "net:http", { host: "evil.com" }),
      ).toThrow(CapabilityDeniedError);
    });
  });

  describe("executable constraints", () => {
    it("grant for /usr/bin/ls allows /usr/bin/ls", () => {
      registry.grantCapability(
        makeGrant({
          capability: "process:spawn",
          constraints: { executables: ["/usr/bin/ls"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "process:spawn", {
          executable: "/usr/bin/ls",
        }),
      ).not.toThrow();
    });

    it("grant for /usr/bin/ls rejects /usr/bin/rm", () => {
      registry.grantCapability(
        makeGrant({
          capability: "process:spawn",
          constraints: { executables: ["/usr/bin/ls"] },
        }),
      );

      expect(() =>
        enforcer.check("test-skill", "process:spawn", {
          executable: "/usr/bin/rm",
        }),
      ).toThrow(CapabilityDeniedError);
    });
  });

  describe("multiple capabilities", () => {
    it("checkAll fails on first denied capability", () => {
      registry.grantCapability(makeGrant({ capability: "fs:read" }));
      // net:http is NOT granted

      expect(() =>
        enforcer.checkAll("test-skill", ["fs:read", "net:http"]),
      ).toThrow(CapabilityDeniedError);
    });

    it("checkAll passes when all capabilities are granted", () => {
      registry.grantCapability(makeGrant({ capability: "fs:read" }));
      registry.grantCapability(makeGrant({ capability: "net:http" }));

      expect(() =>
        enforcer.checkAll("test-skill", ["fs:read", "net:http"]),
      ).not.toThrow();
    });
  });

  describe("revoking grants", () => {
    it("after revokeGrants(), previously allowed operations are denied", () => {
      registry.grantCapability(makeGrant({ capability: "fs:read" }));

      // Should work before revocation
      expect(() => enforcer.check("test-skill", "fs:read")).not.toThrow();

      // Revoke
      registry.revokeGrants("test-skill");

      // Should be denied after revocation
      expect(() => enforcer.check("test-skill", "fs:read")).toThrow(
        CapabilityDeniedError,
      );
    });
  });
});

describe("Manifest signature verification", () => {
  it("generate keypair -> sign -> verify -> valid", () => {
    const kp = generateSigningKeyPair();
    const content = '{"id":"skill-1","version":"1.0.0"}';
    const signature = signManifest(content, kp.privateKey);
    const result = verifyManifestSignature(content, signature, kp.publicKey);

    expect(result.valid).toBe(true);
    expect(result.publicKey).toBe(kp.publicKey);
  });

  it("tampered content -> verify -> invalid", () => {
    const kp = generateSigningKeyPair();
    const content = '{"id":"skill-1","version":"1.0.0"}';
    const signature = signManifest(content, kp.privateKey);
    const result = verifyManifestSignature(
      '{"id":"skill-1","version":"9.9.9"}',
      signature,
      kp.publicKey,
    );

    expect(result.valid).toBe(false);
  });

  it("wrong public key -> verify -> invalid", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const content = "manifest content";
    const signature = signManifest(content, kp1.privateKey);
    const result = verifyManifestSignature(content, signature, kp2.publicKey);

    expect(result.valid).toBe(false);
  });

  it("invalid signature format -> verify -> returns { valid: false }", () => {
    const kp = generateSigningKeyPair();
    const result = verifyManifestSignature(
      "content",
      "not-valid-hex-!!!",
      kp.publicKey,
    );

    expect(result.valid).toBe(false);
  });

  it("invalid public key length -> verify -> returns { valid: false }", () => {
    const result = verifyManifestSignature("content", "aabbccdd", "0011");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid public key length");
  });
});
