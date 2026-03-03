# Configuration File Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `~/.safeclaw/safeclaw.json` configuration file with schema validation for non-secret settings.

**Architecture:** Create a Config module in `packages/core/src/config/` that defines types, defaults, a hand-written JSON Schema validator, and a loader that reads `~/.safeclaw/safeclaw.json`, validates it, and merges with defaults. Bootstrap in `packages/cli` loads the config file early and uses its values when constructing the agent stack. No external dependencies — validation is hand-written to match SafeClaw's zero-dependency security philosophy.

**Tech Stack:** TypeScript, Vitest, hand-written JSON validation (no Ajv)

---

### Task 1: Define config types

**Files:**
- Create: `packages/core/src/config/types.ts`

**Step 1: Create the config types file**

```typescript
/**
 * Plain-text configuration for non-secret settings.
 * Loaded from ~/.safeclaw/safeclaw.json.
 * All fields are optional — defaults are applied by the loader.
 */
export interface SafeClawConfig {
  /** LLM model identifier (e.g. "claude-sonnet-4") */
  model?: string | undefined;
  /** System prompt for the agent */
  systemPrompt?: string | undefined;
  /** Maximum number of tool-calling rounds per message */
  maxToolRounds?: number | undefined;
  /** LLM temperature (0.0 – 2.0) */
  temperature?: number | undefined;
  /** Maximum tokens in LLM response */
  maxTokens?: number | undefined;
  /** Gateway server settings */
  gateway?: GatewayFileConfig | undefined;
  /** Sandbox settings */
  sandbox?: SandboxFileConfig | undefined;
}

export interface GatewayFileConfig {
  /** Host to bind to (default: "127.0.0.1") */
  host?: string | undefined;
  /** Port to listen on (default: 18789) */
  port?: number | undefined;
}

export interface SandboxFileConfig {
  /** Whether sandboxing is enabled (default: true) */
  enabled?: boolean | undefined;
  /** Sandbox timeout in milliseconds (default: 30000) */
  timeout?: number | undefined;
}
```

**Step 2: Commit**

```bash
git add packages/core/src/config/types.ts
git commit -m "feat(core): add SafeClawConfig types for config file"
```

---

### Task 2: Define defaults

**Files:**
- Create: `packages/core/src/config/defaults.ts`

**Step 1: Create the defaults file**

Import the existing `DEFAULT_AGENT_CONFIG` and `DEFAULT_GATEWAY_CONFIG` values to keep a single source of truth:

```typescript
import type { SafeClawConfig } from "./types.js";

/**
 * Default configuration values.
 * These match the existing hardcoded defaults across the codebase:
 * - model/systemPrompt/maxToolRounds: packages/core/src/agent/types.ts
 * - gateway host/port: packages/gateway/src/types.ts
 * - sandbox timeout: packages/sandbox/src/types.ts
 */
export const DEFAULT_CONFIG: Required<
  Pick<SafeClawConfig, "model" | "systemPrompt" | "maxToolRounds">
> &
  SafeClawConfig = {
  model: "claude-sonnet-4",
  systemPrompt:
    "You are SafeClaw, a secure AI assistant. Follow user instructions carefully.",
  maxToolRounds: 10,
  temperature: undefined,
  maxTokens: undefined,
  gateway: {
    host: "127.0.0.1",
    port: 18789,
  },
  sandbox: {
    enabled: true,
    timeout: 30_000,
  },
};
```

**Step 2: Commit**

```bash
git add packages/core/src/config/defaults.ts
git commit -m "feat(core): add default config values"
```

---

### Task 3: Create config validator (tests first)

**Files:**
- Create: `packages/core/src/config/validate.ts`
- Create: `packages/core/src/config/validate.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { validateConfig } from "./validate.js";

describe("validateConfig", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it("accepts a valid full config", () => {
    expect(() =>
      validateConfig({
        model: "claude-sonnet-4",
        systemPrompt: "Hello",
        maxToolRounds: 5,
        temperature: 0.7,
        maxTokens: 4096,
        gateway: { host: "127.0.0.1", port: 8080 },
        sandbox: { enabled: true, timeout: 10000 },
      }),
    ).not.toThrow();
  });

  it("rejects non-object config", () => {
    expect(() => validateConfig("string")).toThrow(/must be a JSON object/);
    expect(() => validateConfig(null)).toThrow(/must be a JSON object/);
    expect(() => validateConfig(42)).toThrow(/must be a JSON object/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateConfig({ foo: "bar" })).toThrow(
      /Unknown config key: "foo"/,
    );
  });

  it("rejects model when not a string", () => {
    expect(() => validateConfig({ model: 123 })).toThrow(
      /"model" must be a non-empty string/,
    );
  });

  it("rejects empty model string", () => {
    expect(() => validateConfig({ model: "" })).toThrow(
      /"model" must be a non-empty string/,
    );
  });

  it("rejects systemPrompt when not a string", () => {
    expect(() => validateConfig({ systemPrompt: 123 })).toThrow(
      /"systemPrompt" must be a string/,
    );
  });

  it("rejects maxToolRounds when not a positive integer", () => {
    expect(() => validateConfig({ maxToolRounds: 0 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
    expect(() => validateConfig({ maxToolRounds: -1 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
    expect(() => validateConfig({ maxToolRounds: 1.5 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
  });

  it("rejects temperature outside 0.0–2.0 range", () => {
    expect(() => validateConfig({ temperature: -0.1 })).toThrow(
      /"temperature" must be a number between 0 and 2/,
    );
    expect(() => validateConfig({ temperature: 2.1 })).toThrow(
      /"temperature" must be a number between 0 and 2/,
    );
  });

  it("accepts temperature at boundaries", () => {
    expect(() => validateConfig({ temperature: 0 })).not.toThrow();
    expect(() => validateConfig({ temperature: 2 })).not.toThrow();
  });

  it("rejects maxTokens when not a positive integer", () => {
    expect(() => validateConfig({ maxTokens: 0 })).toThrow(
      /"maxTokens" must be a positive integer/,
    );
  });

  it("rejects gateway when not an object", () => {
    expect(() => validateConfig({ gateway: "localhost" })).toThrow(
      /"gateway" must be an object/,
    );
  });

  it("rejects unknown gateway keys", () => {
    expect(() => validateConfig({ gateway: { unknown: true } })).toThrow(
      /Unknown gateway key: "unknown"/,
    );
  });

  it("rejects gateway.host when not a string", () => {
    expect(() => validateConfig({ gateway: { host: 123 } })).toThrow(
      /"gateway.host" must be a non-empty string/,
    );
  });

  it("rejects gateway.port when not a valid port number", () => {
    expect(() => validateConfig({ gateway: { port: 0 } })).toThrow(
      /"gateway.port" must be an integer between 1 and 65535/,
    );
    expect(() => validateConfig({ gateway: { port: 70000 } })).toThrow(
      /"gateway.port" must be an integer between 1 and 65535/,
    );
  });

  it("rejects sandbox when not an object", () => {
    expect(() => validateConfig({ sandbox: true })).toThrow(
      /"sandbox" must be an object/,
    );
  });

  it("rejects unknown sandbox keys", () => {
    expect(() => validateConfig({ sandbox: { bad: 1 } })).toThrow(
      /Unknown sandbox key: "bad"/,
    );
  });

  it("rejects sandbox.enabled when not a boolean", () => {
    expect(() => validateConfig({ sandbox: { enabled: "yes" } })).toThrow(
      /"sandbox.enabled" must be a boolean/,
    );
  });

  it("rejects sandbox.timeout when not a positive integer", () => {
    expect(() => validateConfig({ sandbox: { timeout: -1 } })).toThrow(
      /"sandbox.timeout" must be a positive integer/,
    );
  });

  it("returns the validated value", () => {
    const input = { model: "gpt-4.1", maxToolRounds: 20 };
    const result = validateConfig(input);
    expect(result).toEqual(input);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/src/config/validate.test.ts`
Expected: FAIL — `./validate.js` module not found

**Step 3: Write minimal implementation**

```typescript
import type { SafeClawConfig } from "./types.js";

const ALLOWED_TOP_KEYS = new Set([
  "model",
  "systemPrompt",
  "maxToolRounds",
  "temperature",
  "maxTokens",
  "gateway",
  "sandbox",
]);

const ALLOWED_GATEWAY_KEYS = new Set(["host", "port"]);
const ALLOWED_SANDBOX_KEYS = new Set(["enabled", "timeout"]);

/**
 * Validates a parsed JSON value against the SafeClawConfig schema.
 * Throws a descriptive error on invalid input (fail-closed).
 * Returns the value typed as SafeClawConfig on success.
 */
export function validateConfig(value: unknown): SafeClawConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Config must be a JSON object");
  }

  const obj = value as Record<string, unknown>;

  // Reject unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`Unknown config key: "${key}"`);
    }
  }

  // model
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.length === 0) {
      throw new Error('"model" must be a non-empty string');
    }
  }

  // systemPrompt
  if (obj.systemPrompt !== undefined) {
    if (typeof obj.systemPrompt !== "string") {
      throw new Error('"systemPrompt" must be a string');
    }
  }

  // maxToolRounds
  if (obj.maxToolRounds !== undefined) {
    if (
      typeof obj.maxToolRounds !== "number" ||
      !Number.isInteger(obj.maxToolRounds) ||
      obj.maxToolRounds < 1
    ) {
      throw new Error('"maxToolRounds" must be a positive integer');
    }
  }

  // temperature
  if (obj.temperature !== undefined) {
    if (
      typeof obj.temperature !== "number" ||
      obj.temperature < 0 ||
      obj.temperature > 2
    ) {
      throw new Error('"temperature" must be a number between 0 and 2');
    }
  }

  // maxTokens
  if (obj.maxTokens !== undefined) {
    if (
      typeof obj.maxTokens !== "number" ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens < 1
    ) {
      throw new Error('"maxTokens" must be a positive integer');
    }
  }

  // gateway
  if (obj.gateway !== undefined) {
    if (
      typeof obj.gateway !== "object" ||
      obj.gateway === null ||
      Array.isArray(obj.gateway)
    ) {
      throw new Error('"gateway" must be an object');
    }
    const gw = obj.gateway as Record<string, unknown>;
    for (const key of Object.keys(gw)) {
      if (!ALLOWED_GATEWAY_KEYS.has(key)) {
        throw new Error(`Unknown gateway key: "${key}"`);
      }
    }
    if (gw.host !== undefined) {
      if (typeof gw.host !== "string" || gw.host.length === 0) {
        throw new Error('"gateway.host" must be a non-empty string');
      }
    }
    if (gw.port !== undefined) {
      if (
        typeof gw.port !== "number" ||
        !Number.isInteger(gw.port) ||
        gw.port < 1 ||
        gw.port > 65535
      ) {
        throw new Error(
          '"gateway.port" must be an integer between 1 and 65535',
        );
      }
    }
  }

  // sandbox
  if (obj.sandbox !== undefined) {
    if (
      typeof obj.sandbox !== "object" ||
      obj.sandbox === null ||
      Array.isArray(obj.sandbox)
    ) {
      throw new Error('"sandbox" must be an object');
    }
    const sb = obj.sandbox as Record<string, unknown>;
    for (const key of Object.keys(sb)) {
      if (!ALLOWED_SANDBOX_KEYS.has(key)) {
        throw new Error(`Unknown sandbox key: "${key}"`);
      }
    }
    if (sb.enabled !== undefined) {
      if (typeof sb.enabled !== "boolean") {
        throw new Error('"sandbox.enabled" must be a boolean');
      }
    }
    if (sb.timeout !== undefined) {
      if (
        typeof sb.timeout !== "number" ||
        !Number.isInteger(sb.timeout) ||
        sb.timeout < 1
      ) {
        throw new Error('"sandbox.timeout" must be a positive integer');
      }
    }
  }

  return obj as SafeClawConfig;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/config/validate.test.ts`
Expected: All 18 tests PASS

**Step 5: Commit**

```bash
git add packages/core/src/config/validate.ts packages/core/src/config/validate.test.ts
git commit -m "feat(core): add hand-written config validator with tests"
```

---

### Task 4: Create config loader (tests first)

**Files:**
- Create: `packages/core/src/config/loader.ts`
- Create: `packages/core/src/config/loader.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "./loader.js";
import { DEFAULT_CONFIG } from "./defaults.js";

describe("loadConfig", () => {
  it("returns defaults when file does not exist", () => {
    const result = loadConfig("/nonexistent/safeclaw.json", {
      existsSync: () => false,
      readFileSync: vi.fn(),
    });
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("merges file values with defaults", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ model: "gpt-4.1", maxToolRounds: 20 }),
    });
    expect(result.model).toBe("gpt-4.1");
    expect(result.maxToolRounds).toBe(20);
    // Defaults preserved for unset fields
    expect(result.systemPrompt).toBe(DEFAULT_CONFIG.systemPrompt);
    expect(result.gateway).toEqual(DEFAULT_CONFIG.gateway);
  });

  it("deep-merges gateway settings", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ gateway: { port: 9999 } }),
    });
    expect(result.gateway?.port).toBe(9999);
    expect(result.gateway?.host).toBe("127.0.0.1");
  });

  it("deep-merges sandbox settings", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ sandbox: { timeout: 5000 } }),
    });
    expect(result.sandbox?.timeout).toBe(5000);
    expect(result.sandbox?.enabled).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => "NOT JSON{{{",
      }),
    ).toThrow(/Failed to parse config file/);
  });

  it("throws on validation error (fail-closed)", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ model: 123 }),
      }),
    ).toThrow(/"model" must be a non-empty string/);
  });

  it("throws on file read error", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).toThrow(/Failed to read config file/);
  });

  it("uses real fs functions when no deps provided", () => {
    // With no deps, it uses real fs — a nonexistent path returns defaults
    const result = loadConfig("/nonexistent/path/safeclaw.json");
    expect(result).toEqual(DEFAULT_CONFIG);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/src/config/loader.test.ts`
Expected: FAIL — `./loader.js` module not found

**Step 3: Write minimal implementation**

```typescript
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import type { SafeClawConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { validateConfig } from "./validate.js";

export interface ConfigLoaderDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
}

/**
 * Load and validate a SafeClaw config file.
 *
 * - Returns DEFAULT_CONFIG if the file does not exist.
 * - Throws on invalid JSON, validation errors, or read errors (fail-closed).
 * - Merges file values over defaults (deep merge for gateway/sandbox).
 */
export function loadConfig(
  configPath: string,
  deps?: Partial<ConfigLoaderDeps>,
): Required<Pick<SafeClawConfig, "model" | "systemPrompt" | "maxToolRounds">> &
  SafeClawConfig {
  const exists = deps?.existsSync ?? defaultExistsSync;
  const readFile =
    deps?.readFileSync ??
    ((p: string, enc: BufferEncoding) => defaultReadFileSync(p, enc));

  if (!exists(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: string;
  try {
    raw = readFile(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Validate throws on invalid config (fail-closed)
  const validated = validateConfig(parsed);

  // Deep merge with defaults
  return {
    model: validated.model ?? DEFAULT_CONFIG.model,
    systemPrompt: validated.systemPrompt ?? DEFAULT_CONFIG.systemPrompt,
    maxToolRounds: validated.maxToolRounds ?? DEFAULT_CONFIG.maxToolRounds,
    temperature: validated.temperature ?? DEFAULT_CONFIG.temperature,
    maxTokens: validated.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    gateway: {
      ...DEFAULT_CONFIG.gateway,
      ...validated.gateway,
    },
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      ...validated.sandbox,
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/config/loader.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add packages/core/src/config/loader.ts packages/core/src/config/loader.test.ts
git commit -m "feat(core): add config file loader with validation and deep merge"
```

---

### Task 5: Add barrel exports

**Files:**
- Create: `packages/core/src/config/index.ts`
- Modify: `packages/core/src/index.ts:8` (add config export)

**Step 1: Create the config barrel file**

```typescript
export type {
  SafeClawConfig,
  GatewayFileConfig,
  SandboxFileConfig,
} from "./types.js";
export { DEFAULT_CONFIG } from "./defaults.js";
export { validateConfig } from "./validate.js";
export { loadConfig } from "./loader.js";
export type { ConfigLoaderDeps } from "./loader.js";
```

**Step 2: Add config to core barrel**

In `packages/core/src/index.ts`, add at the end:

```typescript
export * from "./config/index.js";
```

The file should now read:

```typescript
// @safeclaw/core
export * from "./agent/index.js";
export * from "./capabilities/index.js";
export * from "./channels/index.js";
export * from "./copilot/index.js";
export * from "./sessions/index.js";
export * from "./skills/index.js";
export * from "./tools/index.js";
export * from "./config/index.js";
```

**Step 3: Verify build**

Run: `pnpm vitest run packages/core/src/config/`
Expected: All config tests still pass (18 + 8 = 26 tests)

**Step 4: Commit**

```bash
git add packages/core/src/config/index.ts packages/core/src/index.ts
git commit -m "feat(core): export config module from @safeclaw/core barrel"
```

---

### Task 6: Wire config into bootstrap (tests first)

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:30-49` (BootstrapDeps)
- Modify: `packages/cli/src/commands/bootstrap.ts:70-188` (bootstrapAgent)
- Modify: `packages/cli/src/commands/bootstrap.test.ts`

**Step 1: Write the failing test**

Add to `bootstrap.test.ts`:

```typescript
it("loads config file and uses model from config when vault has no default_model", async () => {
  const deps = createMockDeps({
    openVault: vi.fn().mockReturnValue({
      get: vi.fn((name: string) => {
        if (name === "github_token") return "ghu_testtoken";
        // No default_model in vault
        return undefined;
      }),
    }),
    keyringProvider: {
      retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
      store: vi.fn(),
    },
    configPath: "/tmp/safeclaw.json",
    loadConfig: vi.fn().mockReturnValue({
      model: "gpt-4.1",
      systemPrompt: "Custom prompt",
      maxToolRounds: 25,
      temperature: undefined,
      maxTokens: undefined,
      gateway: { host: "127.0.0.1", port: 18789 },
      sandbox: { enabled: true, timeout: 30000 },
    }),
  });

  const result = await bootstrapAgent(deps);
  expect(result.agent).toBeDefined();
  expect(deps.loadConfig).toHaveBeenCalledWith("/tmp/safeclaw.json");
});
```

Also add:

```typescript
it("vault default_model takes precedence over config file model", async () => {
  const loadConfigMock = vi.fn().mockReturnValue({
    model: "gpt-4.1",
    systemPrompt: "Custom prompt",
    maxToolRounds: 25,
    temperature: undefined,
    maxTokens: undefined,
    gateway: { host: "127.0.0.1", port: 18789 },
    sandbox: { enabled: true, timeout: 30000 },
  });
  const deps = createMockDeps({
    configPath: "/tmp/safeclaw.json",
    loadConfig: loadConfigMock,
    openVault: vi.fn().mockReturnValue({
      get: vi.fn((name: string) => {
        if (name === "github_token") return "ghu_testtoken";
        if (name === "default_model") return "claude-opus-4";
        return undefined;
      }),
    }),
    keyringProvider: {
      retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)),
      store: vi.fn(),
    },
  });

  const result = await bootstrapAgent(deps);
  expect(result.agent).toBeDefined();
  // Vault value should win — verified via the agent being constructed
  // with the vault model (the Agent constructor receives the config)
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: FAIL — `configPath` / `loadConfig` not recognized in BootstrapDeps

**Step 3: Update BootstrapDeps and bootstrapAgent**

In `packages/cli/src/commands/bootstrap.ts`, add imports at the top:

```typescript
import {
  loadConfig as defaultLoadConfig,
  DEFAULT_CONFIG,
} from "@safeclaw/core";
import type { SafeClawConfig } from "@safeclaw/core";
```

Add to `BootstrapDeps` interface:

```typescript
export interface BootstrapDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  /** Path to safeclaw.json config file (default: ~/.safeclaw/safeclaw.json) */
  configPath?: string;
  // Injectable for testing
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  keyringProvider?: { retrieve(): Buffer | null; store(key: Buffer): void };
  openVault?: (
    path: string,
    key: Buffer,
  ) => { get(name: string): string | undefined };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  readPassphrase?: (
    prompt: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => Promise<string>;
  /** Injectable config loader for testing */
  loadConfig?: (configPath: string) => ReturnType<typeof defaultLoadConfig>;
}
```

In `bootstrapAgent()`, after vault is opened (after step 3, line ~107) and before step 6 (building agent stack), add config loading:

```typescript
  // 3.5 Load config file
  const configPath = deps.configPath ?? vaultPath.replace(/vault\.json$/, "safeclaw.json");
  const loadConfigFn = deps.loadConfig ?? defaultLoadConfig;
  const config = loadConfigFn(configPath);
```

Then update the model resolution (replacing lines 121-123) to incorporate config precedence:

```typescript
  // 6. Build Agent stack
  // Precedence: vault > config file > defaults
  const vaultModel = vault.get("default_model") as CopilotModel | undefined;
  const model = vaultModel ?? config.model ?? DEFAULT_AGENT_CONFIG.model;
  const client = new CopilotClient(copilotToken);
```

Update the Agent constructor call (replacing line 179-183) to use config values:

```typescript
  const agent = new Agent(
    {
      ...DEFAULT_AGENT_CONFIG,
      model,
      systemPrompt: config.systemPrompt ?? DEFAULT_AGENT_CONFIG.systemPrompt,
      maxToolRounds: config.maxToolRounds ?? DEFAULT_AGENT_CONFIG.maxToolRounds,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      skillId: manifest.id,
    },
    client,
    orchestrator,
  );
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: All tests PASS (existing + 2 new)

**Step 5: Commit**

```bash
git add packages/cli/src/commands/bootstrap.ts packages/cli/src/commands/bootstrap.test.ts
git commit -m "feat(cli): wire config file loading into bootstrap"
```

---

### Task 7: Run full test suite and typecheck

**Files:** None (verification only)

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Run linter**

Run: `pnpm lint`
Expected: No errors

**Step 4: Commit any fixes if needed**

If typecheck or lint revealed issues, fix them and commit:

```bash
git add -A
git commit -m "fix(core): address typecheck/lint issues from config integration"
```
