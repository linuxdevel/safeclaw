# `safeclaw changemodel` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `safeclaw changemodel` — an interactive arrow-key model picker that fetches the live Copilot model list, labels each model as `[chat]` or `[completion]`, and writes the chosen model to `~/.safeclaw/safeclaw.json`.

**Architecture:** New `listCopilotModelsFromApi()` in `@safeclaw/core` queries `GET https://api.githubcopilot.com/models` and returns typed `CopilotModelInfo[]`. New `packages/cli/src/commands/change-model.ts` opens the vault (reusing the `resolveKey` pattern from `bootstrap.ts`), exchanges the GitHub token for a Copilot token, fetches models, runs a raw-mode arrow-key selector, then writes the chosen model to `safeclaw.json` via a read-modify-write on the raw JSON.

**Tech Stack:** Node.js 22, TypeScript strict/ESM, Vitest, ANSI escape sequences for cursor movement.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `packages/core/src/copilot/models.ts` | Modify | Add `listCopilotModelsFromApi()` and `CopilotModelInfo` |
| `packages/core/src/copilot/models.test.ts` | Modify | Add tests for `listCopilotModelsFromApi` |
| `packages/core/src/copilot/index.ts` | Modify | Barrel-export `listCopilotModelsFromApi` and `CopilotModelInfo` |
| `packages/cli/src/commands/change-model.ts` | Create | Full command: vault open, token exchange, selector, write |
| `packages/cli/src/commands/change-model.test.ts` | Create | All tests for `runChangeModel` |
| `packages/cli/src/cli.ts` | Modify | Add `changemodel`/`change-model` cases and usage line |

Note: `packages/core/src/index.ts` uses `export * from "./copilot/index.js"` which automatically re-exports everything added to the copilot barrel — **no changes needed there**.

---

## Task 1: `listCopilotModelsFromApi` and `CopilotModelInfo`

**Files:**
- Modify: `packages/core/src/copilot/models.ts`
- Modify: `packages/core/src/copilot/models.test.ts`

- [ ] **Step 1.1 — Write the failing tests**

The existing `models.test.ts` already imports `listCopilotModels` on line 2. **Modify** that line to also import the new function, and add a `CopilotModelInfo` type import:

```typescript
// Replace the existing line 2:
import { listCopilotModels, listCopilotModelsFromApi } from "./models.js";
import type { CopilotModelInfo } from "./models.js";
```

Then append a new `describe` block at the bottom of the file (after the closing `}` of the existing `listCopilotModels` describe):

```typescript
describe("listCopilotModelsFromApi", () => {
  it("returns chat and completion models with correct conversational flag", async () => {
    const apiResponse = {
      data: [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", capabilities: { type: "chat" } },
        { id: "gpt-5.3-codex", name: "GPT Codex", capabilities: { type: "completions" } },
        { id: "gpt-4.1", name: "GPT-4.1", capabilities: { type: "chat" } },
      ],
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(apiResponse),
    } as Response);

    const result = await listCopilotModelsFromApi("test-copilot-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-copilot-token",
        }),
      }),
    );
    expect(result).toEqual<CopilotModelInfo[]>([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", conversational: true },
      { id: "gpt-5.3-codex", name: "GPT Codex", conversational: false },
      { id: "gpt-4.1", name: "GPT-4.1", conversational: true },
    ]);
  });

  it("treats unknown capabilities.type as non-conversational", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: "embed-1", name: "Embeddings", capabilities: { type: "embeddings" } }],
      }),
    } as Response);
    const result = await listCopilotModelsFromApi("tok");
    expect(result).toEqual([{ id: "embed-1", name: "Embeddings", conversational: false }]);
  });

  it("treats missing capabilities as non-conversational", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "mystery", name: "Mystery" }] }),
    } as Response);
    const result = await listCopilotModelsFromApi("tok");
    expect(result).toEqual([{ id: "mystery", name: "Mystery", conversational: false }]);
  });

  it("returns null on non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });

  it("returns null on empty data array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    } as Response);
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });
});
```

- [ ] **Step 1.2 — Run to verify failures**

```bash
cd /home/abols/github/safeclaw
pnpm test packages/core/src/copilot/models.test.ts 2>&1 | tail -20
```

Expected: errors — `listCopilotModelsFromApi` not exported, `CopilotModelInfo` not found.

- [ ] **Step 1.3 — Implement `CopilotModelInfo` and `listCopilotModelsFromApi` in `models.ts`**

First, add `COPILOT_API_BASE` to the existing import in `models.ts`. The file currently has no imports. Add at the very top:

```typescript
import { COPILOT_API_BASE } from "./types.js";
```

Then append after the existing `listCopilotModels` function:

```typescript
export interface CopilotModelInfo {
  id: string;
  name: string;
  /**
   * true when capabilities.type === "chat".
   * false for "completions", any other value, or missing capabilities.
   */
  conversational: boolean;
}

interface RawModelEntry {
  id: string;
  name: string;
  capabilities?: {
    type?: string;
  };
}

interface RawModelsResponse {
  data: RawModelEntry[];
}

/**
 * Fetch the list of models from the authenticated Copilot API.
 *
 * Requires a short-lived Copilot API token (not the GitHub OAuth token).
 * Returns null on any error or if the list is empty.
 */
export async function listCopilotModelsFromApi(
  copilotToken: string,
): Promise<CopilotModelInfo[] | null> {
  try {
    const response = await fetch(`${COPILOT_API_BASE}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as RawModelsResponse;

    if (!Array.isArray(body.data) || body.data.length === 0) {
      return null;
    }

    return body.data.map((entry) => ({
      id: entry.id,
      name: entry.name,
      conversational: entry.capabilities?.type === "chat",
    }));
  } catch {
    return null;
  }
}
```

- [ ] **Step 1.4 — Run tests to verify they pass**

```bash
pnpm test packages/core/src/copilot/models.test.ts 2>&1 | tail -10
```

Expected: all tests pass (existing 5 + 6 new = 11 total).

- [ ] **Step 1.5 — Update barrel export in `copilot/index.ts`**

In `packages/core/src/copilot/index.ts`, add after the `export { listCopilotModels }` line:

```typescript
export { listCopilotModelsFromApi } from "./models.js";
export type { CopilotModelInfo } from "./models.js";
```

(`export type` is required by `verbatimModuleSyntax` for interface re-exports.)

`packages/core/src/index.ts` already uses `export * from "./copilot/index.js"` — **no changes needed there**.

- [ ] **Step 1.6 — Typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: no errors.

- [ ] **Step 1.7 — Commit**

```bash
git add packages/core/src/copilot/models.ts \
        packages/core/src/copilot/models.test.ts \
        packages/core/src/copilot/index.ts
git commit --no-gpg-sign -m "feat(core): add listCopilotModelsFromApi and CopilotModelInfo"
```

---

## Task 2: `change-model.ts` — scaffold, vault resolution, error paths

**Files:**
- Create: `packages/cli/src/commands/change-model.ts`
- Create: `packages/cli/src/commands/change-model.test.ts`

This task builds the vault-open path and tests all error cases. The selector is a placeholder here and is replaced in Task 3.

- [ ] **Step 2.1 — Write the failing error-path tests**

Create `packages/cli/src/commands/change-model.test.ts`:

```typescript
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
```

- [ ] **Step 2.2 — Run to verify failures**

```bash
pnpm test packages/cli/src/commands/change-model.test.ts 2>&1 | tail -15
```

Expected: cannot find module `./change-model.js`.

- [ ] **Step 2.3 — Create `change-model.ts`**

Create `packages/cli/src/commands/change-model.ts`:

```typescript
import { join, dirname } from "node:path";
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  writeFileSync,
} from "node:fs";
import {
  getCopilotToken as defaultGetCopilotToken,
  loadConfig as defaultLoadConfig,
  listCopilotModelsFromApi as defaultListModels,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModelInfo } from "@safeclaw/core";
import {
  KeyringProvider as DefaultKeyringProvider,
  deriveKeyFromPassphrase as defaultDeriveKey,
  Vault,
} from "@safeclaw/vault";
import { readPassphrase as defaultReadPassphrase } from "../readPassphrase.js";

export interface ChangeModelOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  /** Defaults to path.join(path.dirname(vaultPath), "safeclaw.json"). */
  configPath?: string;
  existsSync?: (path: string) => boolean;
  /** Reads salt file during key derivation; also forwarded to loadConfig. */
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  openVault?: (path: string, key: Buffer) => { get(name: string): string | undefined };
  /** Narrowed to retrieve-only — changemodel never writes to the keyring. */
  keyringProvider?: { retrieve(): Buffer | null };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  readPassphrase?: (
    prompt: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => Promise<string>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  listModels?: (copilotToken: string) => Promise<CopilotModelInfo[] | null>;
  /** Injectable for loadConfig — lets tests simulate corrupt config. */
  loadConfig?: (configPath: string) => ReturnType<typeof defaultLoadConfig>;
  /** Writes the chosen model into safeclaw.json. Default: defaultWriteConfig. */
  writeConfig?: (configPath: string, model: string) => void;
}

/**
 * Top-level named function (not a closure) so it can be the default injectable.
 * Uses its own fs imports — does NOT use the ChangeModelOptions.readFileSync injectable.
 * Tests inject writeConfig directly and never call this.
 */
export function defaultWriteConfig(configPath: string, model: string): void {
  let raw: Record<string, unknown> = {};
  if (defaultExistsSync(configPath)) {
    try {
      raw = JSON.parse(defaultReadFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Config file is invalid: ${err instanceof Error ? err.message : String(err)}. Fix or delete ${configPath} and try again.`,
      );
    }
  }
  raw["model"] = model;
  try {
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o644 });
  } catch (err) {
    throw new Error(
      `Failed to write config: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

/** Sentinel to distinguish "cannot unlock" errors from other vault errors. */
class CannotUnlockError extends Error {}

async function resolveKey(
  vaultPath: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  exists: (p: string) => boolean,
  readFile: (p: string, enc: BufferEncoding) => string,
  keyringProvider: { retrieve(): Buffer | null },
  deriveKey: (passphrase: string, salt?: Buffer) => Promise<Buffer>,
  readPass: (prompt: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => Promise<string>,
): Promise<Buffer> {
  const key = keyringProvider.retrieve();
  if (key) return key;

  const saltPath = vaultPath + ".salt";
  if (!exists(saltPath)) {
    throw new CannotUnlockError(
      "Cannot unlock vault: keyring unavailable and no salt file found. Run 'safeclaw onboard' again.",
    );
  }

  const saltHex = readFile(saltPath, "utf8").trim();
  const salt = Buffer.from(saltHex, "hex");
  const passphrase = await readPass("Enter vault passphrase: ", input, output);
  return deriveKey(passphrase, salt);
}

// Selector placeholder — replaced in Task 3.
async function runSelector(
  models: CopilotModelInfo[],
  _input: NodeJS.ReadableStream,
  _output: NodeJS.WritableStream,
): Promise<CopilotModelInfo | null> {
  return models[0] ?? null;
}

export async function runChangeModel(options: ChangeModelOptions): Promise<void> {
  const {
    input,
    output,
    vaultPath,
    existsSync: exists = defaultExistsSync,
    readFileSync: readFile = (p, enc) => defaultReadFileSync(p, enc) as string,
    openVault = (p, k) => Vault.open(p, k),
    keyringProvider = new DefaultKeyringProvider(),
    deriveKey = defaultDeriveKey,
    readPassphrase: readPass = defaultReadPassphrase,
    getCopilotToken: exchangeToken = defaultGetCopilotToken,
    listModels = defaultListModels,
    loadConfig = defaultLoadConfig,
    writeConfig = defaultWriteConfig,
  } = options;

  const configPath = options.configPath ?? join(dirname(vaultPath), "safeclaw.json");

  // 1. Vault exists?
  if (!exists(vaultPath)) {
    throw new Error("Vault not found. Run 'safeclaw onboard' to complete setup.");
  }

  // 2. Resolve encryption key and open vault
  let vault: { get(name: string): string | undefined };
  try {
    const key = await resolveKey(vaultPath, input, output, exists, readFile, keyringProvider, deriveKey, readPass);
    vault = openVault(vaultPath, key);
  } catch (err) {
    if (err instanceof CannotUnlockError) throw err;
    throw new Error(
      `Failed to unlock vault: ${err instanceof Error ? err.message : String(err)}. Run 'safeclaw onboard' to reset.`,
    );
  }

  // 3. Fail fast on corrupt config
  try {
    loadConfig(configPath);
  } catch (err) {
    throw new Error(
      `Config file is invalid: ${err instanceof Error ? err.message : String(err)}. Fix or delete ~/.safeclaw/safeclaw.json and try again.`,
    );
  }

  // 4. Get GitHub token
  const githubToken = vault.get("github_token");
  if (!githubToken) {
    throw new Error("No github_token in vault. Run 'safeclaw onboard' to authenticate.");
  }

  // 5. Exchange for Copilot token
  let copilotToken: CopilotToken;
  try {
    copilotToken = await exchangeToken(githubToken);
  } catch {
    throw new Error("GitHub token expired. Run 'safeclaw onboard' to re-authenticate.");
  }

  // 6. Fetch model list
  const models = await listModels(copilotToken.token);
  if (!models) {
    throw new Error(
      "Could not reach Copilot API. Check your connection and try again, or run 'safeclaw onboard'.",
    );
  }

  // 7. Interactive selector (placeholder — replaced in Task 3)
  const chosen = await runSelector(models, input, output);
  if (!chosen) return; // Ctrl+C — exit cleanly

  // 8. Write config
  try {
    writeConfig(configPath, chosen.id);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith("Failed to write config") ||
        err.message.startsWith("Config file is invalid"))
    ) {
      throw err;
    }
    throw new Error(`Failed to write config: ${err instanceof Error ? err.message : String(err)}.`);
  }

  // 9. Confirm
  output.write(`Model changed to ${chosen.id}.\n`);
}
```

- [ ] **Step 2.4 — Run tests to verify they pass**

```bash
pnpm test packages/cli/src/commands/change-model.test.ts 2>&1 | tail -15
```

Expected: all 8 error-path tests pass.

- [ ] **Step 2.5 — Typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: no errors.

- [ ] **Step 2.6 — Commit**

```bash
git add packages/cli/src/commands/change-model.ts \
        packages/cli/src/commands/change-model.test.ts
git commit --no-gpg-sign -m "feat(cli): add change-model command scaffold with vault/error paths"
```

---

## Task 3: Arrow-key selector

**Files:**
- Modify: `packages/cli/src/commands/change-model.ts`
- Modify: `packages/cli/src/commands/change-model.test.ts`

- [ ] **Step 3.1 — Write the failing selector tests**

Add to the `describe("runChangeModel", ...)` block in `change-model.test.ts`:

```typescript
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
```

- [ ] **Step 3.2 — Run to verify failures**

```bash
pnpm test packages/cli/src/commands/change-model.test.ts 2>&1 | grep -E "✓|×|FAIL|PASS" | head -30
```

Expected: the new navigation tests fail (placeholder always picks `models[0]`).

- [ ] **Step 3.3 — Replace the selector placeholder with the real implementation**

In `change-model.ts`, replace the entire `runSelector` function (the placeholder) with:

```typescript
async function runSelector(
  models: CopilotModelInfo[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<CopilotModelInfo | null> {
  const n = models.length;
  let index = 0;

  const renderRow = (i: number): string => {
    const m = models[i];
    if (!m) return "";
    const label = m.conversational ? "[chat]" : "[completion]";
    const prefix = i === index ? "> " : "  ";
    return `${prefix}${m.id}    ${label}\n`;
  };

  const renderAll = (): string => models.map((_, i) => renderRow(i)).join("");

  // Initial render
  output.write(renderAll());

  return new Promise<CopilotModelInfo | null>((resolve) => {
    (input as NodeJS.ReadStream).setRawMode?.(true);

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString("utf8");
      let i = 0;

      while (i < str.length) {
        // Up arrow: ESC [ A
        if (str[i] === "\x1b" && str[i + 1] === "[" && str[i + 2] === "A") {
          index = (index - 1 + n) % n;
          i += 3;
          output.write(`\x1b[${n}A`);
          output.write(renderAll());
          continue;
        }
        // Down arrow: ESC [ B
        if (str[i] === "\x1b" && str[i + 1] === "[" && str[i + 2] === "B") {
          index = (index + 1) % n;
          i += 3;
          output.write(`\x1b[${n}A`);
          output.write(renderAll());
          continue;
        }
        // Enter
        if (str[i] === "\r") {
          cleanup();
          resolve(models[index] ?? null);
          return;
        }
        // Ctrl+C
        if (str[i] === "\x03") {
          cleanup();
          output.write("Cancelled.\n");
          resolve(null);
          return;
        }
        i++;
      }
    };

    const cleanup = (): void => {
      input.removeListener("data", onData);
      (input as NodeJS.ReadStream).setRawMode?.(false);
    };

    // Attach listener first, then resume — ensures no data events are missed.
    input.on("data", onData);
    (input as NodeJS.ReadableStream & { resume(): void }).resume();
  });
}
```

- [ ] **Step 3.4 — Run all tests**

```bash
pnpm test packages/cli/src/commands/change-model.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 3.5 — Full suite**

```bash
pnpm test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 3.6 — Commit**

```bash
git add packages/cli/src/commands/change-model.ts \
        packages/cli/src/commands/change-model.test.ts
git commit --no-gpg-sign -m "feat(cli): implement arrow-key model selector in change-model"
```

---

## Task 4: Wire `changemodel` into `cli.ts`

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 4.1 — Add the import**

Add alongside the other command imports (after the `runOnboarding` import):

```typescript
import { runChangeModel } from "./commands/change-model.js";
```

- [ ] **Step 4.2 — Add the wrapper function**

Add after the existing `runOnboard()` function:

```typescript
async function runChangeModelCommand(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");
  await runChangeModel({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });
}
```

- [ ] **Step 4.3 — Add cases to the switch**

In `main()`, after the `case "onboard":` block:

```typescript
    case "changemodel":
    case "change-model":
      await runChangeModelCommand();
      break;
```

- [ ] **Step 4.4 — Update `printUsage`**

In `printUsage()`, the `lines` array currently has `"  onboard           Run the onboarding wizard"` followed by `"  audit [--json]…"`. Insert between them:

```typescript
    "  changemodel       Change the active model",
```

So the lines become:
```typescript
    "  chat              Start an interactive chat session (default)",
    "  onboard           Run the onboarding wizard",
    "  changemodel       Change the active model",
    "  audit [--json]    Run a security audit of the running instance",
```

- [ ] **Step 4.5 — Typecheck and full test run**

```bash
pnpm typecheck 2>&1 && pnpm test 2>&1 | tail -5
```

Expected: no type errors, all tests pass.

- [ ] **Step 4.6 — Commit**

```bash
git add packages/cli/src/cli.ts
git commit --no-gpg-sign -m "feat(cli): wire changemodel command into cli.ts"
```

---

## Task 5: Build and smoke test

- [ ] **Step 5.1 — Build**

```bash
pnpm build 2>&1 | tail -5
```

Expected: clean build, no errors.

- [ ] **Step 5.2 — Verify help output**

```bash
node packages/cli/dist/cli.js help | grep changemodel
```

Expected: `  changemodel       Change the active model`

- [ ] **Step 5.3 — Final full test run**

```bash
pnpm test 2>&1 | tail -5
```

Expected: all tests pass.
