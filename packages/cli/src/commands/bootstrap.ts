import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
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
  AuditLog,
  SkillLoader,
  loadConfig as defaultLoadConfig,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModel } from "@safeclaw/core";
import {
  Vault,
  KeyringProvider as DefaultKeyringProvider,
  deriveKeyFromPassphrase as defaultDeriveKey,
} from "@safeclaw/vault";
import { Sandbox, DEFAULT_POLICY } from "@safeclaw/sandbox";
import { readPassphrase as defaultReadPassphrase } from "../readPassphrase.js";

export interface BootstrapDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  /** Path to safeclaw.json config file (default: derived from vaultPath) */
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

export interface BootstrapResult {
  agent: Agent;
  sessionManager: SessionManager;
  capabilityRegistry: CapabilityRegistry;
  auditLog: AuditLog;
}

// Relative to compiled output: dist/commands/ -> ../../../../skills/builtin/
const BUILTIN_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills/builtin/manifest.json",
);

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

  // 3.5 Load config file
  const configPath = deps.configPath ?? vaultPath.replace(/vault\.json$/, "safeclaw.json");
  const loadConfigFn = deps.loadConfig ?? defaultLoadConfig;
  const config = loadConfigFn(configPath);

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
  // Precedence: vault > config file > defaults
  const vaultModel = vault.get("default_model") as CopilotModel | undefined;
  const model = vaultModel ?? config.model ?? DEFAULT_AGENT_CONFIG.model;
  const client = new CopilotClient(copilotToken);

  const capabilityRegistry = new CapabilityRegistry();

  // Load and register builtin skill manifest.
  // The builtin manifest ships with the package, so signature verification
  // is intentionally skipped — it is a trusted, first-party artifact.
  let manifestJson: string;
  try {
    manifestJson = readFile(BUILTIN_MANIFEST_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to load builtin skill manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const loader = new SkillLoader();
  const loadResult = loader.loadFromString(manifestJson);
  if (!loadResult.success || !loadResult.manifest) {
    throw new Error(`Failed to load builtin manifest: ${loadResult.error}`);
  }
  const manifest = loadResult.manifest;
  capabilityRegistry.registerSkill(manifest);
  for (const req of manifest.requiredCapabilities) {
    capabilityRegistry.grantCapability({
      skillId: manifest.id,
      capability: req.capability,
      grantedAt: new Date(),
      grantedBy: "builtin",
    });
  }
  const enforcer = new CapabilityEnforcer(capabilityRegistry);

  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools()) {
    toolRegistry.register(tool);
  }

  let sandbox: Sandbox | undefined;
  try {
    sandbox = new Sandbox(DEFAULT_POLICY);
  } catch (err: unknown) {
    // Sandbox not supported on this system — fall back to unsandboxed
    const detail = err instanceof Error ? err.message : String(err);
    output.write(
      `Warning: sandbox not available (${detail}), tools will run unsandboxed\n`,
    );
  }

  const orchestrator = new ToolOrchestrator(
    enforcer,
    toolRegistry,
    sandbox
      ? { sandbox, sandboxedTools: ["bash"] }
      : undefined,
  );
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
  const sessionManager = new SessionManager();
  const auditLog = new AuditLog();

  return { agent, sessionManager, capabilityRegistry, auditLog };
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
