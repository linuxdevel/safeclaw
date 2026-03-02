import { describe, it, expect } from "vitest";
import { SessionManager } from "./manager.js";
import type { PeerIdentity } from "./types.js";

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
