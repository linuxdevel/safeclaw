import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listCopilotModels } from "./models.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listCopilotModels", () => {
  it("returns model IDs from github-copilot provider", async () => {
    const registry = {
      "github-copilot": {
        models: {
          "claude-sonnet-4": { cost: { input: 0, output: 0 } },
          "gpt-4.1": { cost: { input: 0, output: 0 } },
        },
      },
      "openai": {
        models: {
          "gpt-4.1": { cost: { input: 5, output: 15 } },
        },
      },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(registry),
    } as Response);

    const result = await listCopilotModels();

    expect(result).toEqual(["claude-sonnet-4", "gpt-4.1"]);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://models.dev/api.json");
  });

  it("returns null when github-copilot provider is missing", async () => {
    const registry = {
      "openai": {
        models: {
          "gpt-4.1": { cost: { input: 5, output: 15 } },
        },
      },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(registry),
    } as Response);

    const result = await listCopilotModels();

    expect(result).toBeNull();
  });

  it("returns null on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const result = await listCopilotModels();

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const result = await listCopilotModels();

    expect(result).toBeNull();
  });

  it("returns null when models object is empty", async () => {
    const registry = {
      "github-copilot": {
        models: {},
      },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(registry),
    } as Response);

    const result = await listCopilotModels();

    expect(result).toBeNull();
  });
});
