import { describe, it, expect, vi } from "vitest";
import { ChatCommandHandler } from "./chat-commands.js";
import type { Agent, Session, SessionManager } from "@safeclaw/core";

function makeDeps(overrides: Partial<{
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
  model: string;
}> = {}) {
  const session = overrides.session ?? {
    id: "test-id",
    metadata: {
      id: "test-id",
      peer: { channelId: "cli", peerId: "local" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      messageCount: 5,
    },
    clearHistory: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
  } as unknown as Session;

  const sessionManager = overrides.sessionManager ?? {
    activeCount: 1,
    listSessions: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager;

  const agent = overrides.agent ?? {
    processMessage: vi.fn().mockResolvedValue({
      message: "ok",
      toolCallsMade: 0,
      model: "claude-sonnet-4",
    }),
  } as unknown as Agent;

  const model = overrides.model ?? "claude-sonnet-4";

  return { session, sessionManager, agent, model };
}

describe("ChatCommandHandler", () => {
  describe("isCommand", () => {
    it("returns true for strings starting with /", () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      expect(handler.isCommand("/help")).toBe(true);
      expect(handler.isCommand("/new")).toBe(true);
    });

    it("returns false for regular messages", () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      expect(handler.isCommand("hello")).toBe(false);
      expect(handler.isCommand("")).toBe(false);
      expect(handler.isCommand("what is /help?")).toBe(false);
    });
  });

  describe("/help", () => {
    it("lists all available commands", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/help");
      expect(result).toContain("/new");
      expect(result).toContain("/status");
      expect(result).toContain("/compact");
      expect(result).toContain("/model");
      expect(result).toContain("/help");
    });
  });

  describe("/new", () => {
    it("clears session history", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      await handler.execute("/new");
      expect(deps.session.clearHistory).toHaveBeenCalled();
    });

    it("returns confirmation message", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/new");
      expect(result).toContain("Session cleared");
    });
  });

  describe("/status", () => {
    it("shows session id and message count", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("test-id");
      expect(result).toContain("5");
    });

    it("shows the current model", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("claude-sonnet-4");
    });

    it("shows created and updated timestamps", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/status");
      expect(result).toContain("2026-01-01");
    });
  });

  describe("/compact", () => {
    it("returns placeholder message", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/compact");
      expect(result).toContain("not yet implemented");
    });
  });

  describe("/model", () => {
    it("shows current model when called without args", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/model");
      expect(result).toContain("claude-sonnet-4");
    });

    it("changes model when called with an argument", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/model gpt-4o");
      expect(result).toContain("gpt-4o");
      expect(result).toContain("changed");
    });

    it("updates the model so /status reflects the change", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      await handler.execute("/model gpt-4o");
      const status = await handler.execute("/status");
      expect(status).toContain("gpt-4o");
    });
  });

  describe("unknown command", () => {
    it("returns an error message with the unknown command name", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/foo");
      expect(result).toContain("Unknown command");
      expect(result).toContain("/foo");
    });

    it("suggests /help", async () => {
      const deps = makeDeps();
      const handler = new ChatCommandHandler(deps);
      const result = await handler.execute("/notreal");
      expect(result).toContain("/help");
    });
  });
});
