import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore } from "./store.js";
import { SessionManager } from "./manager.js";
import type { PeerIdentity } from "./types.js";

const peer: PeerIdentity = { channelId: "cli", peerId: "local" };

describe("Session persistence integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "safeclaw-persist-int-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("session survives manager restart", async () => {
    // First "process": create session, add messages, save
    const store1 = new FileSessionStore(tmpDir);
    const manager1 = new SessionManager(store1);
    const session = manager1.create(peer);
    session.addMessage({ role: "user", content: "What is 2+2?" });
    session.addMessage({ role: "assistant", content: "4" });
    await manager1.save(session.id);

    // Second "process": new manager with same store, loadAll
    const store2 = new FileSessionStore(tmpDir);
    const manager2 = new SessionManager(store2);
    const loaded = await manager2.loadAll();

    expect(loaded).toBe(1);
    const restored = manager2.getByPeer(peer);
    expect(restored).toBeDefined();
    expect(restored!.getHistory()).toHaveLength(2);
    expect(restored!.getHistory()[0]?.content).toBe("What is 2+2?");
    expect(restored!.getHistory()[1]?.content).toBe("4");
    expect(restored!.metadata.peer).toEqual(peer);
  });

  it("getOrCreate resumes persisted session instead of creating new one", async () => {
    // First process
    const store1 = new FileSessionStore(tmpDir);
    const manager1 = new SessionManager(store1);
    const session = manager1.create(peer);
    session.addMessage({ role: "user", content: "hello" });
    await manager1.save(session.id);
    const originalId = session.id;

    // Second process
    const store2 = new FileSessionStore(tmpDir);
    const manager2 = new SessionManager(store2);
    await manager2.loadAll();
    const resumed = manager2.getOrCreate(peer);

    expect(resumed.id).toBe(originalId);
    expect(resumed.getHistory()).toHaveLength(1);
  });

  it("destroy removes persisted session file", async () => {
    const store = new FileSessionStore(tmpDir);
    const manager = new SessionManager(store);
    const session = manager.create(peer);
    session.addMessage({ role: "user", content: "hello" });
    await manager.save(session.id);

    manager.destroy(session.id);

    // Allow fire-and-forget delete to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // New manager should find no sessions
    const store2 = new FileSessionStore(tmpDir);
    const manager2 = new SessionManager(store2);
    const loaded = await manager2.loadAll();
    expect(loaded).toBe(0);
  });
});
