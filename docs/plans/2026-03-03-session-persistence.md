# Session Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist chat sessions to disk as JSON files so they survive process restart and can be resumed.

**Architecture:** Create a `SessionStore` interface with a `FileSessionStore` implementation that saves/loads `SessionData` to `~/.safeclaw/sessions/<id>.json` with 0o600 permissions. `SessionManager` accepts an optional store via constructor injection. The caller (agent loop / CLI wiring) calls `sessionManager.save(session.id)` after `processMessage()` returns, keeping `addMessage()` synchronous. On startup, `SessionManager.loadAll()` restores persisted sessions into memory.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest

---

## Task 1: Create `SessionStore` interface and `FileSessionStore` class

**Files:**
- Create: `packages/core/src/sessions/store.ts`
- Test: `packages/core/src/sessions/store.test.ts`

### Step 1: Write the failing tests

Create `packages/core/src/sessions/store.test.ts`:

```typescript
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
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/core/src/sessions/store.test.ts`
Expected: FAIL — `store.js` does not exist.

### Step 3: Write the implementation

Create `packages/core/src/sessions/store.ts`:

```typescript
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionData } from "./types.js";

const SESSION_FILE_MODE = 0o600;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Persistence interface for session data.
 */
export interface SessionStore {
  save(data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

/**
 * Persists sessions as JSON files on disk.
 *
 * Layout: `{baseDir}/sessions/{id}.json`
 * File permissions: 0o600 (session history may contain sensitive data).
 */
export class FileSessionStore implements SessionStore {
  readonly #sessionsDir: string;

  constructor(baseDir: string) {
    this.#sessionsDir = join(baseDir, "sessions");
  }

  async save(data: SessionData): Promise<void> {
    this.#validateId(data.metadata.id);
    await mkdir(this.#sessionsDir, { recursive: true });
    const filePath = join(this.#sessionsDir, `${data.metadata.id}.json`);
    const json = JSON.stringify(data, null, 2);
    await writeFile(filePath, json, { encoding: "utf8", mode: SESSION_FILE_MODE });
  }

  async load(id: string): Promise<SessionData | null> {
    this.#validateId(id);
    const filePath = join(this.#sessionsDir, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as SessionData;
    // Reconstruct Date objects from ISO strings
    parsed.metadata.createdAt = new Date(parsed.metadata.createdAt);
    parsed.metadata.updatedAt = new Date(parsed.metadata.updatedAt);
    return parsed;
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -5));
  }

  async delete(id: string): Promise<void> {
    this.#validateId(id);
    const filePath = join(this.#sessionsDir, `${id}.json`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  #validateId(id: string): void {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(`Invalid session id: "${id}"`);
    }
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/sessions/store.test.ts`
Expected: All 10 tests PASS.

### Step 5: Commit

```bash
git add packages/core/src/sessions/store.ts packages/core/src/sessions/store.test.ts
git commit -m "feat(core): add FileSessionStore for persisting sessions to disk"
```

---

## Task 2: Add `fromData()` static factory to `Session`

**Files:**
- Modify: `packages/core/src/sessions/session.ts:4-17`
- Modify: `packages/core/src/sessions/session.test.ts`

### Step 1: Write the failing test

Append to `packages/core/src/sessions/session.test.ts`, inside the `describe("Session", ...)` block:

```typescript
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
```

Add `import type { SessionData } from "./types.js";` to the test file imports (line 3).

### Step 2: Run test to verify it fails

Run: `pnpm vitest run packages/core/src/sessions/session.test.ts`
Expected: FAIL — `Session.fromData is not a function`.

### Step 3: Write the implementation

In `packages/core/src/sessions/session.ts`, add a static factory method to the `Session` class, after the constructor (after line 17):

```typescript
  /**
   * Reconstruct a session from persisted data.
   */
  static fromData(data: SessionData): Session {
    const session = new Session(data.metadata.id, data.metadata.peer);
    // Overwrite the auto-generated timestamps with the persisted ones
    (session as unknown as { "#createdAt": Date })["#createdAt"] = data.metadata.createdAt;
    (session as unknown as { "#updatedAt": Date })["#updatedAt"] = data.metadata.updatedAt;
    for (const msg of data.history) {
      session.#history.push({ ...msg });
    }
    return session;
  }
```

**Important:** Private fields (`#createdAt`) cannot be accessed via bracket notation casts. Instead, restructure the constructor to support restoration. Replace the constructor and add `fromData`:

In `packages/core/src/sessions/session.ts`, replace lines 11-17 with:

```typescript
  constructor(id: string, peer: PeerIdentity) {
    this.#id = id;
    this.#peer = { ...peer };
    const now = new Date();
    this.#createdAt = now;
    this.#updatedAt = now;
  }

  /**
   * Reconstruct a session from persisted data.
   */
  static fromData(data: SessionData): Session {
    const session = new Session(data.metadata.id, data.metadata.peer);
    session.#createdAt = new Date(data.metadata.createdAt);
    session.#updatedAt = new Date(data.metadata.updatedAt);
    for (const msg of data.history) {
      session.#history.push({ ...msg });
    }
    return session;
  }
```

Note: `#createdAt` is `readonly` — the `readonly` modifier must be removed since `fromData` writes to it. Change line 7 from:

```typescript
  readonly #createdAt: Date;
```

to:

```typescript
  #createdAt: Date;
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/sessions/session.test.ts`
Expected: All tests PASS (existing + 2 new).

### Step 5: Commit

```bash
git add packages/core/src/sessions/session.ts packages/core/src/sessions/session.test.ts
git commit -m "feat(core): add Session.fromData() for restoring persisted sessions"
```

---

## Task 3: Add `save()` and `loadAll()` to `SessionManager`

**Files:**
- Modify: `packages/core/src/sessions/manager.ts:1-59`
- Modify: `packages/core/src/sessions/manager.test.ts`

### Step 1: Write the failing tests

Add to `packages/core/src/sessions/manager.test.ts`. First add imports and a mock store helper:

```typescript
import { vi } from "vitest";
import type { SessionStore } from "./store.js";
import type { SessionData } from "./types.js";

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
```

Then add a new `describe` block:

```typescript
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
```

### Step 2: Run tests to verify they fail

Run: `pnpm vitest run packages/core/src/sessions/manager.test.ts`
Expected: FAIL — `SessionManager` constructor doesn't accept a store argument, `save` and `loadAll` don't exist.

### Step 3: Write the implementation

Replace `packages/core/src/sessions/manager.ts` entirely:

```typescript
import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import type { SessionStore } from "./store.js";
import type { PeerIdentity, SessionMetadata } from "./types.js";

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #peerIndex = new Map<string, string>();
  readonly #store: SessionStore | undefined;

  constructor(store?: SessionStore) {
    this.#store = store;
  }

  #peerKey(peer: PeerIdentity): string {
    return `${peer.channelId}:${peer.peerId}`;
  }

  create(peer: PeerIdentity): Session {
    const id = randomUUID();
    const session = new Session(id, peer);
    this.#sessions.set(id, session);
    this.#peerIndex.set(this.#peerKey(peer), id);
    return session;
  }

  getOrCreate(peer: PeerIdentity): Session {
    const existing = this.getByPeer(peer);
    if (existing) {
      return existing;
    }
    return this.create(peer);
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  getByPeer(peer: PeerIdentity): Session | undefined {
    const sessionId = this.#peerIndex.get(this.#peerKey(peer));
    if (sessionId === undefined) {
      return undefined;
    }
    return this.#sessions.get(sessionId);
  }

  destroy(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return false;
    }
    const peer = session.peer;
    this.#peerIndex.delete(this.#peerKey(peer));
    this.#sessions.delete(sessionId);
    // Fire-and-forget store deletion — do not block the caller
    this.#store?.delete(sessionId).catch(() => {});
    return true;
  }

  /**
   * Persist a session to the store.
   *
   * This is intended to be called by the caller after `agent.processMessage()`
   * returns, keeping `addMessage()` itself synchronous.
   */
  async save(sessionId: string): Promise<void> {
    if (!this.#store) {
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.#store.save(session.toJSON());
  }

  /**
   * Load all persisted sessions from the store into memory.
   * Returns the number of sessions loaded.
   */
  async loadAll(): Promise<number> {
    if (!this.#store) {
      return 0;
    }
    const ids = await this.#store.list();
    let loaded = 0;
    for (const id of ids) {
      const data = await this.#store.load(id);
      if (!data) {
        continue;
      }
      const session = Session.fromData(data);
      this.#sessions.set(session.id, session);
      this.#peerIndex.set(this.#peerKey(session.peer), session.id);
      loaded++;
    }
    return loaded;
  }

  listSessions(): SessionMetadata[] {
    return [...this.#sessions.values()].map((s) => s.metadata);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm vitest run packages/core/src/sessions/manager.test.ts`
Expected: All tests PASS (existing + 7 new).

### Step 5: Commit

```bash
git add packages/core/src/sessions/manager.ts packages/core/src/sessions/manager.test.ts
git commit -m "feat(core): add save() and loadAll() to SessionManager for session persistence"
```

---

## Task 4: Export `SessionStore` and `FileSessionStore` from barrel

**Files:**
- Modify: `packages/core/src/sessions/index.ts`

### Step 1: Update the barrel export

In `packages/core/src/sessions/index.ts`, add the new exports:

```typescript
export { Session } from "./session.js";
export { SessionManager } from "./manager.js";
export { FileSessionStore } from "./store.js";
export type { SessionStore } from "./store.js";
export type { PeerIdentity, SessionMetadata, SessionData } from "./types.js";
```

### Step 2: Verify build compiles

Run: `pnpm build`
Expected: Clean build, no errors.

### Step 3: Commit

```bash
git add packages/core/src/sessions/index.ts
git commit -m "feat(core): export SessionStore and FileSessionStore from sessions barrel"
```

---

## Task 5: Wire `FileSessionStore` into bootstrap

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:1-188`
- Modify: `packages/cli/src/commands/bootstrap.ts` (test file, if one exists — otherwise skip test)

### Step 1: Update bootstrap to create and inject `FileSessionStore`

In `packages/cli/src/commands/bootstrap.ts`, add the import (at line 9, alongside existing `@safeclaw/core` imports):

```typescript
import {
  Agent,
  DEFAULT_AGENT_CONFIG,
  CopilotClient,
  getCopilotToken as defaultGetCopilotToken,
  SessionManager,
  FileSessionStore,
  CapabilityRegistry,
  CapabilityEnforcer,
  SimpleToolRegistry,
  ToolOrchestrator,
  createBuiltinTools,
  AuditLog,
  SkillLoader,
} from "@safeclaw/core";
```

Add `path` and `os` imports at top:

```typescript
import { join } from "node:path";
import { homedir } from "node:os";
```

In the `bootstrapAgent` function, before `const sessionManager = new SessionManager();` (line 184), create the store:

```typescript
  const safeclawDir = join(homedir(), ".safeclaw");
  const store = new FileSessionStore(safeclawDir);
  const sessionManager = new SessionManager(store);
  await sessionManager.loadAll();
```

Replace line 184 (`const sessionManager = new SessionManager();`) with the above.

Note: The `safeclawDir` already exists (verified by vault check earlier in bootstrap). The sessions subdirectory is created lazily by `FileSessionStore.save()`.

### Step 2: Verify build compiles

Run: `pnpm build`
Expected: Clean build, no errors.

### Step 3: Commit

```bash
git add packages/cli/src/commands/bootstrap.ts
git commit -m "feat(cli): wire FileSessionStore into bootstrap for session persistence"
```

---

## Task 6: Save sessions after `processMessage` in CLI chat

**Files:**
- Modify: `packages/cli/src/commands/chat.ts:1-16`

### Step 1: Update `setupChat` to accept `SessionManager` and save after each message

Replace `packages/cli/src/commands/chat.ts` with:

```typescript
import type { Agent, Session, SessionManager } from "@safeclaw/core";
import type { CliAdapter } from "../adapter.js";

/**
 * Wire the CLI adapter to the agent for interactive chat.
 * Persists the session after each completed exchange.
 */
export function setupChat(
  adapter: CliAdapter,
  agent: Agent,
  session: Session,
  sessionManager: SessionManager,
): void {
  adapter.onMessage(async (msg) => {
    const response = await agent.processMessage(session, msg.content);
    await sessionManager.save(session.id);
    return { content: response.message };
  });
}
```

### Step 2: Update `runChat` in `cli.ts` to pass `sessionManager` and use `getOrCreate`

In `packages/cli/src/cli.ts`, update the `runChat` function (lines 48-72).

Change lines 58-64 from:

```typescript
  const adapter = new CliAdapter(process.stdin, process.stdout);
  const session = sessionManager.create({
    channelId: "cli",
    peerId: "local",
  });

  setupChat(adapter, agent, session);
```

to:

```typescript
  const adapter = new CliAdapter(process.stdin, process.stdout);
  const session = sessionManager.getOrCreate({
    channelId: "cli",
    peerId: "local",
  });

  setupChat(adapter, agent, session, sessionManager);
```

This uses `getOrCreate` instead of `create`, so if a previous CLI session was persisted and loaded during bootstrap, it will be resumed.

### Step 3: Update `runServe` to save sessions after messages

In `packages/cli/src/cli.ts`, update the gateway message handler (lines 126-135).

Change:

```typescript
  gateway.onMessage(async (msg) => {
    if (msg.type === "ping") {
      return { type: "pong" as const, payload: null };
    }

    const peer = { channelId: "gateway", peerId: "api-client" };
    const session = sessionManager.getOrCreate(peer);
    const response = await agent.processMessage(session, String(msg.payload));
    return { type: "response" as const, payload: response.message };
  });
```

to:

```typescript
  gateway.onMessage(async (msg) => {
    if (msg.type === "ping") {
      return { type: "pong" as const, payload: null };
    }

    const peer = { channelId: "gateway", peerId: "api-client" };
    const session = sessionManager.getOrCreate(peer);
    const response = await agent.processMessage(session, String(msg.payload));
    await sessionManager.save(session.id);
    return { type: "response" as const, payload: response.message };
  });
```

Update the webchat handler similarly (lines 138-142):

Change:

```typescript
  webchat.onMessage(async (msg) => {
    const session = sessionManager.getOrCreate(msg.peer);
    const response = await agent.processMessage(session, msg.content);
    return { content: response.message };
  });
```

to:

```typescript
  webchat.onMessage(async (msg) => {
    const session = sessionManager.getOrCreate(msg.peer);
    const response = await agent.processMessage(session, msg.content);
    await sessionManager.save(session.id);
    return { content: response.message };
  });
```

### Step 4: Verify build compiles

Run: `pnpm build`
Expected: Clean build, no errors.

### Step 5: Run full test suite

Run: `pnpm test`
Expected: All tests pass. The existing `chat.test.ts` (if any) may need `sessionManager` added to `setupChat` calls.

### Step 6: Commit

```bash
git add packages/cli/src/commands/chat.ts packages/cli/src/cli.ts
git commit -m "feat(cli): save sessions to disk after each agent response"
```

---

## Task 7: End-to-end integration test

**Files:**
- Create: `packages/core/src/sessions/persistence.integration.test.ts`

### Step 1: Write the integration test

Create `packages/core/src/sessions/persistence.integration.test.ts`:

```typescript
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
```

### Step 2: Run the integration test

Run: `pnpm vitest run packages/core/src/sessions/persistence.integration.test.ts`
Expected: All 3 tests PASS.

### Step 3: Run full test suite

Run: `pnpm test`
Expected: All tests pass.

### Step 4: Commit

```bash
git add packages/core/src/sessions/persistence.integration.test.ts
git commit -m "test(core): add integration tests for session persistence across restarts"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `SessionStore` interface + `FileSessionStore` | `store.ts`, `store.test.ts` |
| 2 | `Session.fromData()` factory | `session.ts`, `session.test.ts` |
| 3 | `SessionManager.save()` + `loadAll()` | `manager.ts`, `manager.test.ts` |
| 4 | Barrel exports | `index.ts` |
| 5 | Wire store into bootstrap | `bootstrap.ts` |
| 6 | Save after `processMessage` in CLI/gateway/webchat | `chat.ts`, `cli.ts` |
| 7 | Integration test | `persistence.integration.test.ts` |
