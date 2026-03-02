import { readFileSync } from "node:fs";
import type { SkillManifest } from "../capabilities/types.js";
import type { LoadResult } from "./types.js";

const REQUIRED_FIELDS = ["id", "version", "name"] as const;

export class SkillLoader {
  loadFromFile(path: string): LoadResult {
    try {
      const content = readFileSync(path, "utf-8");
      return this.parse(content);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  loadFromString(json: string): LoadResult {
    return this.parse(json);
  }

  private parse(json: string): LoadResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { success: false, error: "Manifest must be a JSON object" };
    }

    const obj = parsed as Record<string, unknown>;

    for (const field of REQUIRED_FIELDS) {
      if (typeof obj[field] !== "string" || obj[field] === "") {
        return { success: false, error: `Missing required field: ${field}` };
      }
    }

    return { success: true, manifest: obj as unknown as SkillManifest };
  }
}
