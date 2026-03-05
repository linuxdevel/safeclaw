import { describe, it, expect, vi, beforeEach } from "vitest";
import { webFetchTool } from "./web-fetch.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("webFetchTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("has correct name and metadata", () => {
    expect(webFetchTool.name).toBe("web_fetch");
    expect(webFetchTool.description).toBeTruthy();
    expect(webFetchTool.requiredCapabilities).toEqual(["net:https"]);
  });

  it("exposes a valid JSON Schema for parameters", () => {
    expect(webFetchTool.parameters).toEqual({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTPS URL to fetch",
        },
        format: {
          type: "string",
          description: "Response format",
          enum: ["text", "json"],
          default: "text",
        },
      },
      required: ["url"],
      additionalProperties: false,
    });
  });

  it("fetches a URL and returns text body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "page content",
    });

    const result = await webFetchTool.execute({ url: "https://example.com" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain("page content");
  });

  it("returns JSON formatted output when format is json", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ key: "value" }),
    });

    const result = await webFetchTool.execute({
      url: "https://api.example.com/data",
      format: "json",
    });

    expect(result).toContain("key");
    expect(result).toContain("value");
  });

  it("rejects non-https URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "http://example.com" }),
    ).rejects.toThrow(/https/i);
  });

  it("rejects missing url argument", async () => {
    await expect(webFetchTool.execute({})).rejects.toThrow(/url/i);
  });

  it("rejects non-string url", async () => {
    await expect(webFetchTool.execute({ url: 42 })).rejects.toThrow(/url/i);
  });

  it("rejects invalid URL strings", async () => {
    await expect(
      webFetchTool.execute({ url: "not-a-url" }),
    ).rejects.toThrow(/url/i);
  });

  it("reports HTTP error status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Not Found",
    });

    const result = await webFetchTool.execute({ url: "https://example.com/missing" });

    expect(result).toContain("404");
  });

  it("surfaces fetch errors", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"));

    await expect(
      webFetchTool.execute({ url: "https://unreachable.example.com" }),
    ).rejects.toThrow(/network failure/);
  });
});
