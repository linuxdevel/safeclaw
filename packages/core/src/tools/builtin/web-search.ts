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

    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        count: {
          type: "number",
          description: "Number of results to return (1-20, default 5)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },

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
