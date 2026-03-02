export type Capability =
  | "fs:read"
  | "fs:write"
  | "net:http"
  | "net:https"
  | "process:spawn"
  | "env:read"
  | "secret:read"
  | "secret:write";

export interface CapabilityConstraints {
  paths?: string[];
  hosts?: string[];
  executables?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SkillManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  signature: string;
  publicKey: string;
  requiredCapabilities: CapabilityWithConstraints[];
  tools: ToolDefinition[];
}

export interface CapabilityWithConstraints {
  capability: Capability;
  constraints?: CapabilityConstraints;
  reason: string;
}

export interface CapabilityGrant {
  skillId: string;
  capability: Capability;
  constraints?: CapabilityConstraints;
  grantedAt: Date;
  grantedBy: "user" | "builtin";
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
  publicKey?: string;
}
