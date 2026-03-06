# Feature 10: MCP (Model Context Protocol) Support

## Problem

SafeClaw has a solid built-in tool registry but no way to extend it with external tools at runtime. MCP is the emerging standard for tool/resource/prompt discovery, and supporting it lets users connect to hundreds of existing MCP servers (filesystem, database, Sentry, GitHub, etc.) without writing custom SafeClaw tool handlers.

## Design Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         SafeClaw Agent                          │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │  ToolOrchestrator │    │         McpManager               │   │
│  │                  │    │                                  │   │
│  │  ┌────────────┐  │    │  ┌────────────┐ ┌────────────┐  │   │
│  │  │ SimpleTool │  │    │  │ McpClient  │ │ McpClient  │  │   │
│  │  │ Registry   │  │    │  │ (stdio)    │ │ (http)     │  │   │
│  │  │            │  │    │  │ server-fs  │ │ sentry     │  │   │
│  │  │ read       │  │    │  └─────┬──────┘ └─────┬──────┘  │   │
│  │  │ write      │  │    │        │              │         │   │
│  │  │ edit       │  │    │        ▼              ▼         │   │
│  │  │ bash       │  │    │  ┌──────────────────────────┐   │   │
│  │  │ web_fetch  │  │    │  │    McpToolRegistry       │   │   │
│  │  │ ...        │  │    │  │ (implements ToolRegistry)│   │   │
│  │  └────────────┘  │    │  └──────────────────────────┘   │   │
│  │                  │    │                                  │   │
│  │  ┌────────────┐  │    └──────────────────────────────────┘   │
│  │  │ Composite  │◀─┼────── merges builtin + MCP registries     │
│  │  │ Registry   │  │                                           │
│  │  └────────────┘  │                                           │
│  └──────────────────┘                                           │
│                                                                 │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │ Capability     │  │   Sandbox      │  │    Vault         │   │
│  │ Enforcer       │  │ (for local     │  │ (OAuth tokens)   │   │
│  │                │  │  MCP servers)  │  │                  │   │
│  └────────────────┘  └────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │                    │                     │
         ▼                    ▼                     ▼
   ┌──────────┐       ┌──────────────┐      ┌──────────────┐
   │ MCP      │       │ safeclaw-    │      │ Remote MCP   │
   │ Server   │       │ sandbox-     │      │ Server       │
   │ (stdio)  │       │ helper       │      │ (HTTP/SSE)   │
   └──────────┘       └──────────────┘      └──────────────┘
```

## Config Schema

MCP servers are configured under the `mcp` key in `safeclaw.json`. Configuration is layered: global (`~/.safeclaw/safeclaw.json`) merged with project-local (`<cwd>/.safeclaw/safeclaw.json`), project overrides global.

```json
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "environment": { "NODE_ENV": "production" },
      "cwd": "/home/user/project",
      "sandbox": { "enabled": true, "profile": "restrictive" },
      "timeout": 10000,
      "allowTools": ["read_file", "list_directory"],
      "requireConfirmation": false
    },
    "sentry": {
      "type": "remote",
      "enabled": true,
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "X-Custom": "value" },
      "oauth": { "scope": "project:read issue:read" },
      "timeout": 30000,
      "denyTools": ["dangerous_action"],
      "requireConfirmation": true
    }
  }
}
```

### Config Type Definitions

```typescript
interface McpConfig {
  [serverName: string]: McpServerConfig;
}

type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

interface McpLocalServerConfig {
  type: "local";
  enabled?: boolean;           // default true
  command: string[];           // e.g. ["npx", "-y", "server-name"]
  environment?: Record<string, string>;
  cwd?: string;
  sandbox?: McpSandboxConfig;  // default { enabled: true }
  timeout?: number;            // ms, default 10000
  allowTools?: string[];       // whitelist (if set, only these tools exposed)
  denyTools?: string[];        // blacklist (if set, these tools hidden)
  requireConfirmation?: boolean; // default true
}

interface McpRemoteServerConfig {
  type: "remote";
  enabled?: boolean;           // default true
  url: string;
  headers?: Record<string, string>; // supports {env:VAR} interpolation
  oauth?: boolean | McpOAuthConfig; // default false
  timeout?: number;            // ms, default 30000
  allowTools?: string[];
  denyTools?: string[];
  requireConfirmation?: boolean; // default true
}

interface McpSandboxConfig {
  enabled: boolean;            // default true
  profile?: string;            // reserved for custom sandbox profiles
}

interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}
```

## Package Layout

```
safeclaw/
├── packages/
│   ├── mcp/                    # NEW: @safeclaw/mcp
│   │   ├── src/
│   │   │   ├── index.ts        # Public exports
│   │   │   ├── manager.ts      # McpManager -- lifecycle orchestrator
│   │   │   ├── client-wrapper.ts  # McpClientWrapper -- per-server client
│   │   │   ├── registry.ts     # McpToolRegistry -- implements ToolRegistry
│   │   │   ├── converter.ts    # MCP tool -> SafeClaw ToolHandler conversion
│   │   │   ├── auth.ts         # OAuth + header auth provider
│   │   │   ├── config.ts       # MCP config types and validation
│   │   │   ├── transport.ts    # Transport factory (stdio vs HTTP)
│   │   │   └── types.ts        # Shared types
│   │   ├── package.json
│   │   └── tsconfig.json       # References @safeclaw/core, @safeclaw/sandbox
│   ├── core/                   # MODIFIED: add CompositeToolRegistry, extend config
│   │   └── src/
│   │       ├── tools/
│   │       │   ├── composite-registry.ts  # NEW: merges multiple ToolRegistry
│   │       │   └── types.ts    # Unchanged (ToolHandler, ToolRegistry interfaces)
│   │       ├── config/
│   │       │   ├── types.ts    # Add mcp? field to SafeClawConfig
│   │       │   ├── validate.ts # Add "mcp" to ALLOWED_TOP_KEYS
│   │       │   └── loader.ts   # Merge global + project config
│   │       └── capabilities/
│   │           └── types.ts    # Add "mcp:invoke" capability
│   ├── cli/                    # MODIFIED: add mcp subcommands, bootstrap wiring
│   │   └── src/
│   │       ├── cli.ts          # Add 'mcp' command group
│   │       └── commands/
│   │           ├── bootstrap.ts # Wire McpManager into startup
│   │           ├── mcp.ts      # NEW: mcp list/enable/disable/auth/refresh
│   │           └── chat-commands.ts  # Add /prompts slash command
│   └── sandbox/                # Unchanged (PolicyBuilder already supports local servers)
```

### Dependency Graph Extension

```
vault (standalone)     sandbox (standalone)
      \                    |
       \                   v
        +-----> core <-----+
               / | \        \
              /  |  \        \
             v   v   v        v
        gateway webchat    mcp (NEW)
                            |
                            v
                           cli (depends on all)
```

## MCP Client Architecture

### McpManager

Central orchestrator -- owns one `McpClientWrapper` per configured server.

```typescript
class McpManager {
  private clients: Map<string, McpClientWrapper>;

  constructor(config: McpConfig, deps: McpManagerDeps);

  // Lifecycle
  async connectAll(): Promise<void>;       // Connect all enabled servers
  async connect(name: string): Promise<void>;
  async disconnect(name: string): Promise<void>;
  async disconnectAll(): Promise<void>;    // Graceful shutdown
  async refresh(name?: string): Promise<void>; // Re-discover tools

  // Status
  getStatus(): Map<string, McpServerStatus>;
  getStatus(name: string): McpServerStatus;

  // Registry
  getToolRegistry(): McpToolRegistry;      // Composite of all server tools

  // Prompts
  listPrompts(): McpPromptInfo[];
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<ChatMessage[]>;
}

interface McpManagerDeps {
  vault: Vault;                // For OAuth token storage
  sandbox?: Sandbox;           // For sandboxing local servers
  eventBus?: EventEmitter;     // For list_changed notifications
}

interface McpServerStatus {
  state: "disabled" | "connecting" | "ready" | "error";
  lastError?: string;
  lastConnectedAt?: Date;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}
```

### McpClientWrapper

Wraps a single `@modelcontextprotocol/sdk` `Client` with lifecycle management.

```typescript
class McpClientWrapper {
  readonly serverName: string;
  readonly config: McpServerConfig;

  constructor(serverName: string, config: McpServerConfig, deps: McpClientDeps);

  // Lifecycle
  async connect(): Promise<void>;          // Create transport, connect, discover
  async disconnect(): Promise<void>;       // Clean shutdown
  async reconnect(): Promise<void>;        // Exponential backoff reconnection

  // Discovery (cached, refreshed on list_changed)
  getTools(): McpToolInfo[];               // Cached tool list
  getResources(): McpResourceInfo[];       // Cached resource list
  getPrompts(): McpPromptInfo[];           // Cached prompt list

  // Execution
  async callTool(name: string, args: Record<string, unknown>): Promise<string>;

  // Status
  get status(): McpServerStatus;
}
```

### Transport Creation

```typescript
function createTransport(config: McpServerConfig, deps: TransportDeps): Transport {
  if (config.type === "local") {
    // If sandbox enabled (default), wrap command with sandbox execution
    if (config.sandbox?.enabled !== false) {
      return new StdioClientTransport({
        command: deps.sandboxCommand,  // safeclaw-sandbox-helper wrapper
        args: [...policyArgs, "--", ...config.command],
        env: config.environment,
        cwd: config.cwd,
      });
    }
    return new StdioClientTransport({
      command: config.command[0],
      args: config.command.slice(1),
      env: config.environment,
      cwd: config.cwd,
    });
  }

  // Remote: try Streamable HTTP first, fall back to SSE
  const headers = interpolateHeaders(config.headers, process.env);
  return new StreamableHTTPClientTransport(new URL(config.url), { headers });
}
```

### Reconnection Strategy

The SDK does not handle reconnection. We implement exponential backoff:

```
Attempt 1: wait 1s
Attempt 2: wait 2s
Attempt 3: wait 4s
Attempt 4: wait 8s
Attempt 5: wait 16s
Max: 30s between attempts
Max attempts: 10 (then give up, set status to "error")
```

On `client.onclose`, schedule reconnection. On `client.onerror`, log and continue (errors don't always mean disconnection).

## Tool Discovery and Registry Integration

### Discovery Flow

On connect (and on `notifications/tools/list_changed`):

1. Call `client.listTools()` with pagination (follow `nextCursor`)
2. Apply `allowTools`/`denyTools` filters from config
3. Convert each MCP `Tool` to a SafeClaw `ToolHandler` via the converter
4. Store in `McpToolRegistry` keyed by server name
5. Emit `"tools-updated"` event on the event bus

### Tool ID Namespacing

MCP tool names are prefixed with server name to avoid collisions:

```
Tool ID: mcp__{serverName}__{toolName}
Example: mcp__filesystem__read_file
```

The double-underscore delimiter is chosen because:
- Single underscore is common in tool names (`read_file`)
- Dashes are common in server names (`my-server`)
- Double-underscore is unambiguous for splitting

### MCP Tool -> ToolHandler Conversion

```typescript
function convertMcpTool(
  serverName: string,
  mcpTool: Tool,
  client: McpClientWrapper,
  config: McpServerConfig,
): ToolHandler {
  return {
    name: `mcp__${sanitize(serverName)}__${sanitize(mcpTool.name)}`,
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
    requiredCapabilities: ["mcp:invoke"],

    async execute(args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool(mcpTool.name, args);
      return result;
    },
  };
}
```

### CompositeToolRegistry

A new `ToolRegistry` implementation that merges builtin + MCP tools:

```typescript
class CompositeToolRegistry implements ToolRegistry {
  constructor(private registries: ToolRegistry[]);

  register(handler: ToolHandler): void;  // Delegates to first registry
  get(name: string): ToolHandler | undefined;  // Searches all registries
  list(): ToolHandler[];  // Merges all registries
}
```

This is wired in `bootstrap.ts`:
```typescript
const builtinRegistry = new SimpleToolRegistry();
// ... register builtin tools ...

const mcpRegistry = mcpManager.getToolRegistry();
const compositeRegistry = new CompositeToolRegistry([builtinRegistry, mcpRegistry]);
// Pass compositeRegistry to ToolOrchestrator
```

## Context Bloat Control (Two-Step Mode)

### Problem

With many MCP servers, the full tool schemas could consume thousands of tokens. A filesystem server alone might have 10+ tools with complex input schemas.

### Strategy: Two-Step Tool Resolution

**Step 1 (every LLM request):** Send only tool names + short descriptions. MCP tools use a compact format:

```json
{
  "type": "function",
  "function": {
    "name": "mcp__filesystem__read_file",
    "description": "[MCP:filesystem] Read file contents. Call with no args to get full schema.",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

**Step 2 (on tool selection):** When the model calls an MCP tool with empty args, return the full input schema as the tool result instead of executing. The model then calls again with proper args.

**Alternative Step 2:** When the model calls an MCP tool with args, execute normally. The empty-parameters schema acts as a "call to learn more" mechanism only when needed.

### Implementation

```typescript
class McpToolRegistry implements ToolRegistry {
  private compactMode: boolean = true;  // default: two-step

  list(): ToolHandler[] {
    if (this.compactMode) {
      return this.tools.map(tool => ({
        ...tool,
        // Override parameters to be empty in compact mode
        parameters: { type: "object", properties: {} },
        description: `[MCP:${tool.serverName}] ${tool.shortDescription}. Call with no args to get full schema.`,
      }));
    }
    return this.tools;
  }
}
```

When executed with empty args:
```typescript
async execute(args: Record<string, unknown>): Promise<string> {
  if (Object.keys(args).length === 0 && this.compactMode) {
    return JSON.stringify({
      name: this.originalName,
      description: this.fullDescription,
      inputSchema: this.fullInputSchema,
    }, null, 2);
  }
  return await this.client.callTool(this.originalName, args);
}
```

### Additional Controls

- **allowTools/denyTools** per server in config -- filter at discovery time
- **Tool schema caching** with content hash -- only refresh when hash changes
- **TTL**: tool definitions cached for 5 minutes, refreshed on `list_changed` notification

### Recommended Defaults

| Setting | Default | Rationale |
|---------|---------|-----------|
| Two-step mode | Enabled | Prevents context bloat with many MCP tools |
| Cache TTL | 5 minutes | Balance between freshness and overhead |
| allowTools/denyTools | None (all tools) | User controls via config |
| requireConfirmation | true | Security-first: user approves MCP tool calls |

## list_changed Notifications

```typescript
// In McpClientWrapper constructor:
const client = new Client(
  { name: "safeclaw", version: "1.0.0" },
  {
    listChanged: {
      tools: {
        onChanged: (_error, tools) => {
          this.cachedTools = tools ?? [];
          this.applyFilters();
          this.deps.eventBus?.emit("mcp:tools-updated", {
            server: this.serverName,
            tools: this.filteredTools,
          });
        },
      },
      prompts: {
        onChanged: (_error, prompts) => {
          this.cachedPrompts = prompts ?? [];
          this.deps.eventBus?.emit("mcp:prompts-updated", {
            server: this.serverName,
          });
        },
      },
    },
  },
);
```

## Remote Auth (Headers + OAuth)

### AuthProvider

```typescript
interface McpAuthProvider {
  getHeaders(serverName: string): Promise<Record<string, string>>;
  authenticate(serverName: string, config: McpOAuthConfig): Promise<void>;
  logout(serverName: string): Promise<void>;
  hasCredentials(serverName: string): boolean;
}
```

### Static Headers with Env Interpolation

```typescript
function interpolateHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(/\{env:(\w+)\}/g, (_, name) => env[name] ?? ""),
    ]),
  );
}
```

### OAuth Flow

For servers that require OAuth:

1. Use `@modelcontextprotocol/sdk` built-in OAuth support if available, OR:
2. Implement device/browser flow:
   - Discover authorization server from MCP server's 401 response
   - Attempt Dynamic Client Registration (RFC 7591)
   - Open browser for user authorization
   - Exchange code for tokens
   - Store tokens in vault

### Token Storage

OAuth tokens stored in the vault under `mcp_oauth_{serverName}`:

```typescript
vault.set(`mcp_oauth_${serverName}`, JSON.stringify({
  accessToken: "...",
  refreshToken: "...",
  expiresAt: "2026-03-07T00:00:00Z",
  scope: "tools:read tools:execute",
}));
vault.save();
```

**Why vault?** The vault already provides AES-256-GCM encryption with scrypt-derived keys and 0o600 file permissions. Reusing it avoids a second secret store.

### Token Refresh

Before each remote request, check if token is expiring (within 5 minutes):
- If refresh token available: use token refresh grant
- If not: re-initiate OAuth flow
- On 401 during a tool call: attempt one token refresh, retry, then fail

### Security Constraints

- Tokens are NEVER included in tool results sent to the LLM
- Auth headers are injected at the transport layer only
- Vault key names containing "oauth" are redacted in audit log output
- `McpAuthProvider` is not accessible from tool handlers

## Permission Gating

### Capability Extension

Add `"mcp:invoke"` to the `Capability` union type:

```typescript
export type Capability =
  | "fs:read" | "fs:write"
  | "net:http" | "net:https"
  | "process:spawn"
  | "env:read"
  | "secret:read" | "secret:write"
  | "mcp:invoke";       // NEW
```

### Per-Server Skill Registration

Each MCP server is registered as a skill in the `CapabilityRegistry`:

```typescript
capabilityRegistry.registerSkill({
  id: `mcp:${serverName}`,
  name: `MCP Server: ${serverName}`,
  version: "dynamic",
  capabilities: [{ capability: "mcp:invoke", reason: "MCP tool execution" }],
  signature: "",  // MCP servers are not Ed25519-signed; trust comes from config
});

capabilityRegistry.grantCapability({
  skillId: `mcp:${serverName}`,
  capability: "mcp:invoke",
  constraints: {},
  grantedAt: new Date(),
  grantedBy: "user",  // Configured by user in safeclaw.json
});
```

### User Confirmation

When `requireConfirmation: true` (default):

```
┌─ MCP Tool Call ────────────────────────────────────────┐
│ Server: filesystem                                     │
│ Tool: write_file                                       │
│ Args: { "path": "/tmp/test.txt", "content": "hello" } │
│                                                        │
│ Allow? [y/N/always]                                    │
└────────────────────────────────────────────────────────┘
```

- `y` -- allow this invocation
- `N` -- deny (default)
- `always` -- allow this tool without future prompts (persisted in session)

### Audit Logging

All MCP tool executions flow through `ToolOrchestrator.execute()`, which already records `AuditEntry`. The entry includes:

```typescript
{
  timestamp: new Date(),
  request: {
    skillId: "mcp:filesystem",
    toolName: "mcp__filesystem__read_file",
    args: { path: "/tmp/test.txt" },  // Redacted if contains known secret patterns
  },
  result: {
    success: true,
    output: "file contents...",
    durationMs: 42,
    sandboxed: true,  // true if local server was sandboxed
  },
}
```

## CLI Commands

### `safeclaw mcp` subcommand group

```
safeclaw mcp                    # List all MCP servers and status
safeclaw mcp tools <server>     # List tools for a specific server
safeclaw mcp enable <server>    # Enable a disabled server
safeclaw mcp disable <server>   # Disable a server
safeclaw mcp refresh [server]   # Refresh tool list (all or specific)
safeclaw mcp auth <server>      # Initiate OAuth flow for remote server
safeclaw mcp logout <server>    # Remove stored OAuth tokens
```

### Slash Commands

```
/mcp                            # Show MCP server status summary
/prompts                        # List available MCP prompts
/prompt <server>/<name> [args]  # Execute an MCP prompt
```

## Sandbox Integration for Local MCP Servers

Local MCP servers run inside the SafeClaw sandbox by default. The sandbox policy is built using `PolicyBuilder`:

```typescript
if (config.type === "local" && config.sandbox?.enabled !== false) {
  const policy = PolicyBuilder.forDevelopment(config.cwd ?? process.cwd())
    .build();

  // Spawn the MCP server command through the sandbox
  const transport = new StdioClientTransport({
    command: sandboxHelperPath,
    args: [...policyFlags, "--", ...config.command],
    env: config.environment,
  });
}
```

When `sandbox.enabled: false` is set in config, the server runs unsandboxed.

## Test Plan

### Fixtures

**Fake stdio MCP server** (`packages/mcp/test/fixtures/fake-stdio-server.ts`):
- Node.js script that speaks MCP JSON-RPC over stdin/stdout
- Implements: `initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`
- Supports: pagination, `list_changed` notifications, configurable delay/errors

**Fake HTTP MCP server** (`packages/mcp/test/fixtures/fake-http-server.ts`):
- Node.js HTTP server with Streamable HTTP transport
- Same capabilities as stdio fixture
- Supports: OAuth 401 responses, token validation

### Test Cases

| Module | Tests | Coverage Target |
|--------|-------|-----------------|
| `converter.ts` | MCP Tool -> ToolHandler conversion, namespacing, sanitization, empty schema handling | 100% |
| `registry.ts` | Tool registration, lookup, list with compact mode, allow/deny filters | 100% |
| `client-wrapper.ts` | Connect, disconnect, reconnect with backoff, tool discovery, pagination, tool call, error handling, timeout | 90% |
| `manager.ts` | Multi-server lifecycle, connectAll, disconnectAll, status tracking, list_changed refresh | 90% |
| `transport.ts` | stdio transport creation, HTTP transport creation, sandbox wrapping, header interpolation | 100% |
| `auth.ts` | Static headers, env interpolation, OAuth token storage/retrieval, token refresh, secret redaction | 95% |
| `config.ts` | Config validation, merge logic (global + project), type discrimination | 100% |
| `composite-registry.ts` | Multi-registry merge, name collision handling, lookup across registries | 100% |

### Critical Path Tests

1. **End-to-end stdio**: Spawn fake server -> connect -> discover tools -> call tool -> verify result
2. **End-to-end HTTP**: Start fake HTTP server -> connect -> discover -> call -> verify
3. **Reconnection**: Connect -> kill server -> verify reconnect with backoff -> verify tools re-discovered
4. **list_changed**: Connect -> server sends notification -> verify tools refreshed
5. **Policy filter**: Configure allowTools -> verify only allowed tools in registry
6. **Secret redaction**: OAuth token in vault -> verify not present in audit log or tool results
7. **Two-step mode**: Compact tool list -> model calls with empty args -> verify schema returned -> model calls with real args -> verify execution

## Implementation Milestones

### Milestone 1: Core Package + Config (2-3 days)
- Create `packages/mcp/` workspace
- Define all TypeScript types (`config.ts`, `types.ts`)
- Extend `SafeClawConfig` with `mcp` field
- Add config validation and merge logic (global + project)
- Add `"mcp:invoke"` capability type
- Tests for config validation

### Milestone 2: Client + Transport + Discovery (3-4 days)
- Implement `McpClientWrapper` with `@modelcontextprotocol/sdk` `Client`
- Implement transport factory (stdio + Streamable HTTP)
- Implement tool discovery with pagination
- Implement `converter.ts` (MCP Tool -> ToolHandler)
- Implement `McpToolRegistry` with allow/deny filters
- Tests with fake stdio server fixture

### Milestone 3: Manager + Registry Integration (2-3 days)
- Implement `McpManager` (multi-server lifecycle)
- Implement `CompositeToolRegistry` in core
- Wire into `bootstrap.ts`
- Implement reconnection with exponential backoff
- Implement `list_changed` notification handling
- Tests for manager lifecycle, reconnection

### Milestone 4: Context Bloat Control (1-2 days)
- Implement two-step compact mode in `McpToolRegistry`
- Implement tool schema caching with content hash
- Tests for compact mode behavior

### Milestone 5: Auth + Security (2-3 days)
- Implement `McpAuthProvider` (static headers + env interpolation)
- Implement OAuth device/browser flow
- Implement token storage in vault
- Implement token refresh
- Implement user confirmation prompt
- Wire into capability system (per-server skill registration)
- Tests for auth, token storage, secret redaction

### Milestone 6: CLI + Slash Commands (1-2 days)
- Implement `safeclaw mcp` subcommand group
- Add `/mcp`, `/prompts`, `/prompt` slash commands
- Wire sandbox for local MCP servers
- Integration tests

### Milestone 7: Documentation + Polish (1 day)
- Update README.md, AGENTS.md, docs/architecture.md
- Write MCP-specific documentation (docs/mcp.md)
- Final test pass, coverage check

**Total estimated effort: 12-18 days**

## SDK Dependencies

Using `@modelcontextprotocol/sdk` v1.x (stable):

| SDK Component | Usage |
|---------------|-------|
| `Client` | Core MCP client -- connect, list, call |
| `StdioClientTransport` | Local server transport via stdin/stdout |
| `StreamableHTTPClientTransport` | Remote server transport |
| `SSEClientTransport` | Fallback for older remote servers |
| `Tool`, `Resource`, `Prompt` types | Type-safe discovery results |
| `CallToolResult` | Tool execution result type |
| `listChanged` option | Automatic notification handling |

**Peer dependency:** `zod` (required by the SDK for schema validation).

We use the SDK's `Client` class directly rather than reimplementing JSON-RPC because:
1. It handles the initialize/initialized handshake correctly
2. It manages capability negotiation
3. It provides typed notification handlers
4. It handles pagination cursors
5. It's maintained by the MCP spec authors

## What This Feature Does NOT Change

- Built-in tools (read, write, edit, bash, etc.) -- unchanged
- Agent loop structure -- unchanged (tools are just added to the registry)
- Provider interface -- unchanged
- Session management -- unchanged
- Vault encryption -- unchanged (just stores additional keys)
- Sandbox enforcement for built-in tools -- unchanged
