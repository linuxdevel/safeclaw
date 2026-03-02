import type { CapabilityWithConstraints, SkillManifest } from "../capabilities/types.js";

/** Raw manifest file as read from disk (before signature verification) */
export interface RawManifestFile {
  id: string;
  version: string;
  name: string;
  description: string;
  signature: string;
  publicKey: string;
  requiredCapabilities: CapabilityWithConstraints[];
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface LoadResult {
  success: boolean;
  manifest?: SkillManifest | undefined;
  error?: string | undefined;
}

export interface InstallOptions {
  /** Allow unsigned skills (requires explicit flag) */
  allowUnsigned?: boolean | undefined;
  /** Auto-approve capabilities (for built-in skills only) */
  autoApprove?: boolean | undefined;
}
