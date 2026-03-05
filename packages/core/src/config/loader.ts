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
