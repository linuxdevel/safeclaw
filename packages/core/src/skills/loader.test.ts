import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillManifest } from "../capabilities/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { SkillLoader } from "./loader.js";

const validManifest: SkillManifest = {
  id: "test-skill",
  version: "1.0.0",
  name: "Test Skill",
  description: "A test skill",
  signature: "abc123",
  publicKey: "def456",
  requiredCapabilities: [],
  tools: [
    {
      name: "test-tool",
      description: "A test tool",
      parameters: {},
    },
  ],
};

describe("SkillLoader", () => {
  let loader: SkillLoader;

  beforeEach(() => {
    loader = new SkillLoader();
    vi.resetAllMocks();
  });

  describe("loadFromFile", () => {
    it("loads valid manifest from file", () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validManifest));

      const result = loader.loadFromFile("/path/to/manifest.json");

      expect(result.success).toBe(true);
      expect(result.manifest).toEqual(validManifest);
      expect(result.error).toBeUndefined();
      expect(readFileSync).toHaveBeenCalledWith("/path/to/manifest.json", "utf-8");
    });

    it("returns error for missing file", () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const result = loader.loadFromFile("/nonexistent.json");

      expect(result.success).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.error).toContain("ENOENT");
    });

    it("returns error for invalid JSON", () => {
      vi.mocked(readFileSync).mockReturnValue("not valid json {{{");

      const result = loader.loadFromFile("/path/to/bad.json");

      expect(result.success).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    it("returns error for missing required field: id", () => {
      const { id: _, ...noId } = validManifest;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(noId));

      const result = loader.loadFromFile("/path/to/manifest.json");

      expect(result.success).toBe(false);
      expect(result.error).toContain("id");
    });

    it("returns error for missing required field: version", () => {
      const { version: _, ...noVersion } = validManifest;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(noVersion));

      const result = loader.loadFromFile("/path/to/manifest.json");

      expect(result.success).toBe(false);
      expect(result.error).toContain("version");
    });

    it("returns error for missing required field: name", () => {
      const { name: _, ...noName } = validManifest;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(noName));

      const result = loader.loadFromFile("/path/to/manifest.json");

      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
    });
  });

  describe("loadFromString", () => {
    it("parses JSON correctly", () => {
      const result = loader.loadFromString(JSON.stringify(validManifest));

      expect(result.success).toBe(true);
      expect(result.manifest).toEqual(validManifest);
      expect(result.error).toBeUndefined();
    });

    it("returns error for invalid JSON string", () => {
      const result = loader.loadFromString("not json");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns error for missing required fields", () => {
      const result = loader.loadFromString(JSON.stringify({ description: "only" }));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
