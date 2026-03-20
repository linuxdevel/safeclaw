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
