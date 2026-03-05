import type { ToolHandler } from "../types.js";

const DEFAULT_TIMEOUT = 30_000;

export const webFetchTool: ToolHandler = {
  name: "web_fetch",
  description: "Fetch a URL via HTTPS and return the response body",
  requiredCapabilities: ["net:https"],

  parameters: {
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
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const urlArg = args["url"];
    if (typeof urlArg !== "string") {
      throw new Error("Required argument 'url' must be a string");
    }

    let parsed: URL;
    try {
      parsed = new URL(urlArg);
    } catch {
      throw new Error("Invalid url: must be a valid URL");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Only https URLs are allowed");
    }

    const format =
      args["format"] !== undefined ? String(args["format"]) : "text";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const response = await fetch(parsed.href, { signal: controller.signal });

      if (!response.ok) {
        const body = await response.text();
        return `HTTP ${response.status} ${response.statusText}\n${body}`;
      }

      if (format === "json") {
        const data: unknown = await response.json();
        return JSON.stringify(data, null, 2);
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
