import { describe, it, expectTypeOf } from "vitest";
import type { NetworkPolicy, EnforcementLayers, KernelCapabilities } from "./types.js";

describe("NetworkPolicy", () => {
  it("accepts 'none'", () => {
    const n: NetworkPolicy = "none";
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });

  it("accepts domain allowlist object", () => {
    const n: NetworkPolicy = { allowedDomains: ["github.com", "*.npmjs.org"] };
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });

  it("accepts domain allowlist with deniedDomains", () => {
    const n: NetworkPolicy = { allowedDomains: [], deniedDomains: ["evil.com"] };
    expectTypeOf(n).toMatchTypeOf<NetworkPolicy>();
  });
});

describe("EnforcementLayers", () => {
  it("has pivotRoot and bindMounts fields", () => {
    const e: EnforcementLayers = {
      namespaces: true, pivotRoot: true, bindMounts: true,
      landlock: false, seccomp: false, capDrop: false,
    };
    expectTypeOf(e.pivotRoot).toBeBoolean();
    expectTypeOf(e.bindMounts).toBeBoolean();
  });
});

describe("KernelCapabilities", () => {
  it("has bwrap field", () => {
    const k: KernelCapabilities = {
      landlock: { supported: true, abiVersion: 3 },
      seccomp: { supported: true },
      namespaces: { user: true, pid: true, net: true, mnt: true },
      bwrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
    };
    expectTypeOf(k.bwrap.available).toBeBoolean();
  });
});
