import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  requestDeviceCode as defaultRequestDeviceCode,
  pollForToken as defaultPollForToken,
  getCopilotToken as defaultGetCopilotToken,
  generateSigningKeyPair as defaultGenerateKeyPair,
  DEFAULT_MODEL,
} from "@safeclaw/core";
import type {
  CopilotAuthConfig,
  DeviceCodeResponse,
  TokenResponse,
  CopilotToken,
  CopilotModel,
  SigningKeyPair,
} from "@safeclaw/core";
import {
  detectKernelCapabilities as defaultDetectCapabilities,
} from "@safeclaw/sandbox";
import type { KernelCapabilities } from "@safeclaw/sandbox";
import {
  Vault,
  KeyringProvider as DefaultKeyringProvider,
} from "@safeclaw/vault";
import type { KeySource } from "@safeclaw/vault";
import { deriveKeyFromPassphrase as defaultDeriveKey } from "@safeclaw/vault";

import { readPassphrase as defaultReadPassphrase } from "../readPassphrase.js";

const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_SCOPES = ["read:user"];

const MODELS: CopilotModel[] = [
  "claude-sonnet-4",
  "claude-opus-4",
  "gpt-4.1",
  "gemini-2.5-pro",
  "o4-mini",
];

export interface OnboardOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  vaultPath: string;
  // Dependencies (injectable for testing)
  detectCapabilities?: () => KernelCapabilities;
  requestDeviceCode?: (config: CopilotAuthConfig) => Promise<DeviceCodeResponse>;
  pollForToken?: (config: CopilotAuthConfig, deviceCode: string, interval: number) => Promise<TokenResponse>;
  getCopilotToken?: (githubToken: string) => Promise<CopilotToken>;
  createVault?: (path: string, key: Buffer) => { set(name: string, value: string): void; save(): void };
  keyringProvider?: { store(key: Buffer): void; retrieve(): Buffer | null };
  deriveKey?: (passphrase: string, salt?: Buffer) => Promise<Buffer>;
  generateKeyPair?: () => SigningKeyPair;
  writeSalt?: (saltPath: string, hexSalt: string) => void;
  readPassphrase?: (
    prompt: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) => Promise<string>;
  listModels?: () => Promise<string[] | null>;
}

export interface OnboardResult {
  kernelCapabilities: KernelCapabilities;
  authenticated: boolean;
  vaultCreated: boolean;
  keySource: KeySource;
  signingKeyGenerated: boolean;
  selectedModel: CopilotModel;
  saltPath?: string;
}

function print(output: NodeJS.WritableStream, message: string): void {
  output.write(message + "\n");
}

/**
 * A line reader that buffers lines from readline and provides
 * an async `ask` method that writes a prompt and returns the next line.
 */
class LineReader {
  private readonly rl: ReadlineInterface;
  private readonly output: NodeJS.WritableStream;
  private readonly buffer: string[] = [];
  private waiting: ((line: string) => void) | null = null;

  constructor(rl: ReadlineInterface, output: NodeJS.WritableStream) {
    this.rl = rl;
    this.output = output;

    this.rl.on("line", (line: string) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
      } else {
        this.buffer.push(line);
      }
    });
  }

  async ask(prompt: string): Promise<string> {
    this.output.write(prompt);
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return buffered;
    }
    return new Promise<string>((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }
}

function checkKernel(
  output: NodeJS.WritableStream,
  detect: () => KernelCapabilities,
): KernelCapabilities {
  const caps = detect();

  print(output, "\n=== Step 1: Kernel Capabilities ===\n");
  print(
    output,
    `  Landlock:    ${caps.landlock.supported ? `supported (ABI v${caps.landlock.abiVersion})` : "not supported"}`,
  );
  print(
    output,
    `  Seccomp:     ${caps.seccomp.supported ? "supported" : "not supported"}`,
  );
  print(
    output,
    `  Namespaces:  user=${caps.namespaces.user ? "yes" : "unavailable"} pid=${caps.namespaces.pid ? "yes" : "unavailable"} net=${caps.namespaces.net ? "yes" : "unavailable"} mnt=${caps.namespaces.mnt ? "yes" : "unavailable"}`,
  );

  const missing: string[] = [];
  if (!caps.landlock.supported) missing.push("Landlock");
  if (!caps.seccomp.supported) missing.push("Seccomp");
  if (!caps.namespaces.user) missing.push("user namespaces");
  if (!caps.namespaces.pid) missing.push("PID namespaces");
  if (!caps.namespaces.net) missing.push("network namespaces");
  if (!caps.namespaces.mnt) missing.push("mount namespaces");

  if (missing.length > 0) {
    print(
      output,
      `\n  Warning: Some features are unavailable: ${missing.join(", ")}`,
    );
    print(output, "  Sandbox isolation may be limited.\n");
  } else {
    print(output, "\n  All kernel features available.\n");
  }

  return caps;
}

async function authenticate(
  reader: LineReader,
  output: NodeJS.WritableStream,
  reqDeviceCode: (config: CopilotAuthConfig) => Promise<DeviceCodeResponse>,
  poll: (config: CopilotAuthConfig, deviceCode: string, interval: number) => Promise<TokenResponse>,
  getCopilot: (githubToken: string) => Promise<CopilotToken>,
): Promise<{ authenticated: boolean; accessToken: string | undefined }> {
  print(output, "=== Step 2: GitHub Copilot Authentication ===\n");

  const answer = await reader.ask("Authenticate with GitHub Copilot now? (y/n): ");

  if (answer.trim().toLowerCase() !== "y") {
    print(output, "  Skipping authentication.\n");
    return { authenticated: false, accessToken: undefined };
  }

  try {
    const config: CopilotAuthConfig = {
      clientId: COPILOT_CLIENT_ID,
      scopes: COPILOT_SCOPES,
    };

    const deviceCode = await reqDeviceCode(config);

    print(output, `\n  Open: ${deviceCode.verification_uri}`);
    print(output, `  Enter code: ${deviceCode.user_code}\n`);
    print(output, "  Waiting for authorization...");

    const token = await poll(config, deviceCode.device_code, deviceCode.interval);

    await getCopilot(token.access_token);

    print(output, "  Authenticated successfully.\n");

    return { authenticated: true, accessToken: token.access_token };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    print(output, `  Authentication failed: ${message}`);
    print(output, "  Continuing without authentication.\n");
    return { authenticated: false, accessToken: undefined };
  }
}

async function createVaultStep(
  reader: LineReader,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  vaultPath: string,
  createVaultFn: (path: string, key: Buffer) => { set(name: string, value: string): void; save(): void },
  keyring: { store(key: Buffer): void; retrieve(): Buffer | null },
  deriveKey: (passphrase: string, salt?: Buffer) => Promise<Buffer>,
  writeSalt: (saltPath: string, hexSalt: string) => void,
  readPassphraseFn: (prompt: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => Promise<string>,
): Promise<{
  vault: { set(name: string, value: string): void; save(): void };
  keySource: KeySource;
  saltPath?: string;
}> {
  print(output, "=== Step 3: Create Vault ===\n");
  print(output, "  Choose key source:");
  print(output, "  1) OS Keyring");
  print(output, "  2) Passphrase\n");

  const choice = await reader.ask("Select (1 or 2): ");

  const usePassphrase = async (): Promise<{
    vault: { set(name: string, value: string): void; save(): void };
    keySource: KeySource;
    saltPath?: string;
  }> => {
    let passphrase: string;
    for (;;) {
      passphrase = await readPassphraseFn("Enter passphrase: ", input, output);
      if (passphrase.length >= 8) break;
      print(output, "  Passphrase must be at least 8 characters. Try again.");
    }
    const confirm = await readPassphraseFn("Confirm passphrase: ", input, output);

    if (passphrase !== confirm) {
      throw new Error("Passphrases do not match");
    }

    const salt = randomBytes(16);
    const key = await deriveKey(passphrase, salt);
    const vault = createVaultFn(vaultPath, key);

    const sp = vaultPath + ".salt";
    writeSalt(sp, salt.toString("hex"));

    print(output, "  Vault created with passphrase key.\n");
    return { vault, keySource: "passphrase", saltPath: sp };
  };

  if (choice.trim() === "2") {
    return usePassphrase();
  }

  // Default to keyring
  const key = randomBytes(32);
  try {
    keyring.store(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    print(output, `  Warning: Keyring unavailable (${message}). Falling back to passphrase.`);
    return usePassphrase();
  }
  const vault = createVaultFn(vaultPath, key);

  print(output, "  Vault created with OS keyring.\n");
  return { vault, keySource: "keyring" };
}

function generateKeyPairStep(
  output: NodeJS.WritableStream,
  vault: { set(name: string, value: string): void; save(): void },
  generate: () => SigningKeyPair,
): boolean {
  print(output, "=== Step 4: Generate Signing Key Pair ===\n");

  const kp = generate();
  vault.set("signing_private_key", kp.privateKey);

  print(output, `  Public key: ${kp.publicKey}`);
  print(output, "  Private key stored in vault.\n");

  return true;
}

async function selectModel(
  reader: LineReader,
  output: NodeJS.WritableStream,
  vault: { set(name: string, value: string): void; save(): void },
  listModelsFn?: () => Promise<string[] | null>,
): Promise<CopilotModel> {
  print(output, "=== Step 5: Select Default Model ===\n");

  let models: string[] = MODELS;
  if (listModelsFn) {
    const discovered = await listModelsFn();
    if (discovered && discovered.length > 0) {
      models = discovered;
      print(output, "  Available models (from API):\n");
    } else {
      print(output, "  Could not fetch models from API, using defaults:\n");
    }
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const marker = model === DEFAULT_MODEL ? " (default)" : "";
    print(output, `  ${i + 1}) ${model}${marker}`);
  }

  print(output, "");
  const answer = await reader.ask(`Select model (1-${models.length}) [1]: `);
  const trimmed = answer.trim();

  let selected: string;
  if (trimmed === "" || trimmed === "1") {
    selected = models[0] ?? DEFAULT_MODEL;
  } else {
    const idx = parseInt(trimmed, 10) - 1;
    const model = models[idx];
    if (idx < 0 || idx >= models.length || model === undefined) {
      print(output, "  Invalid selection, using default.");
      selected = models[0] ?? DEFAULT_MODEL;
    } else {
      selected = model;
    }
  }

  vault.set("default_model", selected);
  print(output, `  Selected: ${selected}\n`);

  return selected as CopilotModel;
}

export async function runOnboarding(options: OnboardOptions): Promise<OnboardResult> {
  const {
    input,
    output,
    vaultPath,
    detectCapabilities: detect = defaultDetectCapabilities,
    requestDeviceCode: reqDeviceCode = defaultRequestDeviceCode,
    pollForToken: poll = defaultPollForToken,
    getCopilotToken: getCopilot = defaultGetCopilotToken,
    createVault: createVaultFn = (path: string, key: Buffer) => Vault.create(path, key),
    keyringProvider: keyring = new DefaultKeyringProvider(),
    deriveKey = defaultDeriveKey,
    generateKeyPair: genKeyPair = defaultGenerateKeyPair,
    writeSalt = (saltPath: string, hexSalt: string) =>
      writeFileSync(saltPath, hexSalt, { mode: 0o600 }),
    readPassphrase: readPass = defaultReadPassphrase,
  } = options;

  const rl = createInterface({ input, output, terminal: false });
  const reader = new LineReader(rl, output);

  try {
    print(output, "SafeClaw Onboarding Wizard");
    print(output, "==========================");

    // Step 1: Kernel capabilities
    const kernelCapabilities = checkKernel(output, detect);

    // Step 2: Authentication
    const { authenticated, accessToken } = await authenticate(
      reader,
      output,
      reqDeviceCode,
      poll,
      getCopilot,
    );

    // Step 3: Create vault
    const { vault, keySource, saltPath } = await createVaultStep(
      reader,
      input,
      output,
      vaultPath,
      createVaultFn,
      keyring,
      deriveKey,
      writeSalt,
      readPass,
    );

    // Store access token if authenticated
    if (authenticated && accessToken !== undefined) {
      vault.set("github_token", accessToken);
    }

    // Step 4: Generate signing key pair
    const signingKeyGenerated = generateKeyPairStep(output, vault, genKeyPair);

    // Step 5: Select default model
    const selectedModel = await selectModel(reader, output, vault, options.listModels);

    // Save vault
    vault.save();

    print(output, "Onboarding complete!");

    return {
      kernelCapabilities,
      authenticated,
      vaultCreated: true,
      keySource,
      signingKeyGenerated,
      selectedModel,
      ...(saltPath !== undefined ? { saltPath } : {}),
    };
  } finally {
    reader.close();
  }
}
