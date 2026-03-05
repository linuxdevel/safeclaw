import { describe, it, expect } from "vitest";
import {
  nodeVersionCheck,
  linuxCheck,
  architectureCheck,
  vaultExistsCheck,
  sandboxHelperCheck,
  unshareCheck,
  landlockCheck,
  seccompCheck,
  userNamespaceCheck,
  keyringCheck,
  configFileCheck,
  githubConnectivityCheck,
} from "./doctor-checks.js";
import type { KernelCapabilities } from "@safeclaw/sandbox";

describe("nodeVersionCheck", () => {
  it("passes when Node.js >= 22", async () => {
    const check = nodeVersionCheck({ version: "v22.3.0" });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("22.3.0");
  });

  it("fails when Node.js < 22", async () => {
    const check = nodeVersionCheck({ version: "v20.11.0" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("20.11.0");
    expect(result.detail).toContain("22");
  });
});

describe("linuxCheck", () => {
  it("passes on linux", async () => {
    const check = linuxCheck({ platform: "linux" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails on non-linux", async () => {
    const check = linuxCheck({ platform: "darwin" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("darwin");
  });
});

describe("architectureCheck", () => {
  it("passes on x64", async () => {
    const check = architectureCheck({ arch: "x64" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("passes on arm64", async () => {
    const check = architectureCheck({ arch: "arm64" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails on unsupported architecture", async () => {
    const check = architectureCheck({ arch: "ia32" });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ia32");
  });
});

describe("vaultExistsCheck", () => {
  it("passes when vault file exists", async () => {
    const check = vaultExistsCheck({ existsSync: () => true, homedir: "/home/test" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when vault file does not exist", async () => {
    const check = vaultExistsCheck({ existsSync: () => false, homedir: "/home/test" });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("onboard");
  });
});

describe("sandboxHelperCheck", () => {
  it("passes when helper is found and executable", async () => {
    const check = sandboxHelperCheck({ findHelper: () => "/usr/bin/safeclaw-sandbox-helper" });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("/usr/bin/safeclaw-sandbox-helper");
  });

  it("warns when helper is not found", async () => {
    const check = sandboxHelperCheck({ findHelper: () => undefined });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("native");
  });
});

describe("unshareCheck", () => {
  it("passes when unshare is available", async () => {
    const check = unshareCheck({ execFileSync: () => "/usr/bin/unshare\n" });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when unshare is not found", async () => {
    const check = unshareCheck({
      execFileSync: () => { throw new Error("not found"); },
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("unshare");
  });
});

function makeKernelCaps(overrides: Partial<KernelCapabilities> = {}): KernelCapabilities {
  return {
    landlock: { supported: true, abiVersion: 3 },
    seccomp: { supported: true },
    namespaces: { user: true, pid: true, net: true, mnt: true },
    ...overrides,
  };
}

describe("landlockCheck", () => {
  it("passes when Landlock is supported", async () => {
    const caps = makeKernelCaps();
    const check = landlockCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("ABI v3");
  });

  it("fails when Landlock is not supported", async () => {
    const caps = makeKernelCaps({ landlock: { supported: false, abiVersion: 0 } });
    const check = landlockCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("5.13");
  });
});

describe("seccompCheck", () => {
  it("passes when seccomp is supported", async () => {
    const caps = makeKernelCaps();
    const check = seccompCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when seccomp is not supported", async () => {
    const caps = makeKernelCaps({ seccomp: { supported: false } });
    const check = seccompCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
  });
});

describe("userNamespaceCheck", () => {
  it("passes when user namespaces are available", async () => {
    const caps = makeKernelCaps();
    const check = userNamespaceCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("fails when user namespaces are unavailable", async () => {
    const caps = makeKernelCaps({
      namespaces: { user: false, pid: true, net: true, mnt: true },
    });
    const check = userNamespaceCheck({ detectKernelCapabilities: () => caps });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("namespace");
  });
});

describe("keyringCheck", () => {
  it("passes when secret-tool is available", async () => {
    const check = keyringCheck({
      execFileSync: () => "/usr/bin/secret-tool\n",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when secret-tool is not found", async () => {
    const check = keyringCheck({
      execFileSync: () => { throw new Error("not found"); },
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("passphrase");
  });
});

describe("configFileCheck", () => {
  it("passes when config file does not exist (optional)", async () => {
    const check = configFileCheck({
      existsSync: () => false,
      readFileSync: () => "",
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("not present");
  });

  it("passes when config file exists and is valid JSON", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => '{ "model": "claude-sonnet-4" }',
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("valid");
  });

  it("fails when config file exists but is invalid JSON", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => "{ broken json",
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("invalid");
  });

  it("fails when config file exists but is not an object", async () => {
    const check = configFileCheck({
      existsSync: () => true,
      readFileSync: () => '"just a string"',
      homedir: "/home/test",
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a JSON object");
  });
});

describe("githubConnectivityCheck", () => {
  it("passes when fetch succeeds", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => ({ ok: true, status: 200 }) as Response,
    });
    const result = await check.run();
    expect(result.status).toBe("pass");
  });

  it("warns when fetch fails", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => { throw new Error("ENOTFOUND"); },
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("api.github.com");
  });

  it("warns when fetch returns non-OK status", async () => {
    const check = githubConnectivityCheck({
      fetch: async () => ({ ok: false, status: 503 }) as Response,
    });
    const result = await check.run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("503");
  });
});
