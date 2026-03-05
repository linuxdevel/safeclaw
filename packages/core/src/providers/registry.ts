import type { ModelProvider } from "./types.js";

/**
 * Registry of available model providers.
 *
 * Stores providers by their string ID and provides lookup/listing.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  /** Register a provider. Overwrites any existing provider with the same id. */
  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Get a provider by id, or undefined if not registered. */
  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  /** List all registered providers. */
  list(): ModelProvider[] {
    return [...this.providers.values()];
  }
}
