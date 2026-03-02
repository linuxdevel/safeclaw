import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { runOnboarding } from "./onboard.js";
import type { OnboardOptions } from "./onboard.js";
import type { KernelCapabilities } from "@safeclaw/sandbox";
import type {
  DeviceCodeResponse,
  TokenResponse,
  CopilotToken,
} from "@safeclaw/core";
import type { SigningKeyPair } from "@safeclaw/core";

// --- Helpers ---

function simulateInput(input: PassThrough, ...lines: string[]): void {
  for (const line of lines) {
    input.push(line + "\n");
  }
  input.push(null);
}

function readOutput(output: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = output.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

const fullCapabilities: KernelCapabilities = {
  landlock: { supported: true, abiVersion: 4 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: true, net: true, mnt: true },
};

const partialCapabilities: KernelCapabilities = {
  landlock: { supported: false, abiVersion: 0 },
  seccomp: { supported: true },
  namespaces: { user: true, pid: false, net: false, mnt: true },
};

const mockDeviceCode: DeviceCodeResponse = {
  device_code: "dev-code-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const mockToken: TokenResponse = {
  access_token: "ghu_test_token_abc",
  token_type: "bearer",
  scope: "read:user",
};

const mockCopilotToken: CopilotToken = {
  token: "tid=copilot-token",
  expiresAt: Date.now() + 3600_000,
};

const mockKeyPair: SigningKeyPair = {
  publicKey: "aabbccdd",
  privateKey: "11223344",
};

function createMockVault() {
  return {
    set: vi.fn(),
    save: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    keys: vi.fn().mockReturnValue([]),
  };
}

function createMockKeyringProvider() {
  return {
    store: vi.fn(),
    retrieve: vi.fn().mockReturnValue(null),
  };
}

function createBaseOptions(
  input: PassThrough,
  output: PassThrough,
): Omit<OnboardOptions, "vaultPath"> {
  const vault = createMockVault();
  return {
    input,
    output,
    detectCapabilities: () => fullCapabilities,
    requestDeviceCode: vi.fn().mockResolvedValue(mockDeviceCode),
    pollForToken: vi.fn().mockResolvedValue(mockToken),
    getCopilotToken: vi.fn().mockResolvedValue(mockCopilotToken),
    createVault: vi.fn().mockReturnValue(vault),
    keyringProvider: createMockKeyringProvider(),
    deriveKey: vi.fn().mockResolvedValue(Buffer.alloc(32, 0xaa)),
    generateKeyPair: () => mockKeyPair,
    writeSalt: vi.fn(),
  };
}

describe("runOnboarding", () => {
  let input: PassThrough;
  let output: PassThrough;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
  });

  it("runs full happy path with keyring and default model", async () => {
    // User choices: yes to auth, "1" for keyring, "" for default model
    simulateInput(input, "y", "1", "");

    const base = createBaseOptions(input, output);
    const options: OnboardOptions = {
      ...base,
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.kernelCapabilities).toEqual(fullCapabilities);
    expect(result.authenticated).toBe(true);
    expect(result.vaultCreated).toBe(true);
    expect(result.keySource).toBe("keyring");
    expect(result.signingKeyGenerated).toBe(true);
    expect(result.selectedModel).toBe("claude-sonnet-4");

    // Vault should have been saved
    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.save).toHaveBeenCalledOnce();
  });

  it("displays kernel capabilities in output", async () => {
    simulateInput(input, "y", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    await runOnboarding(options);

    const out = readOutput(output);
    expect(out).toContain("Landlock");
    expect(out).toContain("Seccomp");
  });

  it("warns about missing kernel features but continues", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
      detectCapabilities: () => partialCapabilities,
    };

    const result = await runOnboarding(options);

    expect(result.kernelCapabilities).toEqual(partialCapabilities);
    const out = readOutput(output);
    expect(out).toMatch(/not supported|unavailable/i);
    // Should still complete all steps
    expect(result.vaultCreated).toBe(true);
  });

  it("skips authentication when user declines", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.authenticated).toBe(false);
    expect(options.requestDeviceCode).not.toHaveBeenCalled();
    expect(options.pollForToken).not.toHaveBeenCalled();
    expect(options.getCopilotToken).not.toHaveBeenCalled();
  });

  it("performs device flow authentication when user accepts", async () => {
    simulateInput(input, "y", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.authenticated).toBe(true);
    expect(options.requestDeviceCode).toHaveBeenCalledOnce();
    expect(options.pollForToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: expect.any(String) }),
      "dev-code-123",
      5,
    );
    expect(options.getCopilotToken).toHaveBeenCalledWith("ghu_test_token_abc");

    const out = readOutput(output);
    expect(out).toContain("ABCD-1234");
    expect(out).toContain("https://github.com/login/device");
  });

  it("stores access token in vault after auth", async () => {
    simulateInput(input, "y", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    await runOnboarding(options);

    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.set).toHaveBeenCalledWith(
      "github_token",
      "ghu_test_token_abc",
    );
  });

  it("uses keyring when user selects option 1", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.keySource).toBe("keyring");
    expect(options.keyringProvider!.store).toHaveBeenCalledWith(
      expect.any(Buffer),
    );
    expect(options.createVault).toHaveBeenCalledWith(
      "/tmp/test-vault.json",
      expect.any(Buffer),
    );
  });

  it("uses passphrase when user selects option 2", async () => {
    simulateInput(input, "n", "2", "my-secret-pass", "my-secret-pass", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.keySource).toBe("passphrase");
    expect(options.deriveKey).toHaveBeenCalledWith(
      "my-secret-pass",
      expect.any(Buffer),
    );
    expect(options.createVault).toHaveBeenCalledWith(
      "/tmp/test-vault.json",
      expect.any(Buffer),
    );
  });

  it("generates signing key pair and stores in vault", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.signingKeyGenerated).toBe(true);

    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.set).toHaveBeenCalledWith("signing_private_key", "11223344");

    const out = readOutput(output);
    expect(out).toContain("aabbccdd");
  });

  it("selects default model when user presses enter", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.selectedModel).toBe("claude-sonnet-4");

    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.set).toHaveBeenCalledWith("default_model", "claude-sonnet-4");
  });

  it("selects custom model when user enters a number", async () => {
    // Select model 3 (gpt-4.1)
    simulateInput(input, "n", "1", "3");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.selectedModel).toBe("gpt-4.1");

    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.set).toHaveBeenCalledWith("default_model", "gpt-4.1");
  });

  it("calls vault.save() at the end", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    await runOnboarding(options);

    const vault = (options.createVault as ReturnType<typeof vi.fn>).mock
      .results[0]!.value as ReturnType<typeof createMockVault>;
    expect(vault.save).toHaveBeenCalledOnce();
  });

  it("displays model choices in output", async () => {
    simulateInput(input, "n", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    await runOnboarding(options);

    const out = readOutput(output);
    expect(out).toContain("claude-sonnet-4");
    expect(out).toContain("claude-opus-4");
    expect(out).toContain("gpt-4.1");
    expect(out).toContain("gemini-2.5-pro");
    expect(out).toContain("o4-mini");
  });

  it("throws when passphrases do not match", async () => {
    simulateInput(input, "n", "2", "my-secret-pass", "different-pass", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    await expect(runOnboarding(options)).rejects.toThrow(
      "Passphrases do not match",
    );
  });

  it("falls back to default model for out-of-range selection", async () => {
    simulateInput(input, "n", "1", "99");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.selectedModel).toBe("claude-sonnet-4");

    const out = readOutput(output);
    expect(out).toContain("Invalid selection, using default.");
  });

  it("continues with authenticated: false when requestDeviceCode rejects", async () => {
    simulateInput(input, "y", "1", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
      requestDeviceCode: vi
        .fn()
        .mockRejectedValue(new Error("network timeout")),
    };

    const result = await runOnboarding(options);

    expect(result.authenticated).toBe(false);
    expect(result.vaultCreated).toBe(true);

    const out = readOutput(output);
    expect(out).toContain("Authentication failed: network timeout");
  });

  it("persists salt file when using passphrase path", async () => {
    simulateInput(input, "n", "2", "my-secret-pass", "my-secret-pass", "");

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
    };

    const result = await runOnboarding(options);

    expect(result.keySource).toBe("passphrase");
    expect(result.saltPath).toBe("/tmp/test-vault.json.salt");
    expect(options.writeSalt).toHaveBeenCalledWith(
      "/tmp/test-vault.json.salt",
      expect.stringMatching(/^[0-9a-f]{32}$/),
    );
  });

  it("falls back to passphrase when keyring throws", async () => {
    simulateInput(input, "n", "1", "my-secret-pass", "my-secret-pass", "");

    const failingKeyring = {
      store: vi.fn().mockImplementation(() => {
        throw new Error("D-Bus not available");
      }),
      retrieve: vi.fn().mockReturnValue(null),
    };

    const options: OnboardOptions = {
      ...createBaseOptions(input, output),
      vaultPath: "/tmp/test-vault.json",
      keyringProvider: failingKeyring,
    };

    const result = await runOnboarding(options);

    expect(result.keySource).toBe("passphrase");
    const out = readOutput(output);
    expect(out).toContain("Keyring unavailable");
    expect(out).toContain("D-Bus not available");
  });
});
