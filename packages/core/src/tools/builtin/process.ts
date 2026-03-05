import type { ToolHandler } from "../types.js";
import type { ProcessManager } from "../process-manager.js";

type Action = "start" | "status" | "log" | "kill" | "list";
const VALID_ACTIONS: Action[] = ["start", "status", "log", "kill", "list"];

export function createProcessTool(processManager: ProcessManager): ToolHandler {
  return {
    name: "process",
    description:
      "Manage background processes: start, check status, read output, kill, or list all",
    requiredCapabilities: ["process:spawn"],

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform",
          enum: ["start", "status", "log", "kill", "list"],
        },
        command: {
          type: "string",
          description: "Shell command to run (required for 'start' action)",
        },
        processId: {
          type: "string",
          description:
            "Process ID (required for 'status', 'log', 'kill' actions)",
        },
        cwd: {
          type: "string",
          description: "Working directory for 'start' action",
        },
        tail: {
          type: "number",
          description: "Number of tail lines to return for 'log' action",
        },
        signal: {
          type: "string",
          description: "Signal to send for 'kill' action (default: SIGTERM)",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args["action"];
      if (typeof action !== "string") {
        throw new Error("Required argument 'action' must be a string");
      }

      if (!VALID_ACTIONS.includes(action as Action)) {
        throw new Error(
          `Unknown action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`,
        );
      }

      switch (action as Action) {
        case "start":
          return handleStart(processManager, args);
        case "status":
          return handleStatus(processManager, args);
        case "log":
          return handleLog(processManager, args);
        case "kill":
          return handleKill(processManager, args);
        case "list":
          return handleList(processManager);
      }
    },
  };
}

function requireProcessId(args: Record<string, unknown>): string {
  const processId = args["processId"];
  if (typeof processId !== "string" || !processId) {
    throw new Error("Required argument 'processId' must be a non-empty string");
  }
  return processId;
}

function handleStart(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const command = args["command"];
  if (typeof command !== "string" || !command) {
    throw new Error("Required argument 'command' must be a non-empty string");
  }
  const cwd = args["cwd"] !== undefined ? String(args["cwd"]) : undefined;
  const id = pm.start(command, cwd !== undefined ? { cwd } : undefined);
  const status = pm.status(id);
  return JSON.stringify(status);
}

function handleStatus(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  return JSON.stringify(pm.status(id));
}

function handleLog(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  const tail =
    args["tail"] !== undefined ? Number(args["tail"]) : undefined;
  return pm.log(id, tail !== undefined ? { tail } : undefined);
}

function handleKill(
  pm: ProcessManager,
  args: Record<string, unknown>,
): string {
  const id = requireProcessId(args);
  const signal =
    args["signal"] !== undefined ? String(args["signal"]) : undefined;
  const killed = pm.kill(id, signal);
  return JSON.stringify({ id, killed });
}

function handleList(pm: ProcessManager): string {
  return JSON.stringify(pm.list());
}
