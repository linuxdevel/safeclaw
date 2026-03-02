import type { Sandbox } from "@safeclaw/sandbox";
import type { CapabilityEnforcer } from "../capabilities/enforcer.js";
import { CapabilityDeniedError } from "../capabilities/enforcer.js";
import type { AuditLog } from "./audit-log.js";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandler,
  ToolRegistry,
} from "./types.js";

export interface OrchestratorOptions {
  sandbox?: Pick<Sandbox, "execute">;
  sandboxedTools?: string[];
  auditLog?: AuditLog;
}

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
    private readonly options?: OrchestratorOptions,
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

    // 3. Route to sandbox or direct execution
    let result: ToolExecutionResult;

    if (
      this.options?.sandbox !== null &&
      this.options?.sandbox !== undefined &&
      this.options.sandboxedTools !== null &&
      this.options.sandboxedTools !== undefined &&
      this.options.sandboxedTools.includes(request.toolName)
    ) {
      result = await this.executeSandboxed(
        this.options.sandbox,
        request,
        start,
      );
    } else {
      result = await this.executeDirect(handler, request, start);
    }

    this.options?.auditLog?.record(request, result);

    return result;
  }

  private async executeSandboxed(
    sandbox: Pick<Sandbox, "execute">,
    request: ToolExecutionRequest,
    start: number,
  ): Promise<ToolExecutionResult> {
    try {
      const mapped = buildSandboxCommand(request.toolName, request.args);
      const sandboxResult = await sandbox.execute(
        mapped.command,
        mapped.args,
      );
      return {
        success: sandboxResult.exitCode === 0,
        output: sandboxResult.stdout,
        error:
          sandboxResult.exitCode !== 0 ? sandboxResult.stderr : undefined,
        durationMs: performance.now() - start,
        sandboxed: true,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: "",
        error:
          err instanceof Error
            ? err.message
            : `Sandbox execution failed: ${String(err)}`,
        durationMs: performance.now() - start,
        sandboxed: true,
      };
    }
  }

  private async executeDirect(
    handler: ToolHandler,
    request: ToolExecutionRequest,
    start: number,
  ): Promise<ToolExecutionResult> {
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

function buildSandboxCommand(
  toolName: string,
  args: Record<string, unknown>,
): { command: string; args: string[] } {
  switch (toolName) {
    case "bash":
      return {
        command: "/bin/bash",
        args: ["-c", String(args["command"] ?? "")],
      };
    default:
      throw new Error(`No sandbox command mapping for tool: "${toolName}"`);
  }
}
