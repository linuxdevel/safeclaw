# Chat & Serve Command Wiring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the `safeclaw chat` and `safeclaw serve` commands to open the vault, authenticate with Copilot, and connect a real Agent to the CLI/gateway adapters.

**Architecture:** Extract a shared `bootstrapAgent()` function that handles vault unlock (keyring or passphrase), Copilot token exchange, and Agent stack construction. Both `runChat()` and `runServe()` call this, then wire their respective adapters. All external dependencies are injectable for testing.

**Tech Stack:** TypeScript, Node.js, Vitest, pnpm monorepo, ESM modules

---

## Task 1: Create `bootstrap.ts` — shared agent bootstrap

**Files:**
- Create: `packages/cli/src/commands/bootstrap.ts`
- Test: `packages/cli/src/commands/bootstrap.test.ts`

### Step 1: Write the failing test

```typescript
// packages/cli/src/commands/bootstrap.test.ts
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { bootstrapAgent } from "./bootstrap.js";
import type { BootstrapDeps } from "./bootstrap.js";

function createMockDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    vaultPath: "/tmp/test-vault.json",
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("abcdef0123456789abcdef0123456789"),
    keyringProvider: { retrieve: vi.fn().mockReturnValue(null), store: vi.fn() },
    openVault: vi.fn().mockReturnValue({
      get: vi.fn((name: string) => {
        if (name === "github_token") return "ghu_testtoken";
        if (name === "default_model") return "claude-sonnet-4";
        return undefined;
      }),
    }),
    deriveKey: vi.fn().mockResolvedValue(Buffer.alloc(32)),
    getCopilotToken: vi.fn().mockResolvedValue({ token: "cpt_test", expiresAt: Date.now() + 3600000 }),
    createReadlineInterface: undefined, // use default
    ...overrides,
  };
}

describe("bootstrapAgent", () => {
  it("returns agent and sessionManager when vault exists with passphrase key", async () => {
    const deps = createMockDeps();
    // simulate passphrase input
    const input = deps.input as PassThrough;
    setTimeout(() => { input.push("mypassphrase\n"); }, 10);

    const result = await bootstrapAgent(deps);
    expect(result.agent).toBeDefined();
    expect(result.sessionManager).toBeDefined();
    expect(deps.getCopilotToken).toHaveBeenCalledWith("ghu_testtoken");
  });

  it("uses keyring key when available (no passphrase prompt)", async () => {
    const keyringKey = Buffer.alloc(32, 0xaa);
    const deps = createMockDeps({
      keyringProvider: { retrieve: vi.fn().mockReturnValue(keyringKey), store: vi.fn() },
      existsSync: vi.fn((p: string) => !p.endsWith(".salt")), // vault exists, no salt file
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
      keyringProvider: { retrieve: vi.fn().mockReturnValue(Buffer.alloc(32)), store: vi.fn() },
      existsSync: vi.fn((p: string) => !p.endsWith(".salt")),
    });

    await expect(bootstrapAgent(deps)).rejects.toThrow(/github_token|onboard/i);
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- packages/cli/src/commands/bootstrap.test.ts`
Expected: FAIL — module `./bootstrap.js` does not exist

### Step 3: Write the implementation

```typescript
// packages/cli/src/commands/bootstrap.ts
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import {
  Agent,
  DEFAULT_AGENT_CONFIG,
  CopilotClient,
  getCopilotToken as defaultGetCopilotToken,
  SessionManager,
  CapabilityRegistry,
  CapabilityEnforcer,
  SimpleToolRegistry,
  createBuiltinTools,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModel, Capability } from "@safeclaw/core";
import {
  Vault,
  KeyringProvider as DefaultKeyringProvider,
  deriveKeyFromPassphrase as defaultDeriveKey,
} from "@safeclaw/vault";

export interface BootstrapDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  // Injectable for testing
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  keyringProvider?: { retrieve(): Buffer | null; store(key: Buffer): void };
  openVault?: (path: string, key: Buffer) => { get(name: string): string | undefined };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  createReadlineInterface?: (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => ReadlineInterface;
}

export interface BootstrapResult {
  agent: Agent;
  sessionManager: SessionManager;
}

const BUILTIN_CAPABILITIES: Capability[] = [
  "fs:read", "fs:write", "process:spawn", "net:https", "env:read",
];

export async function bootstrapAgent(deps: BootstrapDeps): Promise<BootstrapResult> {
  const {
    input,
    output,
    vaultPath,
    existsSync: exists = defaultExistsSync,
    readFileSync: readFile = defaultReadFileSync,
    keyringProvider = new DefaultKeyringProvider(),
    openVault = (p: string, k: Buffer) => Vault.open(p, k),
    deriveKey = defaultDeriveKey,
    getCopilotToken: exchangeToken = defaultGetCopilotToken,
    createReadlineInterface: createRl,
  } = deps;

  // 1. Check vault exists
  if (!exists(vaultPath)) {
    throw new Error(
      "Vault not found. Run 'safeclaw onboard' to complete setup.",
    );
  }

  // 2. Determine key
  const key = await resolveKey({
    vaultPath, input, output, keyringProvider, readFile, deriveKey, exists, createRl,
  });

  // 3. Open vault
  const vault = openVault(vaultPath, key);

  // 4. Get GitHub token
  const githubToken = vault.get("github_token");
  if (!githubToken) {
    throw new Error(
      "No github_token in vault. Run 'safeclaw onboard' to authenticate.",
    );
  }

  // 5. Exchange for Copilot token
  const copilotToken = await exchangeToken(githubToken);

  // 6. Build Agent stack
  const model = (vault.get("default_model") as CopilotModel) ?? DEFAULT_AGENT_CONFIG.model;
  const client = new CopilotClient(copilotToken);

  const capabilityRegistry = new CapabilityRegistry();
  for (const cap of BUILTIN_CAPABILITIES) {
    capabilityRegistry.grantCapability({
      skillId: "agent",
      capability: cap,
      grantedAt: new Date(),
      grantedBy: "builtin",
    });
  }
  const enforcer = new CapabilityEnforcer(capabilityRegistry);

  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools()) {
    toolRegistry.register(tool);
  }

  const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
  const agent = new Agent({ ...DEFAULT_AGENT_CONFIG, model }, client, orchestrator);
  const sessionManager = new SessionManager();

  return { agent, sessionManager };
}

async function resolveKey(opts: {
  vaultPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  keyringProvider: { retrieve(): Buffer | null };
  readFile: (path: string, encoding: BufferEncoding) => string;
  deriveKey: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  exists: (path: string) => boolean;
  createRl?: (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => ReadlineInterface;
}): Promise<Buffer> {
  // Try keyring first
  const keyringKey = opts.keyringProvider.retrieve();
  if (keyringKey) {
    return keyringKey;
  }

  // Check for salt file (passphrase-based vault)
  const saltPath = opts.vaultPath + ".salt";
  if (!opts.exists(saltPath)) {
    throw new Error(
      "Cannot unlock vault: keyring unavailable and no salt file found. Run 'safeclaw onboard' again.",
    );
  }

  const saltHex = opts.readFile(saltPath, "utf8").trim();
  const salt = Buffer.from(saltHex, "hex");

  // Prompt for passphrase
  const passphrase = await promptPassphrase(opts.input, opts.output, opts.createRl);
  return opts.deriveKey(passphrase, salt);
}

async function promptPassphrase(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  createRl?: (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => ReadlineInterface,
): Promise<string> {
  const rl = createRl
    ? createRl(input, output)
    : createInterface({ input, output, terminal: false });

  output.write("Enter vault passphrase: ");

  return new Promise<string>((resolve) => {
    rl.once("line", (line: string) => {
      rl.close();
      resolve(line);
    });
  });
}
```

Note: Add `ToolOrchestrator` to the import from `@safeclaw/core`.

### Step 4: Run test to verify it passes

Run: `pnpm test -- packages/cli/src/commands/bootstrap.test.ts`
Expected: PASS (all 4 tests)

### Step 5: Commit

```
feat(cli): add bootstrap module for vault unlock and agent construction
```

---

## Task 2: Rewrite `runChat()` to use bootstrap

**Files:**
- Modify: `packages/cli/src/cli.ts:41-62` (replace `runChat` function)
- Modify: `packages/cli/src/cli.ts:1-7` (add imports)

### Step 1: Update `runChat()` in `cli.ts`

Replace the placeholder `runChat()` (lines 41-62) with:

```typescript
async function runChat(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { agent, sessionManager } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  const adapter = new CliAdapter(process.stdin, process.stdout);
  const session = sessionManager.create({
    channelId: "cli",
    peerId: "local",
  });

  setupChat(adapter, agent, session);

  process.stdout.write("\nSafeClaw Interactive Chat\n");
  process.stdout.write("Type your message and press Enter. Ctrl+C to exit.\n\n");

  await adapter.connect();
}
```

Add imports at top:
```typescript
import { bootstrapAgent } from "./commands/bootstrap.js";
import { setupChat } from "./commands/chat.js";
```

### Step 2: Run tests

Run: `pnpm test`
Expected: All existing tests pass

### Step 3: Commit

```
feat(cli): wire chat command to real agent via bootstrap
```

---

## Task 3: Rewrite `runServe()` to use bootstrap

**Files:**
- Modify: `packages/cli/src/cli.ts:90-112` (replace `runServe` function)
- Modify: `packages/cli/src/cli.ts` (add imports)

### Step 1: Update `runServe()` in `cli.ts`

Replace the placeholder `runServe()` (lines 90-112) with:

```typescript
async function runServe(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { agent, sessionManager } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  // Generate random auth token for this session
  const authToken = randomBytes(32).toString("hex");

  const gateway = new Gateway({
    ...DEFAULT_GATEWAY_CONFIG,
    authToken,
  });

  const webchat = new WebChatAdapter({ port: 0 });

  // Wire gateway to agent via session manager
  gateway.onMessage(async (msg) => {
    if (msg.type === "ping") {
      return { type: "pong" as const, payload: null };
    }

    const peer = { channelId: "gateway", peerId: "api-client" };
    const session = sessionManager.getOrCreate(peer);
    const response = await agent.processMessage(session, String(msg.payload));
    return { type: "response" as const, payload: response.message };
  });

  // Wire webchat adapter to agent
  webchat.onMessage(async (msg) => {
    const session = sessionManager.getOrCreate(msg.peer);
    const response = await agent.processMessage(session, msg.content);
    return { content: response.message };
  });

  await gateway.start();
  await webchat.connect();

  process.stdout.write("\nSafeClaw server started\n");
  process.stdout.write(`  Gateway API:  http://127.0.0.1:${DEFAULT_GATEWAY_CONFIG.port}/api/chat\n`);
  process.stdout.write(`  WebChat UI:   http://127.0.0.1:${webchat.port}/\n`);
  process.stdout.write(`  Auth token:   ${authToken}\n\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  // Graceful shutdown
  const shutdown = async () => {
    process.stdout.write("\nShutting down...\n");
    await Promise.all([gateway.stop(), webchat.disconnect()]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Keep process alive
  await new Promise(() => {}); // never resolves
}
```

Add imports at top:
```typescript
import { randomBytes } from "node:crypto";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "@safeclaw/gateway";
import { WebChatAdapter } from "@safeclaw/webchat";
```

### Step 2: Run tests

Run: `pnpm test`
Expected: All existing tests pass

### Step 3: Commit

```
feat(cli): wire serve command to real agent with gateway and webchat
```

---

## Task 4: Update cli.ts switch case for `serve` command alias

**Files:**
- Modify: `packages/cli/src/cli.ts` (switch statement)

The user typed `safeclaw server` but the command is `serve`. Add `"server"` as an alias:

### Step 1: Update switch

In the switch at line 133, change:
```typescript
    case "serve":
```
to:
```typescript
    case "serve":
    case "server":
```

### Step 2: Update help text

In `printUsage`, update the serve line to mention the alias.

### Step 3: Run tests

Run: `pnpm test`
Expected: PASS

### Step 4: Commit

```
feat(cli): add 'server' as alias for 'serve' command
```

---

## Task 5: Run full test suite, typecheck, and lint

### Step 1: Run typecheck

Run: `pnpm typecheck`
Expected: No type errors

### Step 2: Run tests

Run: `pnpm test`
Expected: All tests pass

### Step 3: Run lint

Run: `pnpm lint`
Expected: Clean

### Step 4: Fix any issues found, commit
