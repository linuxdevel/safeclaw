import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "./registry.js";
import type { ModelProvider } from "./types.js";

function makeMockProvider(id: string): ModelProvider {
  return {
    id,
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider by id", () => {
    const registry = new ProviderRegistry();
    const provider = makeMockProvider("openai");

    registry.register(provider);

    expect(registry.get("openai")).toBe(provider);
  });

  it("returns undefined for unregistered provider", () => {
    const registry = new ProviderRegistry();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered providers", () => {
    const registry = new ProviderRegistry();
    const p1 = makeMockProvider("copilot");
    const p2 = makeMockProvider("openai");
    const p3 = makeMockProvider("anthropic");

    registry.register(p1);
    registry.register(p2);
    registry.register(p3);

    const providers = registry.list();
    expect(providers).toHaveLength(3);
    expect(providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "copilot",
      "openai",
    ]);
  });

  it("overwrites provider with same id", () => {
    const registry = new ProviderRegistry();
    const p1 = makeMockProvider("openai");
    const p2 = makeMockProvider("openai");

    registry.register(p1);
    registry.register(p2);

    expect(registry.get("openai")).toBe(p2);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns empty array when no providers registered", () => {
    const registry = new ProviderRegistry();
    expect(registry.list()).toEqual([]);
  });
});
