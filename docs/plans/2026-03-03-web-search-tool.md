# Web Search Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `web_search` builtin tool that searches the web via Brave Search API and returns formatted results for LLM consumption.

**Architecture:** Create a new `ToolHandler` via a factory function `createWebSearchTool(apiKey: string)` in the builtin directory. The API key is injected at tool creation time (read from vault during bootstrap), so it never appears in tool arguments. The tool requires `net:https` capability (the HTTPS call to Brave) but not `secret:read` since the secret is resolved before tool creation. Results are formatted as a numbered text list for LLM readability. The tool is conditionally included -- only present when a `brave_api_key` exists in the vault.

**Tech Stack:** TypeScript, Brave Search API, Vitest

---

### Task 1: Create web_search tool with tests

**Files:**
- Create: `packages/core/src/tools/builtin/web-search.ts`
- Create: `packages/core/src/tools/builtin/web-search.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/tools/builtin/web-search.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/web-search.test.ts`

Expected: FAIL -- cannot find module `./web-search.js`.

**Step 3: Write minimal implementation**

Create `packages/core/src/tools/builtin/web-search.ts`:

```typescript
import type { ToolHandler } from "../types.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MIN_COUNT = 1;
const DEFAULT_TIMEOUT = 15_000;

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

/**
 * Creates a web_search tool handler with the given Brave Search API key.
 * The API key is injected at creation time so it never appears in tool arguments.
 */
export function createWebSearchTool(apiKey: string): ToolHandler {
  return {
    name: "web_search",
    description:
      "Search the web using Brave Search and return a list of results with titles, URLs, and descriptions",
    requiredCapabilities: ["net:https"],

    async execute(args: Record<string, unknown>): Promise<string> {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") {
        throw new Error("Required argument 'query' must be a non-empty string");
      }

      let count = DEFAULT_COUNT;
      if (args["count"] !== undefined) {
        count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Number(args["count"])));
      }

      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      try {
        const response = await fetch(url.href, {
          headers: {
            "Accept": "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Brave Search API error: HTTP ${response.status} ${response.statusText}\n${body}`,
          );
        }

        const data = (await response.json()) as BraveSearchResponse;
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return `No results found for: ${query}`;
        }

        return results
          .map((r, i) => {
            const age = r.age ? ` (${r.age})` : "";
            return `${i + 1}. ${r.title}${age}\n   ${r.url}\n   ${r.description}`;
          })
          .join("\n\n");
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/web-search.test.ts`

Expected: PASS -- all 10 tests green.

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/web-search.ts \
       packages/core/src/tools/builtin/web-search.test.ts
git commit -m "feat(tools): add web_search tool with Brave Search API"
```

---

### Task 2: Update `createBuiltinTools` to accept options

**Files:**
- Modify: `packages/core/src/tools/builtin/index.ts`

**Step 1: Write the failing test**

There are no existing tests for `createBuiltinTools()`. Create `packages/core/src/tools/builtin/index.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "./index.js";

describe("createBuiltinTools", () => {
  it("returns the 5 core tools when called without options", () => {
    const tools = createBuiltinTools();

    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("web_search");
  });

  it("includes web_search when braveApiKey is provided", () => {
    const tools = createBuiltinTools({ braveApiKey: "test-key" });

    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_search");
  });

  it("excludes web_search when braveApiKey is not provided", () => {
    const tools = createBuiltinTools({});

    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("web_search");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/index.test.ts`

Expected: FAIL -- `createBuiltinTools` does not accept arguments / web_search not included.

**Step 3: Write minimal implementation**

Update `packages/core/src/tools/builtin/index.ts` to the following:

```typescript
import type { ToolHandler } from "../types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { webFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";

export { readTool, writeTool, editTool, bashTool, webFetchTool };
export { createWebSearchTool } from "./web-search.js";

export interface BuiltinToolsOptions {
  braveApiKey?: string;
}

/** Creates an array of all built-in tool handlers. */
export function createBuiltinTools(options?: BuiltinToolsOptions): ToolHandler[] {
  const tools: ToolHandler[] = [readTool, writeTool, editTool, bashTool, webFetchTool];

  if (options?.braveApiKey) {
    tools.push(createWebSearchTool(options.braveApiKey));
  }

  return tools;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/index.test.ts`

Expected: PASS -- all 3 tests green.

**Step 5: Commit**

```bash
git add packages/core/src/tools/builtin/index.ts \
       packages/core/src/tools/builtin/index.test.ts
git commit -m "feat(tools): make createBuiltinTools accept braveApiKey option"
```

---

### Task 3: Update barrel exports

**Files:**
- Modify: `packages/core/src/tools/index.ts:9-16`

**Step 1: Add exports**

Update `packages/core/src/tools/index.ts` to export the new symbols. Change the `from "./builtin/index.js"` block:

```typescript
export {
  createBuiltinTools,
  readTool,
  writeTool,
  editTool,
  bashTool,
  webFetchTool,
  createWebSearchTool,
} from "./builtin/index.js";
export type { BuiltinToolsOptions } from "./builtin/index.js";
```

**Step 2: Verify it compiles**

Run: `npx tsc --build --dry 2>&1 | head -10`

Expected: No type errors (or only the bootstrap call-site error from Task 4, since `createBuiltinTools` is backward-compatible with no args).

**Step 3: Commit**

```bash
git add packages/core/src/tools/index.ts
git commit -m "feat(tools): export createWebSearchTool and BuiltinToolsOptions"
```

---

### Task 4: Update bootstrap to pass Brave API key from vault

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:156-159`

**Step 1: Write the change**

In `packages/cli/src/commands/bootstrap.ts`, update the section around lines 156-159 where `createBuiltinTools()` is called. Read `brave_api_key` from the vault and pass it as an option:

Replace this block (lines 156-159):

```typescript
  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools()) {
    toolRegistry.register(tool);
  }
```

With:

```typescript
  const braveApiKey = vault.get("brave_api_key");
  const toolRegistry = new SimpleToolRegistry();
  for (const tool of createBuiltinTools({ braveApiKey })) {
    toolRegistry.register(tool);
  }
```

No new import is needed -- `createBuiltinTools` is already imported from `@safeclaw/core` on line 17.

**Step 2: Verify it compiles**

Run: `npx tsc --build --dry 2>&1 | head -10`

Expected: No type errors. `vault.get()` returns `string | undefined`, which matches the `braveApiKey?: string` option type.

**Step 3: Run existing bootstrap tests**

Run: `npx vitest run packages/cli/src/commands/bootstrap.test.ts`

Expected: PASS -- existing tests don't provide `brave_api_key` in the mock vault, so `createBuiltinTools()` is called with `{ braveApiKey: undefined }`, which is equivalent to the old no-args call.

**Step 4: Commit**

```bash
git add packages/cli/src/commands/bootstrap.ts
git commit -m "feat(cli): pass brave_api_key from vault to createBuiltinTools"
```

---

### Task 5: Full verification

**Step 1: Type-check all packages**

Run: `pnpm typecheck`

Expected: No type errors.

**Step 2: Run full test suite**

Run: `pnpm test`

Expected: All tests pass, including the new web-search and index tests.

**Step 3: Run linter**

Run: `pnpm lint`

Expected: No lint errors.

**Step 4: Final commit (if any lint/type fixes were needed)**

If any fixes were required, commit them:

```bash
git add -A
git commit -m "fix(tools): address lint/type issues in web_search tool"
```
