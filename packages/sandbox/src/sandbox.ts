import type { SandboxPolicy, SandboxResult } from "./types.js";
import { assertSandboxSupported } from "./detect.js";

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    this.policy = policy;
  }

  async execute(_command: string, _args: string[]): Promise<SandboxResult> {
    // Will use child_process.spawn with namespace/landlock/seccomp applied
    // Stub for now — returns a "not implemented" result
    throw new Error(
      "Sandbox.execute() not yet implemented — native bindings required",
    );
  }

  getPolicy(): SandboxPolicy {
    return { ...this.policy };
  }
}
