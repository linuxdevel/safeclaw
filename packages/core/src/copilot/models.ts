import { createRequire } from "node:module";
import { COPILOT_API_BASE } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const MODELS_REGISTRY_URL = "https://models.dev/api.json";

interface RegistryProvider {
  models?: Record<string, unknown>;
}

/**
 * Fetch the list of models available via GitHub Copilot.
 *
 * Queries the public models.dev registry, filters for the
 * `github-copilot` provider, and returns model ID strings.
 * Returns null if the registry is unreachable or the provider
 * is missing.
 */
export async function listCopilotModels(): Promise<string[] | null> {
  try {
    const response = await fetch(MODELS_REGISTRY_URL);
    if (!response.ok) {
      return null;
    }

    const registry = (await response.json()) as Record<
      string,
      RegistryProvider
    >;

    const copilot = registry["github-copilot"];
    if (!copilot?.models) {
      return null;
    }

    const ids = Object.keys(copilot.models);
    if (ids.length === 0) {
      return null;
    }

    return ids;
  } catch {
    return null;
  }
}

export interface CopilotModelInfo {
  id: string;
  name: string;
  /**
   * true when capabilities.type === "chat".
   * false for "completions", any other value, or missing capabilities.
   */
  conversational: boolean;
}

interface RawModelEntry {
  id: string;
  name: string;
  capabilities?: {
    type?: string;
  };
}

interface RawModelsResponse {
  data: RawModelEntry[];
}

/**
 * Fetch the list of models from the authenticated Copilot API.
 *
 * Requires a short-lived Copilot API token (not the GitHub OAuth token).
 * Returns null on any error or if the list is empty.
 */
export async function listCopilotModelsFromApi(
  copilotToken: string,
): Promise<CopilotModelInfo[] | null> {
  try {
    const response = await fetch(`${COPILOT_API_BASE}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        Accept: "application/json",
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": `SafeClaw/${pkg.version}`,
        "Editor-Plugin-Version": `SafeClaw/${pkg.version}`,
        "User-Agent": `safeclaw/${pkg.version}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as RawModelsResponse;

    if (!Array.isArray(body.data) || body.data.length === 0) {
      return null;
    }

    return body.data.map((entry) => ({
      id: entry.id,
      name: entry.name,
      conversational: entry.capabilities?.type === "chat",
    }));
  } catch {
    return null;
  }
}
