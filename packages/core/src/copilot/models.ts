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
