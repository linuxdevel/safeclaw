import { describe, it, expect, vi, beforeEach } from "vitest";
import * as child_process from "node:child_process";

vi.mock("node:child_process");

const mockedCp = vi.mocked(child_process);

const { KeyringProvider } = await import("./keyring.js");

describe("KeyringProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("store", () => {
    it("calls secret-tool store with correct args", () => {
      mockedCp.execFileSync.mockReturnValue(Buffer.from(""));
      const provider = new KeyringProvider("safeclaw");
      const key = Buffer.from("a".repeat(32));

      provider.store(key);

      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        "secret-tool",
        [
          "store",
          "--label",
          "safeclaw master key",
          "application",
          "safeclaw",
          "type",
          "master-key",
        ],
        expect.objectContaining({
          input: key.toString("base64"),
        }),
      );
    });
  });

  describe("retrieve", () => {
    it("decodes base64 output from secret-tool", () => {
      const key = Buffer.from("b".repeat(32));
      mockedCp.execFileSync.mockReturnValue(
        Buffer.from(key.toString("base64")),
      );
      const provider = new KeyringProvider("safeclaw");

      const result = provider.retrieve();

      expect(result).not.toBeNull();
      expect(result!.equals(key)).toBe(true);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        "secret-tool",
        ["lookup", "application", "safeclaw", "type", "master-key"],
        expect.any(Object),
      );
    });

    it("returns null when no entry found", () => {
      mockedCp.execFileSync.mockImplementation(() => {
        throw new Error("No matching secret found");
      });
      const provider = new KeyringProvider("safeclaw");

      const result = provider.retrieve();

      expect(result).toBeNull();
    });
  });
});
