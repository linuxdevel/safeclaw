import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ChangeModelOptions } from "./change-model.js";
import { runChangeModel } from "./change-model.js";
import type { CopilotModelInfo } from "@safeclaw/core";

const MODELS: CopilotModelInfo[] = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", conversational: true },
  { id: "gpt-4.1", name: "GPT-4.1", conversational: true },
  { id: "gpt-5.3-codex", name: "GPT Codex", conversational: false },
];

/** Push bytes into the input stream after the current microtask queue clears. */
function makeInput(bytes: string): PassThrough {
  const pt = new PassThrough();
  setImmediate(() => { pt.write(bytes); pt.end(); });
  return pt;
}

function createDeps(overrides: Partial<ChangeModelOptions> = {}): ChangeModelOptions {
  return {
    input: makeInput("\r"),
    output: new PassThrough(),
    vaultPath: "/tmp/test/vault.json",
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("abcdef01abcdef01abcdef01abcdef0102030405060708090a0b0c0d0e0f1011"),
    keyringProvider: { retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)) },
    openVault: vi.fn().mockReturnValue({
      get: vi.fn((name: string) => name === "github_token" ? "ghu_test" : undefined),
    }),
    deriveKey: vi.fn(),
    readPassphrase: vi.fn(),
    getCopilotToken: vi.fn().mockResolvedValue({ token: "cop_token", expiresAt: Date.now() + 3_600_000 }),
    listModels: vi.fn().mockResolvedValue(MODELS),
    loadConfig: vi.fn().mockReturnValue({ model: undefined, systemPrompt: undefined, maxToolRounds: 10 }),
    writeConfig: vi.fn(),
    ...overrides,
  };
}

describe("runChangeModel", () => {
  it("throws when vault does not exist", async () => {
    const deps = createDeps({ existsSync: vi.fn().mockReturnValue(false) });
    await expect(runChangeModel(deps)).rejects.toThrow("Vault not found");
  });

  it("throws when vault has no github_token", async () => {
    const deps = createDeps({
      openVault: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("No github_token in vault");
  });

  it("throws when keyring is null and salt file is missing", async () => {
    const deps = createDeps({
      keyringProvider: { retrieve: vi.fn().mockReturnValue(null) },
      existsSync: vi.fn((p: string) => !p.endsWith(".salt")),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("Cannot unlock vault");
  });

  it("throws when openVault throws (wrong passphrase)", async () => {
    const deps = createDeps({
      keyringProvider: { retrieve: vi.fn().mockReturnValue(null) },
      readPassphrase: vi.fn().mockResolvedValue("wrongpass"),
      deriveKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
      openVault: vi.fn().mockImplementation(() => { throw new Error("bad decrypt"); }),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("Failed to unlock vault");
  });

  it("throws when loadConfig throws", async () => {
    const deps = createDeps({
      loadConfig: vi.fn().mockImplementation(() => { throw new Error("bad json"); }),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("Config file is invalid");
  });

  it("throws when getCopilotToken throws", async () => {
    const deps = createDeps({
      getCopilotToken: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("GitHub token expired");
  });

  it("throws when listModels returns null", async () => {
    const deps = createDeps({ listModels: vi.fn().mockResolvedValue(null) });
    await expect(runChangeModel(deps)).rejects.toThrow("Could not reach Copilot API");
  });

  it("throws when writeConfig throws (write I/O error)", async () => {
    const deps = createDeps({
      writeConfig: vi.fn().mockImplementation(() => { throw new Error("ENOSPC"); }),
    });
    await expect(runChangeModel(deps)).rejects.toThrow("Failed to write config");
  });
});
