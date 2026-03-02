import type { CapabilityEnforcer } from "../capabilities/enforcer.js";
import { CapabilityDeniedError } from "../capabilities/enforcer.js";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandler,
  ToolRegistry,
} from "./types.js";

export class SimpleToolRegistry implements ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.name, handler);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  list(): ToolHandler[] {
    return [...this.handlers.values()];
  }
}

export class ToolOrchestrator {
  constructor(
    private readonly enforcer: CapabilityEnforcer,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const start = performance.now();

    // 1. Look up tool handler
    const handler = this.toolRegistry.get(request.toolName);
    if (!handler) {
      return {
        success: false,
        output: "",
        error: `Tool not found: "${request.toolName}"`,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    }

    // 2. Check each required capability
    for (const capability of handler.requiredCapabilities) {
      try {
        this.enforcer.check(request.skillId, capability);
      } catch (err: unknown) {
        return {
          success: false,
          output: "",
          error:
            err instanceof CapabilityDeniedError
              ? err.message
              : `Capability check failed: ${String(err)}`,
          durationMs: performance.now() - start,
          sandboxed: false,
        };
      }
    }

    // 3. Execute handler (v1: direct execution, no sandbox)
    try {
      const output = await handler.execute(request.args);
      return {
        success: true,
        output,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: "",
        error:
          err instanceof Error
            ? err.message
            : `Tool execution failed: ${String(err)}`,
        durationMs: performance.now() - start,
        sandboxed: false,
      };
    }
  }
}
