import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import {
  Agent,
  DEFAULT_AGENT_CONFIG,
  CopilotClient,
  getCopilotToken as defaultGetCopilotToken,
  SessionManager,
  CapabilityRegistry,
  CapabilityEnforcer,
  SimpleToolRegistry,
  ToolOrchestrator,
  createBuiltinTools,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModel, Capability } from "@safeclaw/core";
import {
  Vault,
  KeyringProvider as DefaultKeyringProvider,
  deriveKeyFromPassphrase as defaultDeriveKey,
} from "@safeclaw/vault";
import { readPassphrase as defaultReadPassphrase } from "../readPassphrase.js";

export interface BootstrapDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
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
}

export interface BootstrapResult {
  agent: Agent;
  sessionManager: SessionManager;
}

const BUILTIN_CAPABILITIES: Capability[] = [
  "fs:read",
  "fs:write",
  "process:spawn",
  "net:https",
  "env:read",
];

/**
 * Shared bootstrap for both `chat` and `serve` commands.
 *
 * Opens the vault (keyring or passphrase), exchanges the stored GitHub token
 * for a Copilot API token, and constructs the full Agent stack.
 */
export async function bootstrapAgent(
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const {
    input,
    output,
    vaultPath,
    existsSync: exists = defaultExistsSync,
    readFileSync: readFile = (p: string, enc: BufferEncoding) =>
      defaultReadFileSync(p, enc),
    keyringProvider = new DefaultKeyringProvider(),
    openVault = (p: string, k: Buffer) => Vault.open(p, k),
    deriveKey = defaultDeriveKey,
    getCopilotToken: exchangeToken = defaultGetCopilotToken,
    readPassphrase: readPass = defaultReadPassphrase,
  } = deps;

  // 1. Check vault exists
  if (!exists(vaultPath)) {
    throw new Error(
      "Vault not found. Run 'safeclaw onboard' to complete setup.",
    );
  }

  // 2. Determine key
  const key = await resolveKey({
    vaultPath,
    input,
    output,
    keyringProvider,
    readFile,
    deriveKey,
    exists,
    readPassphrase: readPass,
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
  const model =
    (vault.get("default_model") as CopilotModel | undefined) ??
    DEFAULT_AGENT_CONFIG.model;
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
  const agent = new Agent(
    { ...DEFAULT_AGENT_CONFIG, model },
    client,
    orchestrator,
  );
  const sessionManager = new SessionManager();

  return { agent, sessionManager };
}

interface ResolveKeyOpts {
  vaultPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  keyringProvider: { retrieve(): Buffer | null };
  readFile: (path: string, encoding: BufferEncoding) => string;
  deriveKey: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  exists: (path: string) => boolean;
  readPassphrase: (
    prompt: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => Promise<string>;
}

async function resolveKey(opts: ResolveKeyOpts): Promise<Buffer> {
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
  const passphrase = await opts.readPassphrase(
    "Enter vault passphrase: ",
    opts.input,
    opts.output,
  );
  return opts.deriveKey(passphrase, salt);
}
