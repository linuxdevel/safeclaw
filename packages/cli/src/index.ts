// @safeclaw/cli
export { CliAdapter } from "./adapter.js";
export { setupChat } from "./commands/chat.js";
export { runOnboarding } from "./commands/onboard.js";
export type { OnboardOptions, OnboardResult } from "./commands/onboard.js";
export { AuditLog, runAudit } from "./commands/audit.js";
export type { AuditEntry, AuditOptions, AuditReport } from "./commands/audit.js";
