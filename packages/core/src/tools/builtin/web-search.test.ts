import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebSearchTool } from "./web-search.js";
import type { ToolHandler } from "../types.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("createWebSearchTool", () => {
  let tool: ToolHandler;

  beforeEach(() => {
    vi.resetAllMocks();
    tool = createWebSearchTool("test-api-key-123");
  });

  it("has correct name and metadata", () => {
    expect(tool.name).toBe("web_search");
    expect(tool.description).toBeTruthy();
    expect(tool.requiredCapabilities).toEqual(["net:https"]);
  });

  it("returns formatted search results", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "TypeScript Docs",
              url: "https://www.typescriptlang.org",
              description: "TypeScript is a typed superset of JavaScript.",
              age: "2 days ago",
            },
            {
              title: "Node.js",
              url: "https://nodejs.org",
              description: "Node.js is a JavaScript runtime.",
              age: "1 week ago",
            },
          ],
        },
      }),
    });

    const result = await tool.execute({ query: "typescript node.js" });

    // Verify API was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(url).toContain("q=typescript+node.js");
    expect(url).toContain("count=5");
    expect((options.headers as Record<string, string>)["X-Subscription-Token"]).toBe(
      "test-api-key-123",
    );

    // Verify formatted output
    expect(result).toContain("1.");
    expect(result).toContain("TypeScript Docs");
    expect(result).toContain("https://www.typescriptlang.org");
    expect(result).toContain("TypeScript is a typed superset of JavaScript.");
    expect(result).toContain("2.");
    expect(result).toContain("Node.js");
  });

  it("throws on missing query argument", async () => {
    await expect(tool.execute({})).rejects.toThrow(/query/i);
  });

  it("throws on non-string query", async () => {
    await expect(tool.execute({ query: 42 })).rejects.toThrow(/query/i);
  });

  it("throws on empty query", async () => {
    await expect(tool.execute({ query: "" })).rejects.toThrow(/query/i);
  });

  it("reports API error responses", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "Rate limit exceeded",
    });

    await expect(
      tool.execute({ query: "test query" }),
    ).rejects.toThrow(/429/);
  });

  it("respects custom count parameter", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await tool.execute({ query: "test", count: 10 });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("count=10");
  });

  it("clamps count to valid range (1-20)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await tool.execute({ query: "test", count: 50 });
    const [url1] = mockFetch.mock.calls[0] as [string];
    expect(url1).toContain("count=20");

    await tool.execute({ query: "test", count: 0 });
    const [url2] = mockFetch.mock.calls[1] as [string];
    expect(url2).toContain("count=1");
  });

  it("returns a message when no results found", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    const result = await tool.execute({ query: "xyzzy obscure query" });

    expect(result).toContain("No results");
  });

  it("handles missing web.results gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await tool.execute({ query: "test" });

    expect(result).toContain("No results");
  });

  it("surfaces fetch errors", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"));

    await expect(
      tool.execute({ query: "test" }),
    ).rejects.toThrow(/network failure/);
  });
});
