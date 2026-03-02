import type { ChatMessage } from "../copilot/types.js";
import type { PeerIdentity, SessionMetadata, SessionData } from "./types.js";

export class Session {
  readonly #id: string;
  readonly #peer: PeerIdentity;
  readonly #createdAt: Date;
  #updatedAt: Date;
  #history: ChatMessage[] = [];

  constructor(id: string, peer: PeerIdentity) {
    this.#id = id;
    this.#peer = { ...peer };
    const now = new Date();
    this.#createdAt = now;
    this.#updatedAt = now;
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
