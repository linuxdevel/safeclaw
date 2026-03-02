import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as permissions from "./permissions.js";

vi.mock("node:fs");
vi.mock("./permissions.js");

const mockedFs = vi.mocked(fs);
const mockedPermissions = vi.mocked(permissions);

const { Vault } = await import("./vault.js");

describe("Vault", () => {
  const key = crypto.randomBytes(32);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("writes a new vault file with version 1", () => {
      mockedFs.writeFileSync.mockReturnValue(undefined);
      const vault = Vault.create("/tmp/vault.json", key);

      expect(vault).toBeInstanceOf(Vault);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/vault.json",
        expect.stringContaining('"version":1'),
        expect.objectContaining({ mode: 0o600 }),
      );
    });
  });

  describe("open", () => {
    it("checks file permissions", () => {
      const vaultData = JSON.stringify({ version: 1, entries: {} });
      mockedFs.readFileSync.mockReturnValue(vaultData);
      mockedPermissions.assertFilePermissions.mockReturnValue(undefined);

      Vault.open("/tmp/vault.json", key);

      expect(mockedPermissions.assertFilePermissions).toHaveBeenCalledWith(
        "/tmp/vault.json",
      );
    });

    it("refuses to open with wrong permissions", () => {
      mockedPermissions.assertFilePermissions.mockImplementation(() => {
        throw new permissions.PermissionError(
          "/tmp/vault.json",
          0o644,
          0o600,
        );
      });

      expect(() => Vault.open("/tmp/vault.json", key)).toThrow(
        permissions.PermissionError,
      );
    });
  });

  describe("set/get", () => {
    it("roundtrips a value", () => {
      const vault = Vault.create("/tmp/vault.json", key);

      vault.set("api-key", "sk-12345");
      const result = vault.get("api-key");

      expect(result).toBe("sk-12345");
    });

    it("returns undefined for missing key", () => {
      const vault = Vault.create("/tmp/vault.json", key);

      const result = vault.get("nonexistent");

      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes an existing entry and returns true", () => {
      const vault = Vault.create("/tmp/vault.json", key);
      vault.set("to-delete", "value");

      const result = vault.delete("to-delete");

      expect(result).toBe(true);
      expect(vault.get("to-delete")).toBeUndefined();
    });

    it("returns false for non-existent entry", () => {
      const vault = Vault.create("/tmp/vault.json", key);

      const result = vault.delete("nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("keys", () => {
    it("lists all entry names", () => {
      const vault = Vault.create("/tmp/vault.json", key);
      vault.set("key-a", "value-a");
      vault.set("key-b", "value-b");

      const names = vault.keys();

      expect(names.sort()).toEqual(["key-a", "key-b"]);
    });
  });

  describe("save", () => {
    it("persists the vault to disk", () => {
      const vault = Vault.create("/tmp/vault.json", key);
      vault.set("secret", "data");

      // Clear the mock from create
      mockedFs.writeFileSync.mockClear();

      vault.save();

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/vault.json",
        expect.any(String),
        expect.objectContaining({ mode: 0o600 }),
      );

      // Verify the saved content is valid JSON with correct structure
      const savedContent = mockedFs.writeFileSync.mock.calls[0]![1] as string;
      const parsed = JSON.parse(savedContent) as { version: number; entries: Record<string, unknown> };
      expect(parsed.version).toBe(1);
      expect(parsed.entries).toHaveProperty("secret");
    });
  });
});
