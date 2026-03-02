import { describe, it, expect } from "vitest";
import { Session } from "./session.js";
import type { PeerIdentity } from "./types.js";
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
});
