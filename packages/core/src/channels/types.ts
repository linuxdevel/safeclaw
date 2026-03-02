import type { PeerIdentity } from "../sessions/types.js";

export type { PeerIdentity } from "../sessions/types.js";

export interface InboundMessage {
  peer: PeerIdentity;
  content: string;
  timestamp: Date;
}

export interface OutboundMessage {
  content: string;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Channel adapter interface — pluggable messaging surface.
 * All channels (CLI, WebChat, Telegram, etc.) implement this.
 */
export interface ChannelAdapter {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<OutboundMessage>): void;
  send(peer: PeerIdentity, content: OutboundMessage): Promise<void>;
}
