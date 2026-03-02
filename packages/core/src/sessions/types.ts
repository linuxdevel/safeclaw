import type { ChatMessage } from "../copilot/types.js";

export interface PeerIdentity {
  channelId: string;
  peerId: string;
}

export interface SessionMetadata {
  id: string;
  peer: PeerIdentity;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface SessionData {
  metadata: SessionMetadata;
  history: ChatMessage[];
}
