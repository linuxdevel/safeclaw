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
