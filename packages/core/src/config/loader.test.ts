import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "./loader.js";
import { DEFAULT_CONFIG } from "./defaults.js";

describe("loadConfig", () => {
  it("returns defaults when file does not exist", () => {
    const result = loadConfig("/nonexistent/safeclaw.json", {
      existsSync: () => false,
      readFileSync: vi.fn(),
    });
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("merges file values with defaults", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ model: "gpt-4.1", maxToolRounds: 20 }),
    });
    expect(result.model).toBe("gpt-4.1");
    expect(result.maxToolRounds).toBe(20);
    // Defaults preserved for unset fields
    expect(result.systemPrompt).toBe(DEFAULT_CONFIG.systemPrompt);
    expect(result.gateway).toEqual(DEFAULT_CONFIG.gateway);
  });

  it("deep-merges gateway settings", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ gateway: { port: 9999 } }),
    });
    expect(result.gateway?.port).toBe(9999);
    expect(result.gateway?.host).toBe("127.0.0.1");
  });

  it("deep-merges sandbox settings", () => {
    const result = loadConfig("/tmp/safeclaw.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ sandbox: { timeout: 5000 } }),
    });
    expect(result.sandbox?.timeout).toBe(5000);
    expect(result.sandbox?.enabled).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => "NOT JSON{{{",
      }),
    ).toThrow(/Failed to parse config file/);
  });

  it("throws on validation error (fail-closed)", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ model: 123 }),
      }),
    ).toThrow(/"model" must be a non-empty string/);
  });

  it("throws on file read error", () => {
    expect(() =>
      loadConfig("/tmp/safeclaw.json", {
        existsSync: () => true,
        readFileSync: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).toThrow(/Failed to read config file/);
  });

  it("uses real fs functions when no deps provided", () => {
    // With no deps, it uses real fs — a nonexistent path returns defaults
    const result = loadConfig("/nonexistent/path/safeclaw.json");
    expect(result).toEqual(DEFAULT_CONFIG);
  });
});
