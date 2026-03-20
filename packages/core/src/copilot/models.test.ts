import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listCopilotModels, listCopilotModelsFromApi } from "./models.js";
import type { CopilotModelInfo } from "./models.js";

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

describe("listCopilotModelsFromApi", () => {
  it("returns chat and completion models with correct conversational flag", async () => {
    const apiResponse = {
      data: [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", capabilities: { type: "chat" } },
        { id: "gpt-5.3-codex", name: "GPT Codex", capabilities: { type: "completions" } },
        { id: "gpt-4.1", name: "GPT-4.1", capabilities: { type: "chat" } },
      ],
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(apiResponse),
    } as Response);

    const result = await listCopilotModelsFromApi("test-copilot-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-copilot-token",
          "Copilot-Integration-Id": "vscode-chat",
        }),
      }),
    );
    expect(result).toEqual<CopilotModelInfo[]>([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", conversational: true },
      { id: "gpt-5.3-codex", name: "GPT Codex", conversational: false },
      { id: "gpt-4.1", name: "GPT-4.1", conversational: true },
    ]);
  });

  it("treats unknown capabilities.type as non-conversational", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: "embed-1", name: "Embeddings", capabilities: { type: "embeddings" } }],
      }),
    } as Response);
    const result = await listCopilotModelsFromApi("tok");
    expect(result).toEqual([{ id: "embed-1", name: "Embeddings", conversational: false }]);
  });

  it("treats missing capabilities as non-conversational", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "mystery", name: "Mystery" }] }),
    } as Response);
    const result = await listCopilotModelsFromApi("tok");
    expect(result).toEqual([{ id: "mystery", name: "Mystery", conversational: false }]);
  });

  it("returns null on non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });

  it("returns null on empty data array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    } as Response);
    expect(await listCopilotModelsFromApi("tok")).toBeNull();
  });
});
