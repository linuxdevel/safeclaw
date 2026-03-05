// @safeclaw/cli
export { CliAdapter } from "./adapter.js";
export { setupChat } from "./commands/chat.js";
export { runOnboarding } from "./commands/onboard.js";
export type { OnboardOptions, OnboardResult } from "./commands/onboard.js";
export { AuditLog } from "@safeclaw/core";
export type { AuditEntry } from "@safeclaw/core";
export { runAudit } from "./commands/audit.js";
export type { AuditOptions, AuditReport } from "./commands/audit.js";
export { ChatCommandHandler } from "./commands/chat-commands.js";
export type { ChatCommandDeps } from "./commands/chat-commands.js";
export type { SetupChatOptions } from "./commands/chat.js";
