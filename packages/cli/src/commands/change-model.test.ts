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

  it("selects the first model on Enter with no arrow keys", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({ input: makeInput("\r"), writeConfig });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "claude-sonnet-4");
  });

  it("selects the 3rd model after Down Down Enter", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({ input: makeInput("\x1b[B\x1b[B\r"), writeConfig });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "gpt-5.3-codex");
  });

  it("wraps from index 0 to last on Up", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({ input: makeInput("\x1b[A\r"), writeConfig });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "gpt-5.3-codex");
  });

  it("wraps from last to index 0 on Down", async () => {
    const writeConfig = vi.fn();
    // Down×3 with 3 models: 0→1→2→0 (wrap), then Enter
    const deps = createDeps({ input: makeInput("\x1b[B\x1b[B\x1b[B\r"), writeConfig });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "claude-sonnet-4");
  });

  it("returns normally without calling writeConfig on Ctrl+C", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({ input: makeInput("\x03"), writeConfig });
    await runChangeModel(deps);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("works with a single-model list", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({
      input: makeInput("\r"),
      listModels: vi.fn().mockResolvedValue([MODELS[0]]),
      writeConfig,
    });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "claude-sonnet-4");
  });

  it("renders [chat] and [completion] labels in output", async () => {
    const outputStream = new PassThrough();
    const chunks: string[] = [];
    outputStream.on("data", (d: Buffer) => { chunks.push(d.toString()); });

    const deps = createDeps({ input: makeInput("\r"), output: outputStream });
    await runChangeModel(deps);

    const out = chunks.join("");
    expect(out).toContain("[chat]");
    expect(out).toContain("[completion]");
    expect(out).toContain(">");
    expect(out).toContain("Model changed to");
  });

  it("prints Cancelled. on Ctrl+C", async () => {
    const outputStream = new PassThrough();
    const chunks: string[] = [];
    outputStream.on("data", (d: Buffer) => { chunks.push(d.toString()); });

    const deps = createDeps({ input: makeInput("\x03"), output: outputStream });
    await runChangeModel(deps);
    expect(chunks.join("")).toContain("Cancelled.");
  });

  it("happy path with keyring (no passphrase prompt)", async () => {
    const writeConfig = vi.fn();
    const deriveKey = vi.fn();
    const readPassphrase = vi.fn();
    const deps = createDeps({
      input: makeInput("\r"),
      keyringProvider: { retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)) },
      deriveKey,
      readPassphrase,
      writeConfig,
    });
    await runChangeModel(deps);
    expect(deriveKey).not.toHaveBeenCalled();
    expect(readPassphrase).not.toHaveBeenCalled();
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "claude-sonnet-4");
  });

  it("happy path with passphrase (keyring null)", async () => {
    const writeConfig = vi.fn();
    const deps = createDeps({
      input: makeInput("\r"),
      keyringProvider: { retrieve: vi.fn().mockReturnValue(null) },
      readPassphrase: vi.fn().mockResolvedValue("mypassword"),
      deriveKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
      writeConfig,
    });
    await runChangeModel(deps);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), "claude-sonnet-4");
  });
});
