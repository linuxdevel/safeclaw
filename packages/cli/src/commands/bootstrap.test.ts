import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { bootstrapAgent } from "./bootstrap.js";
import type { BootstrapDeps } from "./bootstrap.js";
import {
  AuditLog,
  CapabilityRegistry,
  SessionManager,
} from "@safeclaw/core";

const FAKE_MANIFEST = JSON.stringify({
  id: "builtin",
  version: "1.0.0",
  name: "SafeClaw Built-in Tools",
  description: "Core tools",
  signature: "aaa",
  publicKey: "bbb",
  requiredCapabilities: [
    { capability: "fs:read", reason: "read" },
    { capability: "fs:write", reason: "write" },
    { capability: "process:spawn", reason: "spawn" },
    { capability: "net:https", reason: "https" },
  ],
  tools: [],
});

function mockReadFile(p: string, _enc: BufferEncoding): string {
  if (p.endsWith("manifest.json")) return FAKE_MANIFEST;
  return "abcdef0123456789abcdef0123456789";
}

function createMockDeps(
  overrides: Partial<BootstrapDeps> = {},
): BootstrapDeps {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    vaultPath: "/tmp/test-vault.json",
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockImplementation(mockReadFile),
    keyringProvider: {
      retrieve: vi.fn().mockReturnValue(null),
      store: vi.fn(),
    },
    openVault: vi.fn().mockReturnValue({
      get: vi.fn((name: string) => {
        if (name === "github_token") return "ghu_testtoken";
        if (name === "default_model") return "claude-sonnet-4";
        return undefined;
      }),
    }),
    deriveKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
    getCopilotToken: vi
      .fn()
      .mockResolvedValue({ token: "cpt_test", expiresAt: Date.now() + 3600000 }),
    readPassphrase: vi
      .fn()
      .mockResolvedValue("test-passphrase"),
    ...overrides,
  };
}

describe("bootstrapAgent", () => {
  it("returns agent and sessionManager when vault exists with passphrase key", async () => {
    const deps = createMockDeps();

    const result = await bootstrapAgent(deps);
    expect(result.agent).toBeDefined();
    expect(result.sessionManager).toBeDefined();
    expect(deps.getCopilotToken).toHaveBeenCalledWith("ghu_testtoken");
  });

  it("uses keyring key when available (no passphrase prompt)", async () => {
    const keyringKey = Buffer.alloc(32, 0xaa);
    const deps = createMockDeps({
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(keyringKey),
        store: vi.fn(),
      },
      existsSync: vi.fn((p: string) => !p.endsWith(".salt")),
    });

    const result = await bootstrapAgent(deps);
    expect(result.agent).toBeDefined();
    expect(deps.deriveKey).not.toHaveBeenCalled();
  });

  it("throws when vault file does not exist", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockReturnValue(false),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(/onboard/i);
  });

  it("throws when github_token is not in vault", async () => {
    const deps = createMockDeps({
      openVault: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
      }),
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
        store: vi.fn(),
      },
      existsSync: vi.fn((p: string) => !p.endsWith(".salt")),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(
      /github_token|onboard/i,
    );
  });

  it("throws when keyring unavailable and no salt file", async () => {
    const deps = createMockDeps({
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(null),
        store: vi.fn(),
      },
      existsSync: vi.fn((p: string) => {
        // vault exists, but salt file does not
        if (p.endsWith(".salt")) return false;
        return true;
      }),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(
      /keyring|salt|onboard/i,
    );
  });

  it("reads salt file and prompts for passphrase", async () => {
    const saltHex = "aabbccdd11223344aabbccdd11223344";
    const deps = createMockDeps({
      readFileSync: vi.fn().mockImplementation((p: string) => {
        if (p.endsWith("manifest.json")) return FAKE_MANIFEST;
        return saltHex;
      }),
      readPassphrase: vi.fn().mockResolvedValue("testpass123"),
    });

    await bootstrapAgent(deps);

    expect(deps.readFileSync).toHaveBeenCalledWith(
      "/tmp/test-vault.json.salt",
      "utf8",
    );
    expect(deps.deriveKey).toHaveBeenCalledWith(
      "testpass123",
      Buffer.from(saltHex, "hex"),
    );
  });

  it("uses default_model from vault for agent config", async () => {
    const deps = createMockDeps({
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
        store: vi.fn(),
      },
      openVault: vi.fn().mockReturnValue({
        get: vi.fn((name: string) => {
          if (name === "github_token") return "ghu_testtoken";
          if (name === "default_model") return "gpt-4.1";
          return undefined;
        }),
      }),
    });

    const result = await bootstrapAgent(deps);
    expect(result.agent).toBeDefined();
  });

  it("returns capabilityRegistry, auditLog, and sessionManager", async () => {
    const result = await bootstrapAgent(createMockDeps());
    expect(result.capabilityRegistry).toBeInstanceOf(CapabilityRegistry);
    expect(result.auditLog).toBeInstanceOf(AuditLog);
    expect(result.sessionManager).toBeInstanceOf(SessionManager);
  });

  it("registers builtin skill manifest in capability registry", async () => {
    const result = await bootstrapAgent(createMockDeps());
    const skills = result.capabilityRegistry.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe("builtin");

    // Verify capabilities were actually granted
    expect(result.capabilityRegistry.hasGrant("builtin", "fs:read")).toBe(true);
    expect(result.capabilityRegistry.hasGrant("builtin", "fs:write")).toBe(true);
    expect(result.capabilityRegistry.hasGrant("builtin", "process:spawn")).toBe(true);
    expect(result.capabilityRegistry.hasGrant("builtin", "net:https")).toBe(true);
  });

  it("throws when builtin manifest fails to load", async () => {
    const deps = createMockDeps({
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
        store: vi.fn(),
      },
      readFileSync: vi.fn().mockImplementation((p: string, _enc: BufferEncoding) => {
        if (p.endsWith("manifest.json")) return "NOT VALID JSON{{{";
        return "abcdef0123456789abcdef0123456789";
      }),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(
      /Failed to load builtin manifest/i,
    );
  });

  it("throws descriptive error when manifest file cannot be read", async () => {
    const deps = createMockDeps({
      keyringProvider: {
        retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
        store: vi.fn(),
      },
      readFileSync: vi.fn().mockImplementation((p: string, _enc: BufferEncoding) => {
        if (p.endsWith("manifest.json")) {
          throw new Error("ENOENT: no such file or directory");
        }
        return "abcdef0123456789abcdef0123456789";
      }),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(
      /Failed to load builtin skill manifest.*ENOENT/,
    );
  });

  it("calls readPassphrase with correct prompt", async () => {
    const mockReadPassphrase = vi.fn().mockResolvedValue("mypass123");
    const deps = createMockDeps({
      readPassphrase: mockReadPassphrase,
    });

    await bootstrapAgent(deps);

    expect(mockReadPassphrase).toHaveBeenCalledWith(
      "Enter vault passphrase: ",
      deps.input,
      deps.output,
    );
  });
});
