# Tool Parameter Schemas Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add JSON Schema `parameters` to all 5 builtin tools so the LLM receives proper parameter definitions instead of empty `{}`.

**Architecture:** Each `ToolHandler` gets a new `parameters` field containing a JSON Schema object that describes its accepted arguments. The `Agent.getToolDefinitions()` method passes `handler.parameters` through to the Copilot API instead of hardcoding `{}`. This is a data-only change -- no runtime behavior changes, just richer metadata sent to the LLM.

**Tech Stack:** TypeScript, JSON Schema, Vitest

---

### Task 1: Add `parameters` field to `ToolHandler` interface

**Files:**
- Modify: `packages/core/src/tools/types.ts:25-30`

**Step 1: Write the change**

In `packages/core/src/tools/types.ts`, add a `parameters` field to the `ToolHandler` interface:

```typescript
export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiredCapabilities: Capability[];
  execute(args: Record<string, unknown>): Promise<string>;
}
```

**Step 2: Verify it compiles (expect failures)**

Run: `npx tsc --build --dry 2>&1 | head -30`

Expected: TypeScript errors in all 5 builtin tool files and `agent.test.ts` because they don't yet provide the `parameters` field. This confirms the interface change is correct and the compiler catches all the places that need updating.

---

### Task 2: Add JSON Schema to `readTool`

**Files:**
- Modify: `packages/core/src/tools/builtin/read.ts:4-8`
- Test: `packages/core/src/tools/builtin/read.test.ts`

**Step 1: Write the failing test**

Add a new test to `packages/core/src/tools/builtin/read.test.ts`, after the existing `"has correct name and metadata"` test (line 19):

```typescript
  it("exposes a valid JSON Schema for parameters", () => {
    expect(readTool.parameters).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read",
        },
        offset: {
          type: "integer",
          description: "Line number to start from (1-indexed)",
          minimum: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read",
          minimum: 1,
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/read.test.ts`

Expected: FAIL -- `readTool.parameters` is `undefined`.

**Step 3: Write minimal implementation**

In `packages/core/src/tools/builtin/read.ts`, add the `parameters` field to the `readTool` object, between `requiredCapabilities` (line 7) and `execute` (line 9):

```typescript
export const readTool: ToolHandler = {
  name: "read",
  description: "Read a file's contents with optional offset and line limit",
  requiredCapabilities: ["fs:read"],

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      offset: {
        type: "integer",
        description: "Line number to start from (1-indexed)",
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of lines to read",
        minimum: 1,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/read.test.ts`

Expected: PASS -- all tests green.

---

### Task 3: Add JSON Schema to `writeTool`

**Files:**
- Modify: `packages/core/src/tools/builtin/write.ts:5-8`
- Test: `packages/core/src/tools/builtin/write.test.ts`

**Step 1: Write the failing test**

Add a new test to `packages/core/src/tools/builtin/write.test.ts`, after the existing `"has correct name and metadata"` test (line 20):

```typescript
  it("exposes a valid JSON Schema for parameters", () => {
    expect(writeTool.parameters).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to write",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/write.test.ts`

Expected: FAIL -- `writeTool.parameters` is `undefined`.

**Step 3: Write minimal implementation**

In `packages/core/src/tools/builtin/write.ts`, add the `parameters` field to the `writeTool` object, between `requiredCapabilities` (line 8) and `execute` (line 10):

```typescript
export const writeTool: ToolHandler = {
  name: "write",
  description: "Write content to a file, creating parent directories if needed",
  requiredCapabilities: ["fs:write"],

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/write.test.ts`

Expected: PASS -- all tests green.

---

### Task 4: Add JSON Schema to `editTool`

**Files:**
- Modify: `packages/core/src/tools/builtin/edit.ts:4-9`
- Test: `packages/core/src/tools/builtin/edit.test.ts`

**Step 1: Write the failing test**

Add a new test to `packages/core/src/tools/builtin/edit.test.ts`, after the existing `"has correct name and metadata"` test (line 20):

```typescript
  it("exposes a valid JSON Schema for parameters", () => {
    expect(editTool.parameters).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to edit",
        },
        oldString: {
          type: "string",
          description: "The exact string to find and replace",
        },
        newString: {
          type: "string",
          description: "The replacement string",
        },
        replaceAll: {
          type: "boolean",
          description:
            "Replace all occurrences instead of requiring uniqueness",
          default: false,
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/edit.test.ts`

Expected: FAIL -- `editTool.parameters` is `undefined`.

**Step 3: Write minimal implementation**

In `packages/core/src/tools/builtin/edit.ts`, add the `parameters` field to the `editTool` object, between `requiredCapabilities` (line 8) and `execute` (line 10):

```typescript
export const editTool: ToolHandler = {
  name: "edit",
  description:
    "Apply a string replacement to a file. Validates the old string exists and is unique unless replaceAll is set.",
  requiredCapabilities: ["fs:read", "fs:write"],

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      oldString: {
        type: "string",
        description: "The exact string to find and replace",
      },
      newString: {
        type: "string",
        description: "The replacement string",
      },
      replaceAll: {
        type: "boolean",
        description:
          "Replace all occurrences instead of requiring uniqueness",
        default: false,
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/edit.test.ts`

Expected: PASS -- all tests green.

---

### Task 5: Add JSON Schema to `bashTool`

**Files:**
- Modify: `packages/core/src/tools/builtin/bash.ts:6-9`
- Test: `packages/core/src/tools/builtin/bash.test.ts`

**Step 1: Write the failing test**

Add a new test to `packages/core/src/tools/builtin/bash.test.ts`, after the existing `"has correct name and metadata"` test (line 19):

```typescript
  it("exposes a valid JSON Schema for parameters", () => {
    expect(bashTool.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute via /bin/bash",
        },
        timeout: {
          type: "integer",
          description: "Timeout in milliseconds",
          default: 120000,
          minimum: 1,
        },
        workdir: {
          type: "string",
          description: "Working directory for command execution",
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/bash.test.ts`

Expected: FAIL -- `bashTool.parameters` is `undefined`.

**Step 3: Write minimal implementation**

In `packages/core/src/tools/builtin/bash.ts`, add the `parameters` field to the `bashTool` object, between `requiredCapabilities` (line 9) and `execute` (line 11):

```typescript
export const bashTool: ToolHandler = {
  name: "bash",
  description: "Execute a shell command via /bin/bash",
  requiredCapabilities: ["process:spawn"],

  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute via /bin/bash",
      },
      timeout: {
        type: "integer",
        description: "Timeout in milliseconds",
        default: 120000,
        minimum: 1,
      },
      workdir: {
        type: "string",
        description: "Working directory for command execution",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/bash.test.ts`

Expected: PASS -- all tests green.

---

### Task 6: Add JSON Schema to `webFetchTool`

**Files:**
- Modify: `packages/core/src/tools/builtin/web-fetch.ts:5-8`
- Test: `packages/core/src/tools/builtin/web-fetch.test.ts`

**Step 1: Write the failing test**

Add a new test to `packages/core/src/tools/builtin/web-fetch.test.ts`, after the existing `"has correct name and metadata"` test (line 17):

```typescript
  it("exposes a valid JSON Schema for parameters", () => {
    expect(webFetchTool.parameters).toEqual({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTPS URL to fetch",
        },
        format: {
          type: "string",
          description: "Response format",
          enum: ["text", "json"],
          default: "text",
        },
      },
      required: ["url"],
      additionalProperties: false,
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/tools/builtin/web-fetch.test.ts`

Expected: FAIL -- `webFetchTool.parameters` is `undefined`.

**Step 3: Write minimal implementation**

In `packages/core/src/tools/builtin/web-fetch.ts`, add the `parameters` field to the `webFetchTool` object, between `requiredCapabilities` (line 8) and `execute` (line 10):

```typescript
export const webFetchTool: ToolHandler = {
  name: "web_fetch",
  description: "Fetch a URL via HTTPS and return the response body",
  requiredCapabilities: ["net:https"],

  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTPS URL to fetch",
      },
      format: {
        type: "string",
        description: "Response format",
        enum: ["text", "json"],
        default: "text",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>): Promise<string> {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/tools/builtin/web-fetch.test.ts`

Expected: PASS -- all tests green.

---

### Task 7: Update `makeToolHandler` mock and agent test

**Files:**
- Modify: `packages/core/src/agent/agent.test.ts:49-57` (makeToolHandler)
- Modify: `packages/core/src/agent/agent.test.ts:433-441` (getToolDefinitions test)

**Step 1: Update the `makeToolHandler` helper**

In `packages/core/src/agent/agent.test.ts`, update the `makeToolHandler` function (lines 49-57) to include a `parameters` field:

```typescript
function makeToolHandler(overrides: Partial<ToolHandler> = {}): ToolHandler {
  return {
    name: "read_file",
    description: "Read a file from disk",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs:read"],
    execute: async (_args: Record<string, unknown>) => "file-content",
    ...overrides,
  };
}
```

**Step 2: Update the `getToolDefinitions` test assertion**

In `packages/core/src/agent/agent.test.ts`, update the `"converts tool handlers to API format"` test (lines 421-441). The `makeToolHandler` is called with `name: "write_file"` and `description: "Write to a file"` overrides, so `parameters` will come from the default mock. Update the assertion:

```typescript
    it("converts tool handlers to API format", () => {
      const { client, orchestrator, toolRegistry } = createMocks();
      const handler = makeToolHandler({
        name: "write_file",
        description: "Write to a file",
      });
      vi.mocked(toolRegistry.list).mockReturnValue([handler]);

      const agent = new Agent(makeConfig(), client, orchestrator);
      const defs = agent.getToolDefinitions();

      expect(defs).toHaveLength(1);
      expect(defs[0]).toEqual({
        type: "function",
        function: {
          name: "write_file",
          description: "Write to a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      });
    });
```

**Step 3: Run the test to verify it fails (because `getToolDefinitions` still hardcodes `{}`)**

Run: `npx vitest run packages/core/src/agent/agent.test.ts`

Expected: FAIL -- the test expects `handler.parameters` but `getToolDefinitions()` still returns `parameters: {}`.

---

### Task 8: Update `getToolDefinitions()` in Agent

**Files:**
- Modify: `packages/core/src/agent/agent.ts:146-153`

**Step 1: Write the implementation**

In `packages/core/src/agent/agent.ts`, update `getToolDefinitions()` (lines 146-153) to use `handler.parameters` instead of `{}`:

```typescript
    return registry.list().map((handler) => ({
      type: "function" as const,
      function: {
        name: handler.name,
        description: handler.description,
        parameters: handler.parameters,
      },
    }));
```

**Step 2: Run the agent tests to verify they pass**

Run: `npx vitest run packages/core/src/agent/agent.test.ts`

Expected: PASS -- all tests green.

---

### Task 9: Run full test suite and type-check

**Step 1: Type-check**

Run: `npx tsc --build --dry`

Expected: No type errors.

**Step 2: Run full test suite**

Run: `pnpm test`

Expected: All tests pass.

**Step 3: Run linter**

Run: `pnpm lint`

Expected: No lint errors.

---

### Task 10: Commit

**Step 1: Stage and commit**

```bash
git add packages/core/src/tools/types.ts \
       packages/core/src/tools/builtin/read.ts \
       packages/core/src/tools/builtin/read.test.ts \
       packages/core/src/tools/builtin/write.ts \
       packages/core/src/tools/builtin/write.test.ts \
       packages/core/src/tools/builtin/edit.ts \
       packages/core/src/tools/builtin/edit.test.ts \
       packages/core/src/tools/builtin/bash.ts \
       packages/core/src/tools/builtin/bash.test.ts \
       packages/core/src/tools/builtin/web-fetch.ts \
       packages/core/src/tools/builtin/web-fetch.test.ts \
       packages/core/src/agent/agent.ts \
       packages/core/src/agent/agent.test.ts
git commit -m "feat(tools): add JSON Schema parameters to builtin tools"
```
