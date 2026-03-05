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
