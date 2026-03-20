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

**Return type:** `CopilotModelInfo[] | null`

```typescript
export interface CopilotModelInfo {
  id: string;
  name: string;
  conversational: boolean; // derived from capabilities.type === "chat"
}
```

- Returns `null` on any fetch error, non-ok response, or empty model list.
- `conversational` is `true` when `capabilities.type === "chat"`, `false` otherwise (e.g. `"completions"`).
- `CopilotModelInfo` is exported from `packages/core/src/copilot/index.ts`.

### 2. `packages/cli/src/commands/change-model.ts`

Self-contained command module. Injectable dependencies for testing (vault open, token exchange, model fetch, config read/write, stdin/stdout).

**Flow:**

```
vault.json ──► github_token
                 │
                 ▼
           getCopilotToken()  ──► copilot_token
                                       │
                                       ▼
                             listCopilotModelsFromApi()  ──► CopilotModelInfo[]
                                                                    │
                                                                    ▼
                                                          arrow-key selector
                                                                    │
                                                                    ▼
                                                     ~/.safeclaw/safeclaw.json
                                                       { "model": chosen_id }
```

**Signature:**

```typescript
export interface ChangeModelOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  configPath?: string;
  // Injectable for testing
  openVault?: (path: string, key: Buffer) => { get(name: string): string | undefined };
  keyringProvider?: { retrieve(): Buffer | null };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  readPassphrase?: (...) => Promise<string>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  listModels?: (copilotToken: string) => Promise<CopilotModelInfo[] | null>;
  readConfig?: (path: string) => SafeClawConfig;
  writeConfig?: (path: string, config: SafeClawConfig) => void;
  existsSync?: (path: string) => boolean;
}

export async function runChangeModel(options: ChangeModelOptions): Promise<void>
```

### 3. Arrow-key selector (inline in `change-model.ts`)

No separate file — only one caller.

- Sets stdin to raw mode (`setRawMode(true)`).
- Renders the model list; current row is highlighted (ANSI inverse video or `>` prefix).
- Each row: `  claude-sonnet-4    [conversational]` or `  gpt-5.3-codex    [completion]`
- **Up/Down** — move cursor, wraps at boundaries.
- **Enter** — confirm selection.
- **Ctrl+C** — abort, print `Cancelled.`, restore terminal, exit 0 without writing.
- Restores raw mode off on exit (finally block).

**Injectable for testing:** accepts a fake readable stream instead of real stdin, so arrow-key sequences can be pushed programmatically.

### 4. `cli.ts` wiring

- New `case "changemodel":` in the `switch` block → calls `runChangeModel(...)`.
- Added to `printUsage()`:
  `  changemodel       Change the active model`

### 5. `safeclaw.json` write

- Read existing file if present (parse JSON), otherwise start with `{}`.
- Set `model` key to chosen ID; leave all other keys untouched.
- Write back with `writeFileSync(..., { mode: 0o644 })`.
- Print: `Model changed to <id>.`

---

## Error Handling

| Situation | Output | Exit |
|---|---|---|
| Vault not found | `Vault not found. Run 'safeclaw onboard' first.` | 1 |
| Copilot token exchange fails (401/403) | `GitHub token expired. Run 'safeclaw onboard' to re-authenticate.` | 1 |
| `/models` fetch error or empty list | `Could not reach Copilot API. Check your connection and try again, or run 'safeclaw onboard'.` | 1 |
| Ctrl+C in selector | `Cancelled.` | 0, no write |

---

## Testing

All tests in `packages/cli/src/commands/change-model.test.ts` with fully injected dependencies (no real vault, network, or filesystem).

**`change-model.test.ts`:**
- Happy path: valid vault → API returns models → user selects (Enter on first) → `safeclaw.json` written
- Preserves existing `safeclaw.json` fields (e.g. `systemPrompt`) when writing model
- No vault → error message, process exit 1
- Copilot token exchange fails → error message, exit 1
- `listModels` returns null → error message, exit 1
- Ctrl+C in selector → no write, exit 0
- Arrow Down × 2 then Enter → index 2 selected
- Arrow Up wraps from top to bottom of list
- Arrow Down wraps from bottom to top of list

**`models.test.ts` additions:**
- `listCopilotModelsFromApi` happy path: response with mix of `"chat"` and `"completions"` models → correct `conversational` flags
- Non-ok HTTP response → returns null
- Network error (fetch throws) → returns null
- Empty `data` array → returns null
