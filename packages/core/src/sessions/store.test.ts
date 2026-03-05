import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore } from "./store.js";
import type { SessionData } from "./types.js";

function makeSessionData(id: string): SessionData {
  return {
    metadata: {
      id,
      peer: { channelId: "cli", peerId: "local" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      messageCount: 1,
    },
    history: [{ role: "user", content: "hello" }],
  };
}

describe("FileSessionStore", () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "safeclaw-session-test-"));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save creates sessions directory and writes JSON file", async () => {
    const data = makeSessionData("sess-1");
    await store.save(data);

    const filePath = join(tmpDir, "sessions", "sess-1.json");
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.metadata.id).toBe("sess-1");
    expect(parsed.history).toHaveLength(1);
  });

  it("save writes file with 0o600 permissions", async () => {
    const data = makeSessionData("sess-1");
    await store.save(data);

    const filePath = join(tmpDir, "sessions", "sess-1.json");
    const stat = statSync(filePath);
    // 0o600 = 0o100600 (regular file) & 0o777 = 0o600 = 384
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("load returns saved session data", async () => {
    const data = makeSessionData("sess-1");
    await store.save(data);

    const loaded = await store.load("sess-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.id).toBe("sess-1");
    expect(loaded!.metadata.peer).toEqual({ channelId: "cli", peerId: "local" });
    expect(loaded!.history).toHaveLength(1);
    expect(loaded!.history[0]?.content).toBe("hello");
  });

  it("load returns null for non-existent session", async () => {
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("load reconstructs Date objects in metadata", async () => {
    const data = makeSessionData("sess-1");
    await store.save(data);

    const loaded = await store.load("sess-1");
    expect(loaded!.metadata.createdAt).toBeInstanceOf(Date);
    expect(loaded!.metadata.updatedAt).toBeInstanceOf(Date);
    expect(loaded!.metadata.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("list returns empty array when no sessions exist", async () => {
    const ids = await store.list();
    expect(ids).toEqual([]);
  });

  it("list returns saved session ids", async () => {
    await store.save(makeSessionData("sess-1"));
    await store.save(makeSessionData("sess-2"));

    const ids = await store.list();
    expect(ids.sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("delete removes session file", async () => {
    await store.save(makeSessionData("sess-1"));
    await store.delete("sess-1");

    const loaded = await store.load("sess-1");
    expect(loaded).toBeNull();
  });

  it("delete does not throw for non-existent session", async () => {
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("save overwrites existing session", async () => {
    const data = makeSessionData("sess-1");
    await store.save(data);

    data.history.push({ role: "assistant", content: "hi back" });
    data.metadata.messageCount = 2;
    await store.save(data);

    const loaded = await store.load("sess-1");
    expect(loaded!.history).toHaveLength(2);
    expect(loaded!.metadata.messageCount).toBe(2);
  });

  it("rejects session ids with path traversal characters", async () => {
    const data = makeSessionData("../../../etc/passwd");
    await expect(store.save(data)).rejects.toThrow(/invalid session id/i);
  });
});
