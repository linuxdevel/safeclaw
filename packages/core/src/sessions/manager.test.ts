import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./manager.js";
import type { SessionStore } from "./store.js";
import type { PeerIdentity, SessionData } from "./types.js";

const peerA: PeerIdentity = { channelId: "ch-1", peerId: "peer-1" };
const peerB: PeerIdentity = { channelId: "ch-1", peerId: "peer-2" };

describe("SessionManager", () => {
  it("create makes a new session with unique id", () => {
    const manager = new SessionManager();
    const s1 = manager.create(peerA);
    const s2 = manager.create(peerB);
    expect(s1.id).toBeTruthy();
    expect(s2.id).toBeTruthy();
    expect(s1.id).not.toBe(s2.id);
  });

  it("getOrCreate returns existing session for same peer", () => {
    const manager = new SessionManager();
    const s1 = manager.getOrCreate(peerA);
    const s2 = manager.getOrCreate(peerA);
    expect(s1).toBe(s2);
  });

  it("getOrCreate creates new session for different peer", () => {
    const manager = new SessionManager();
    const s1 = manager.getOrCreate(peerA);
    const s2 = manager.getOrCreate(peerB);
    expect(s1).not.toBe(s2);
    expect(s1.id).not.toBe(s2.id);
  });

  it("get retrieves by session id", () => {
    const manager = new SessionManager();
    const session = manager.create(peerA);
    expect(manager.get(session.id)).toBe(session);
  });

  it("getByPeer retrieves by peer identity", () => {
    const manager = new SessionManager();
    const session = manager.create(peerA);
    expect(manager.getByPeer(peerA)).toBe(session);
  });

  it("destroy removes session, returns true", () => {
    const manager = new SessionManager();
    const session = manager.create(peerA);
    expect(manager.destroy(session.id)).toBe(true);
    expect(manager.get(session.id)).toBeUndefined();
    expect(manager.getByPeer(peerA)).toBeUndefined();
  });

  it("destroy returns false for unknown id", () => {
    const manager = new SessionManager();
    expect(manager.destroy("nonexistent")).toBe(false);
  });

  it("listSessions returns metadata array", () => {
    const manager = new SessionManager();
    manager.create(peerA);
    manager.create(peerB);
    const list = manager.listSessions();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBeTruthy();
    expect(list[0]?.peer).toBeDefined();
    expect(list[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("activeCount reflects current session count", () => {
    const manager = new SessionManager();
    expect(manager.activeCount).toBe(0);
    const s1 = manager.create(peerA);
    expect(manager.activeCount).toBe(1);
    manager.create(peerB);
    expect(manager.activeCount).toBe(2);
    manager.destroy(s1.id);
    expect(manager.activeCount).toBe(1);
  });
});

function createMockStore(sessions: Map<string, SessionData> = new Map()): SessionStore {
  return {
    save: vi.fn(async (data: SessionData) => {
      sessions.set(data.metadata.id, structuredClone(data));
    }),
    load: vi.fn(async (id: string) => {
      const d = sessions.get(id);
      return d ? structuredClone(d) : null;
    }),
    list: vi.fn(async () => [...sessions.keys()]),
    delete: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
  };
}

describe("SessionManager with store", () => {
  it("save persists a session via the store", async () => {
    const store = createMockStore();
    const manager = new SessionManager(store);
    const session = manager.create(peerA);
    session.addMessage({ role: "user", content: "hello" });

    await manager.save(session.id);

    expect(store.save).toHaveBeenCalledOnce();
    const savedData = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SessionData;
    expect(savedData.metadata.id).toBe(session.id);
    expect(savedData.history).toHaveLength(1);
  });

  it("save throws for unknown session id", async () => {
    const store = createMockStore();
    const manager = new SessionManager(store);

    await expect(manager.save("nonexistent")).rejects.toThrow(/not found/i);
  });

  it("save is a no-op when no store is configured", async () => {
    const manager = new SessionManager();
    const session = manager.create(peerA);

    // Should not throw
    await manager.save(session.id);
  });

  it("loadAll restores persisted sessions", async () => {
    const sessions = new Map<string, SessionData>();
    sessions.set("sess-1", {
      metadata: {
        id: "sess-1",
        peer: peerA,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:01:00Z"),
        messageCount: 1,
      },
      history: [{ role: "user", content: "hello" }],
    });
    const store = createMockStore(sessions);
    const manager = new SessionManager(store);

    const count = await manager.loadAll();

    expect(count).toBe(1);
    expect(manager.activeCount).toBe(1);
    const loaded = manager.get("sess-1");
    expect(loaded).toBeDefined();
    expect(loaded!.getHistory()).toHaveLength(1);
    expect(loaded!.peer).toEqual(peerA);
  });

  it("loadAll populates peer index so getByPeer works", async () => {
    const sessions = new Map<string, SessionData>();
    sessions.set("sess-1", {
      metadata: {
        id: "sess-1",
        peer: peerA,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:01:00Z"),
        messageCount: 0,
      },
      history: [],
    });
    const store = createMockStore(sessions);
    const manager = new SessionManager(store);
    await manager.loadAll();

    const found = manager.getByPeer(peerA);
    expect(found).toBeDefined();
    expect(found!.id).toBe("sess-1");
  });

  it("loadAll returns 0 when no store is configured", async () => {
    const manager = new SessionManager();
    const count = await manager.loadAll();
    expect(count).toBe(0);
  });

  it("destroy deletes from store", async () => {
    const store = createMockStore();
    const manager = new SessionManager(store);
    const session = manager.create(peerA);
    await manager.save(session.id);

    manager.destroy(session.id);

    expect(store.delete).toHaveBeenCalledWith(session.id);
  });
});
