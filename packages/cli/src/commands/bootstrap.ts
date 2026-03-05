import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  Agent,
  DEFAULT_AGENT_CONFIG,
  CopilotClient,
  getCopilotToken as defaultGetCopilotToken,
  SessionManager,
  FileSessionStore,
  CapabilityRegistry,
  CapabilityEnforcer,
  SimpleToolRegistry,
  ToolOrchestrator,
  createBuiltinTools,
  AuditLog,
  SkillLoader,
  loadConfig as defaultLoadConfig,
  ContextCompactor,
  CopilotProvider,
  OpenAIProvider,
  AnthropicProvider,
  ProcessManager,
} from "@safeclaw/core";
import type { CopilotToken, CopilotModel, ModelProvider } from "@safeclaw/core";
import {
  Vault,
  KeyringProvider as DefaultKeyringProvider,
  deriveKeyFromPassphrase as defaultDeriveKey,
} from "@safeclaw/vault";
import { Sandbox, PolicyBuilder } from "@safeclaw/sandbox";
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

  // 5. Build Agent stack
  // Precedence: vault > config file > defaults
  const vaultModel = vault.get("default_model") as CopilotModel | undefined;
  const model = vaultModel ?? config.model ?? DEFAULT_AGENT_CONFIG.model;

  const providerId = vault.get("provider") ?? "copilot";
  const provider = await createProvider(providerId, vault, exchangeToken, githubToken);

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

  // Build sandbox policy first — we extract allowed paths for bash tool validation
  const sandboxPolicy = PolicyBuilder.forDevelopment(process.cwd());
  const allowedCommandPaths = sandboxPolicy.filesystem.allow
    .filter((r) => r.access === "execute" || r.access === "readwrite")
    .map((r) => r.path);

  const braveApiKey = vault.get("brave_api_key");
  const processManager = new ProcessManager();
  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools({ braveApiKey, processManager, allowedCommandPaths })) {
    toolRegistry.register(tool);
  }

  let sandbox: Sandbox | undefined;
  try {
    sandbox = new Sandbox(sandboxPolicy);
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
  const compactor = new ContextCompactor({
    provider,
    model,
    maxContextTokens: config.maxContextTokens ?? DEFAULT_AGENT_CONFIG.maxContextTokens ?? 100_000,
    preserveRecentMessages: 10,
  });
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
    provider,
    orchestrator,
    compactor,
  );
  const sessionManager = await (async () => {
    const safeclawDir = join(homedir(), ".safeclaw");
    const store = new FileSessionStore(safeclawDir);
    const sm = new SessionManager(store);
    await sm.loadAll();
    return sm;
  })();
  const auditLog = new AuditLog();

  return { agent, sessionManager, capabilityRegistry, auditLog };
}

async function createProvider(
  providerId: string,
  vault: { get(name: string): string | undefined },
  exchangeToken: (githubToken: string) => Promise<CopilotToken>,
  githubToken: string,
): Promise<ModelProvider> {
  switch (providerId) {
    case "copilot": {
      const copilotToken = await exchangeToken(githubToken);
      const client = new CopilotClient(copilotToken);
      return new CopilotProvider(client);
    }
    case "openai": {
      const apiKey = vault.get("openai_api_key");
      if (!apiKey) {
        throw new Error(
          "No openai_api_key in vault. Run 'safeclaw onboard' to add your OpenAI API key.",
        );
      }
      const baseUrl = vault.get("openai_base_url");
      return new OpenAIProvider({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    case "anthropic": {
      const apiKey = vault.get("anthropic_api_key");
      if (!apiKey) {
        throw new Error(
          "No anthropic_api_key in vault. Run 'safeclaw onboard' to add your Anthropic API key.",
        );
      }
      return new AnthropicProvider({ apiKey });
    }
    default:
      throw new Error(
        `Unknown provider "${providerId}". Supported: copilot, openai, anthropic`,
      );
  }
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
