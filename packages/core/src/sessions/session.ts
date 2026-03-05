import type { ChatMessage } from "../copilot/types.js";
import type { PeerIdentity, SessionMetadata, SessionData } from "./types.js";

export class Session {
  readonly #id: string;
  readonly #peer: PeerIdentity;
  #createdAt: Date;
  #updatedAt: Date;
  #history: ChatMessage[] = [];

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

  get id(): string {
    return this.#id;
  }

  get peer(): PeerIdentity {
    return { ...this.#peer };
  }

  get metadata(): SessionMetadata {
    return {
      id: this.#id,
      peer: { ...this.#peer },
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      messageCount: this.#history.length,
    };
  }

  addMessage(message: ChatMessage): void {
    this.#history.push({ ...message });
    this.#updatedAt = new Date();
  }

  getHistory(): ChatMessage[] {
    return this.#history.map((m) => ({ ...m }));
  }

  setHistory(messages: ChatMessage[]): void {
    this.#history = messages.map((m) => ({ ...m }));
    this.#updatedAt = new Date();
  }

  clearHistory(): void {
    this.#history = [];
    this.#updatedAt = new Date();
  }

  toJSON(): SessionData {
    return {
      metadata: this.metadata,
      history: this.getHistory(),
    };
  }
}
