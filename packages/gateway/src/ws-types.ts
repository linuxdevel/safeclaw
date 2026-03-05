// --- Client -> Server messages ---

export interface WsAuthMessage {
  type: "auth";
  token: string;
}

export interface WsChatMessage {
  type: "chat";
  content: string;
}

export interface WsPingMessage {
  type: "ping";
}

export type WsClientMessage = WsAuthMessage | WsChatMessage | WsPingMessage;

// --- Server -> Client messages ---

export interface WsAuthOkMessage {
  type: "auth_ok";
}

export interface WsAuthErrorMessage {
  type: "auth_error";
  reason: string;
}

export interface WsTextDeltaMessage {
  type: "text_delta";
  content: string;
}

export interface WsToolStartMessage {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
}

export interface WsToolResultMessage {
  type: "tool_result";
  toolCallId: string;
  result: string;
  success: boolean;
}

export interface WsDoneMessage {
  type: "done";
  response: {
    message: string;
    toolCallsMade: number;
    model: string;
  };
}

export interface WsErrorMessage {
  type: "error";
  message: string;
}

export interface WsPongMessage {
  type: "pong";
}

export type WsServerMessage =
  | WsAuthOkMessage
  | WsAuthErrorMessage
  | WsTextDeltaMessage
  | WsToolStartMessage
  | WsToolResultMessage
  | WsDoneMessage
  | WsErrorMessage
  | WsPongMessage;
