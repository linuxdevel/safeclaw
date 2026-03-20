# `safeclaw changemodel` — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Add a `safeclaw changemodel` CLI command that fetches the live list of models available via the GitHub Copilot API, presents them in an interactive arrow-key selector with a conversational/non-conversational label per model, and writes the chosen model to `~/.safeclaw/safeclaw.json`.

---

## Architecture

### 1. `listCopilotModelsFromApi(copilotToken)` — `packages/core/src/copilot/models.ts`

New exported function alongside the existing `listCopilotModels`.

```
GET https://api.githubcopilot.com/models
Authorization: Bearer <copilot_token>
```

The `Bearer` scheme matches what `CopilotClient` uses for all other Copilot API calls.

**Raw API response shape** (type-guarded internally):

```typescript
interface RawModelEntry {
  id: string;
  name: string;
  capabilities?: {
    type?: string; // e.g. "chat", "completions"
  };
}

interface RawModelsResponse {
  data: RawModelEntry[];
}
```

**Return type:** `CopilotModelInfo[] | null`

```typescript
export interface CopilotModelInfo {
  id: string;
  name: string;
  /**
   * true when capabilities.type === "chat".
   * false for "completions", any other value, or missing capabilities.
   * Conservative: unknown types are treated as non-conversational.
   */
  conversational: boolean;
}
```

- Returns `null` on any fetch error, non-ok HTTP response, or empty `data` array.
- An empty `data` array returns `null` — so the selector is **never invoked with zero items**.
- `CopilotModelInfo` must be barrel-exported from `packages/core/src/copilot/index.ts` using
  `export type { CopilotModelInfo }` (required by `verbatimModuleSyntax`).

### 2. `packages/cli/src/commands/change-model.ts`

Self-contained command module. All dependencies injected for testability.

**Options interface:**

```typescript
export interface ChangeModelOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  /**
   * Path to safeclaw.json.
   * Defaults to: path.join(path.dirname(vaultPath), "safeclaw.json")
   * Note: bootstrap.ts uses vaultPath.replace(/vault\.json$/, "safeclaw.json") instead.
   * Both produce the same result for the standard ~/.safeclaw/vault.json path.
   * The dirname approach is safer for non-standard paths (no silent no-op on mismatch).
   * bootstrap.ts is NOT updated as part of this spec — the inconsistency is accepted
   * since both commands are always called with the same standard vaultPath from cli.ts.
   */
  configPath?: string;
  // Injectable for testing — field names match BootstrapDeps conventions
  existsSync?: (path: string) => boolean;           // checks vault and salt file existence
  /**
   * Reads the salt file during key derivation.
   * Also forwarded to loadConfig as ConfigLoaderDeps.readFileSync so that
   * tests can control config file reads through this single injectable.
   */
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  openVault?: (path: string, key: Buffer) => { get(name: string): string | undefined };
  /**
   * Narrowed to retrieve-only — changemodel never writes to the keyring.
   * DefaultKeyringProvider (which also has store) satisfies this interface.
   */
  keyringProvider?: { retrieve(): Buffer | null };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  readPassphrase?: (
    prompt: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => Promise<string>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  listModels?: (copilotToken: string) => Promise<CopilotModelInfo[] | null>;
  /**
   * Injectable for loadConfig — matches bootstrap.ts pattern.
   * Default: defaultLoadConfig from @safeclaw/core.
   * Injected in tests to simulate corrupt/invalid config without filesystem.
   * Note: OnboardOptions also has listModels but wraps listCopilotModels (no auth);
   * this one wraps listCopilotModelsFromApi (requires token) — different functions,
   * same injectable name.
   */
  loadConfig?: (configPath: string) => ReturnType<typeof defaultLoadConfig>;
  /**
   * Writes the chosen model id into the config file.
   * The default is a top-level named function `defaultWriteConfig` defined outside
   * runChangeModel (not a closure). It imports its own readFileSync/writeFileSync
   * from "node:fs" — it does NOT use the ChangeModelOptions.readFileSync injectable.
   * Tests inject writeConfig directly and bypass defaultWriteConfig entirely.
   *
   * Behaviour: read raw JSON if file exists (uses its own fs.existsSync check),
   * else start with {}; set "model" key; write back with mode 0o644.
   * safeclaw.json is non-secret (model name only) — 0o644 is intentional and
   * differs from vault.json (0o600).
   */
  writeConfig?: (configPath: string, model: string) => void;
}

export async function runChangeModel(options: ChangeModelOptions): Promise<void>
```

**Execution order** (mirrors bootstrap.ts):
1. Resolve key (keyring or passphrase).
2. Open vault.
3. Call `loadConfig(configPath)` — **wrap all errors** (read I/O, JSON parse, schema validation) in a catch block that re-throws as `"Config file is invalid: <underlying message>"`. Surfaces corrupt-config errors before the user sees the selector.
4. Get `github_token` from vault.
5. Call `getCopilotToken(githubToken)` — wrap all errors as `"GitHub token expired. Run 'safeclaw onboard' to re-authenticate."`.
6. Call `listModels(copilotToken.token)` — wrap null return as `"Could not reach Copilot API…"`.
7. Run arrow-key selector.
8. Call `writeConfig(configPath, chosen.id)`.
9. Print `"Model changed to <chosen.id>."` to `output` — in `runChangeModel`, **not** inside `writeConfig`, so the message is always visible to tests via the injected output stream.

**Ctrl+C:** `runChangeModel` returns normally. `main()` exits 0.

**Flow:**

```
vault.json ──► resolveKey ──► openVault ──► loadConfig (corrupt check)
                                               │
                                          github_token
                                               │
                                               ▼
                                  getCopilotToken(githubToken)
                                               │  copilotToken.token (string)
                                               ▼
                                     listModels(token)  ──► CopilotModelInfo[]
                                                                    │
                                                                    ▼
                                                          arrow-key selector
                                                                    │ chosen.id
                                                                    ▼
                                                  writeConfig(configPath, chosen.id)
                                                  output: "Model changed to <id>."
```

### 3. Arrow-key selector (inline in `change-model.ts`)

Not a separate utility — only one caller.

- Sets stdin to raw mode: `(input as NodeJS.ReadStream).setRawMode?.(true)`. The `?.` is required because injected test streams have no `setRawMode`. Wrapped in try/finally to guarantee restore.
- **Limitation:** ANSI cursor-up sequences are always emitted. In non-TTY environments (pipes, redirected output) these appear as literal escape codes. This is accepted — the command is inherently interactive.
- **No header line** before the list. N = number of model rows exactly.
- Initial render: print all N rows.
- **Redraw on each keypress:** emit `\x1b[${N}A`, then overwrite all N rows in-place.
- Each row: `> claude-sonnet-4    [chat]` or `  gpt-5.3-codex    [completion]`
  - `[chat]` when `conversational === true`; `[completion]` when `false`
- Raw byte sequences:
  - **Up:** `\x1b[A` — move selection up, wrap index 0 → last
  - **Down:** `\x1b[B` — move selection down, wrap last → index 0
  - **Enter:** `\r` — confirm, restore raw mode, return chosen id
  - **Ctrl+C:** `\x03` — restore raw mode, print `Cancelled.`, return normally
- Single-model list: Up/Down are no-ops, Enter confirms. No crash.

### 4. `cli.ts` wiring

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

Both `"changemodel"` and `"change-model"` are accepted (two `case` labels). `printUsage()` gains:
`  changemodel       Change the active model`

### 5. `safeclaw.json` write

`defaultWriteConfig(configPath, model)`:
1. Check existence with its own `fs.existsSync` (not the injected one — tests bypass via writeConfig injectable).
2. If exists: read raw JSON, parse. Throw `"Config file is invalid: …"` on bad JSON.
3. If not: start with `{}`.
4. Set `"model"` key.
5. `writeFileSync(..., { mode: 0o644 })`. Throw `"Failed to write config: …"` on error.

---

## Error Handling

All errors thrown. `main().catch` prepends `"Fatal error: "` before printing to stderr and exiting 1.

| Situation | Error message thrown |
|---|---|
| Vault not found | `Vault not found. Run 'safeclaw onboard' to complete setup.` |
| No `github_token` in vault | `No github_token in vault. Run 'safeclaw onboard' to authenticate.` |
| Keyring null + salt file missing | `Cannot unlock vault: keyring unavailable and no salt file found. Run 'safeclaw onboard' again.` |
| Wrong / corrupt passphrase | `Failed to unlock vault: <underlying message>. Run 'safeclaw onboard' to reset.` |
| Copilot token exchange fails (any) | `GitHub token expired. Run 'safeclaw onboard' to re-authenticate.` |
| `/models` fetch error or null | `Could not reach Copilot API. Check your connection and try again, or run 'safeclaw onboard'.` |
| `safeclaw.json` any error (read, JSON, schema) | `Config file is invalid: <underlying message>. Fix or delete ~/.safeclaw/safeclaw.json and try again.` |
| `safeclaw.json` write I/O error | `Failed to write config: <underlying message>.` |
| Ctrl+C | prints `Cancelled.`, returns normally |

---

## Testing

All tests in `packages/cli/src/commands/change-model.test.ts` with fully injected dependencies.

Output assertions check raw bytes from an injected `PassThrough` stream. ANSI escape sequences appear as literal characters — use `string.includes()` checks, no stripping needed.

**`change-model.test.ts`:**
- Happy path (keyring): `keyringProvider.retrieve()` returns a key → `\r` → `writeConfig` called with first model's id; output includes `"Model changed to"`
- Happy path (passphrase): keyring null → passphrase prompted → vault opens → `writeConfig` called correctly
- No vault (`existsSync` false for vault path) → throws "Vault not found"
- No `github_token` (`openVault.get` returns undefined) → throws "No github_token in vault"
- Keyring null + salt file missing (`existsSync` false for salt path) → throws "Cannot unlock vault"
- Wrong passphrase (`openVault` throws) → throws "Failed to unlock vault"
- Copilot token exchange fails → throws "GitHub token expired"
- `listModels` returns null → throws "Could not reach Copilot API"
- Corrupt `safeclaw.json`: inject `loadConfig` that throws → throws "Config file is invalid" *(tests the loadConfig path, not writeConfig)*
- Write I/O error: inject `writeConfig` that throws → throws "Failed to write config"
- Ctrl+C (`\x03`) → `writeConfig` never called, function returns normally
- Arrow Down (`\x1b[B`) × 2 then Enter (`\r`) → `writeConfig` called with 3rd model's id
- Arrow Up (`\x1b[A`) from index 0 → wraps to last; Enter → `writeConfig` called with last model's id
- Arrow Down from last item → wraps to index 0
- Single-model list: `\r` immediately → that model selected, no crash
- Rendering: push `\r` immediately, assert output includes `[chat]` and `[completion]` labels, `>` on selected row, `"Model changed to"` success message

**`models.test.ts` additions (for `listCopilotModelsFromApi`):**
- Mix of `"chat"` and `"completions"` → correct `conversational` flags
- Unknown `capabilities.type` (e.g. `"embeddings"`) → `conversational: false`
- Missing `capabilities` → `conversational: false`
- Non-ok HTTP response → null
- Network error (fetch throws) → null
- Empty `data` array → null
