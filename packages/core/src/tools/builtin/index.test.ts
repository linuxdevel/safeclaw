import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "./index.js";
import { ProcessManager } from "../process-manager.js";

describe("createBuiltinTools", () => {
  it("returns the 6 core tools when called without options", () => {
    const tools = createBuiltinTools();

    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
    expect(names).toContain("web_fetch");
    expect(names).toContain("apply_patch");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("process");
  });

  it("includes web_search when braveApiKey is provided", () => {
    const tools = createBuiltinTools({ braveApiKey: "test-key" });

    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_search");
  });

  it("excludes web_search when braveApiKey is not provided", () => {
    const tools = createBuiltinTools({});

    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("web_search");
  });

  it("includes process tool when processManager is provided", () => {
    const pm = new ProcessManager();
    try {
      const tools = createBuiltinTools({ processManager: pm });

      expect(tools).toHaveLength(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain("process");
    } finally {
      pm.shutdown();
    }
  });

  it("includes both optional tools when both options provided", () => {
    const pm = new ProcessManager();
    try {
      const tools = createBuiltinTools({ braveApiKey: "key", processManager: pm });

      expect(tools).toHaveLength(8);
      const names = tools.map((t) => t.name);
      expect(names).toContain("web_search");
      expect(names).toContain("process");
    } finally {
      pm.shutdown();
    }
  });
});
