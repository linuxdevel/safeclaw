import { describe, it, expect } from "vitest";
import { Session } from "./session.js";
import type { PeerIdentity, SessionData } from "./types.js";
import type { ChatMessage } from "../copilot/types.js";

const testPeer: PeerIdentity = {
  channelId: "channel-1",
  peerId: "peer-1",
};

function makeMessage(content: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { role, content };
}

describe("Session", () => {
  it("creates session with correct id and peer", () => {
    const session = new Session("sess-1", testPeer);
    expect(session.id).toBe("sess-1");
    expect(session.peer).toEqual(testPeer);
  });

  it("addMessage adds to history and updates metadata", () => {
    const session = new Session("sess-1", testPeer);
    session.addMessage(makeMessage("hello"));
    expect(session.getHistory()).toHaveLength(1);
    expect(session.getHistory()[0]?.content).toBe("hello");
    expect(session.metadata.messageCount).toBe(1);
  });

  it("getHistory returns a copy (mutating returned array does not affect session)", () => {
    const session = new Session("sess-1", testPeer);
    session.addMessage(makeMessage("hello"));
    const history = session.getHistory();
    history.push(makeMessage("injected"));
    expect(session.getHistory()).toHaveLength(1);
  });

  it("clearHistory resets messages and count", () => {
    const session = new Session("sess-1", testPeer);
    session.addMessage(makeMessage("hello"));
    session.addMessage(makeMessage("world"));
    session.clearHistory();
    expect(session.getHistory()).toHaveLength(0);
    expect(session.metadata.messageCount).toBe(0);
  });

  it("toJSON returns serializable snapshot", () => {
    const session = new Session("sess-1", testPeer);
    session.addMessage(makeMessage("hello"));
    const data = session.toJSON();
    expect(data.metadata.id).toBe("sess-1");
    expect(data.metadata.peer).toEqual(testPeer);
    expect(data.metadata.messageCount).toBe(1);
    expect(data.history).toHaveLength(1);
    expect(data.history[0]?.content).toBe("hello");
  });

  it("updatedAt changes when messages added", async () => {
    const session = new Session("sess-1", testPeer);
    const before = session.metadata.updatedAt.getTime();
    // Small delay to ensure Date changes
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.addMessage(makeMessage("hello"));
    const after = session.metadata.updatedAt.getTime();
    expect(after).toBeGreaterThan(before);
  });

  it("fromData reconstructs a session from persisted data", () => {
    const data: SessionData = {
      metadata: {
        id: "restored-1",
        peer: { channelId: "ch-1", peerId: "p-1" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:05:00Z"),
        messageCount: 2,
      },
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };

    const session = Session.fromData(data);

    expect(session.id).toBe("restored-1");
    expect(session.peer).toEqual({ channelId: "ch-1", peerId: "p-1" });
    expect(session.metadata.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(session.metadata.updatedAt.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(session.getHistory()).toHaveLength(2);
    expect(session.metadata.messageCount).toBe(2);
  });

  it("fromData produces independent copy (mutating input does not affect session)", () => {
    const history = [{ role: "user" as const, content: "hello" }];
    const data: SessionData = {
      metadata: {
        id: "restored-2",
        peer: { channelId: "ch-1", peerId: "p-1" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:05:00Z"),
        messageCount: 1,
      },
      history,
    };

    const session = Session.fromData(data);
    history.push({ role: "user", content: "injected" });

    expect(session.getHistory()).toHaveLength(1);
  });

  describe("setHistory", () => {
    it("replaces all messages with provided array", () => {
      const session = new Session("s1", testPeer);
      session.addMessage({ role: "user", content: "old message" });
      session.addMessage({ role: "assistant", content: "old reply" });

      const newHistory: ChatMessage[] = [
        { role: "user", content: "summary of old conversation" },
        { role: "user", content: "recent message" },
        { role: "assistant", content: "recent reply" },
      ];
      session.setHistory(newHistory);

      const history = session.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toBe("summary of old conversation");
    });

    it("defensive-copies input messages", () => {
      const session = new Session("s1", testPeer);
      const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];
      session.setHistory(msgs);

      msgs[0]!.content = "mutated";
      expect(session.getHistory()[0]!.content).toBe("hello");
    });

    it("updates the updatedAt timestamp", () => {
      const session = new Session("s1", testPeer);
      const before = session.metadata.updatedAt;

      session.setHistory([{ role: "user", content: "new" }]);
      const after = session.metadata.updatedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });
});
