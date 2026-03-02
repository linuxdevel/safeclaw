import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import type { PeerIdentity, SessionMetadata } from "./types.js";

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #peerIndex = new Map<string, string>();

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
    return true;
  }

  listSessions(): SessionMetadata[] {
    return [...this.#sessions.values()].map((s) => s.metadata);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }
}
