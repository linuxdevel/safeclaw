# Architecture

## System overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Channel Adapters                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   CLI    │  │   WebChat    │  │  (future: Telegram, etc) │  │
│  └────┬─────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│       │               │                       │                │
│       └───────────────┼───────────────────────┘                │
│                       │                                        │
│                       ▼                                        │
│              ┌────────────────┐                                │
│              │    Gateway     │  Auth + Rate Limiting           │
│              └───────┬────────┘                                │
│                      │                                         │
│                      ▼                                         │
│              ┌────────────────┐                                │
│              │  Session Mgr   │  Per-channel-per-peer          │
│              └───────┬────────┘                                │
│                      │                                         │
│                      ▼                                         │
│              ┌────────────────┐     ┌───────────────────────────────┐
│              │    Agent       │────▶│  Model Provider               │
│              │  (LLM loop)   │◀────│  (Copilot / OpenAI / Anthropic)│
│              └───────┬────────┘     └───────────────────────────────┘
│                      │                                         │
│                      ▼                                         │
│              ┌────────────────┐                                │
│              │ Tool Orchestr. │  Capability enforcement         │
│              └───────┬────────┘                                │
│                      │                                         │
│         ┌────────────┼────────────┐                            │
│         ▼            ▼            ▼                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐ ┌─────────────┐ │
│  │  read    │ │  bash    │ │ web_fetch│ │web_search │ │  process  │ │ apply_patch │ │
│  │  write   │ │          │ │          │ │(optional) │ │           │ │             │ │
│  │  edit    │ │          │ │          │ │           │ │           │ │             │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘ └───────────┘ └─────────────┘ │
│                      │                                         │
│                      ▼                                         │
│              ┌────────────────┐                                │
│              │   Sandbox      │  Landlock + seccomp + NS       │
│              └────────────────┘                                │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐     │
│  │    Vault     │  │  Audit Log   │  │ Capability Reg.  │     │
│  │  (encrypted) │  │              │  │ + Enforcer       │     │
│  └──────────────┘  └──────────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

## Package structure

SafeClaw is a pnpm monorepo with six packages under `packages/`:

### `@safeclaw/vault`

Encrypted secrets storage.

- `Vault` class: create, open, get, set, delete, save, list keys
- `encrypt` / `decrypt`: AES-256-GCM with random IV per entry
- `deriveKeyFromPassphrase`: scrypt key derivation (N=2^17, r=8, p=1)
- `KeyringProvider`: OS keyring integration via `secret-tool` (GNOME Keyring)
- `assertFilePermissions`: enforces `0o600` on vault files

No dependencies on other SafeClaw packages.

### `@safeclaw/sandbox`

OS-level process isolation using Linux kernel features.

- `SandboxPolicy` / `DEFAULT_POLICY`: policy types with maximally restrictive defaults
- `PolicyBuilder`: fluent API for constructing sandbox policies; `PolicyBuilder.forDevelopment(cwd)` creates a ready-made policy for software development with allowlisted system paths, compiler toolchains, and an expanded syscall set
- `detectKernelCapabilities`: probes `/proc` for Landlock, seccomp, namespace support
- `assertSandboxSupported`: throws if required kernel features are missing
- `Sandbox` class: executes commands under policy (stub in v1; types and policies are real)

No dependencies on other SafeClaw packages.

### `@safeclaw/core`

Central package containing the agent runtime and security infrastructure.

**Capabilities** (`capabilities/`):
- `CapabilityRegistry`: stores skill manifests and capability grants
- `CapabilityEnforcer`: checks grants at runtime, throws `CapabilityDeniedError`
- `generateSigningKeyPair` / `signManifest`: Ed25519 key generation and signing
- `verifyManifestSignature`: Ed25519 signature verification

**Copilot API** (`copilot/`):
- `requestDeviceCode` / `pollForToken` / `getCopilotToken`: device flow OAuth
- `CopilotClient`: chat completions (non-streaming and streaming SSE)
- Types: `CopilotModel`, `ChatMessage`, `ChatCompletionRequest/Response`, `StreamChunk`

**Providers** (`providers/`):
- `ModelProvider` interface: common `chat()` and `chatStream()` methods for all LLM backends
- `CopilotProvider`: wraps `CopilotClient` for GitHub Copilot API
- `OpenAIProvider`: native `fetch` against OpenAI chat completions API
- `AnthropicProvider`: translates between OpenAI wire format and Anthropic Messages API
- `ProviderRegistry`: manages available provider instances

**Sessions** (`sessions/`):
- `Session`: conversation history management
- `SessionManager`: per-channel-per-peer session lookup, creation, destruction

**Skills** (`skills/`):
- `SkillLoader`: parse manifest from file or string, validate required fields
- `SkillInstaller`: verify signature, register in registry, optionally auto-approve capabilities

**Tools** (`tools/`):
- `ToolOrchestrator`: capability-gated tool execution
- `SimpleToolRegistry`: in-memory tool handler storage
- `AuditLog`: records tool executions (request + result + timestamp)
- Built-in tools: `read`, `write`, `edit`, `bash`, `web_fetch`, `apply_patch`, `process` (plus optional `web_search` when `brave_api_key` is in vault)
- `createBashTool(options?)`: factory function for the bash tool; accepts `allowedCommandPaths` for advisory command validation that warns when a binary is not under an allowed directory (Landlock is the real enforcement layer)
- `ProcessManager`: tracks spawned child processes by UUID with ring buffer output capture (1MB max per process), automatic cleanup after 1 hour, and maximum 8 concurrent processes
- `PatchParser` / `PatchApplier`: unified diff parser and hunk applier with fuzzy line-offset matching; used by the `apply_patch` tool for atomic multi-file patching

**Channels** (`channels/`):
- `ChannelAdapter` interface: `connect`, `disconnect`, `onMessage`, `send`
- `InboundMessage` / `OutboundMessage` / `PeerIdentity` types

**Agent** (`agent/`):
- `Agent` class: LLM loop with tool calling (send messages to configured ModelProvider, process tool calls, loop until final response)
- `DEFAULT_AGENT_CONFIG`: claude-sonnet-4, max 10 tool rounds

Dependencies: `@safeclaw/sandbox` (types only).

### `@safeclaw/gateway`

HTTP server with mandatory security.

- `Gateway` class: HTTP server on `/api/chat` (POST only)
- `validateAuthToken`: fail-closed validation (minimum 32 chars)
- `verifyToken`: constant-time comparison via `crypto.timingSafeEqual`
- `RateLimiter`: token bucket per client IP

No dependencies on other SafeClaw packages.

### `@safeclaw/cli`

Command-line interface adapter.

- `CliAdapter`: readline-based `ChannelAdapter` implementation
- `runOnboarding`: five-step onboarding wizard (kernel check, auth, vault, signing key, model selection)
- `setupChat`: wires the CLI adapter to the agent
- `runAudit`: generates security audit reports (text or JSON)
- `runDoctor`: runs 12 diagnostic checks across system, security, config, and connectivity categories

Dependencies: `@safeclaw/core`, `@safeclaw/gateway`, `@safeclaw/sandbox`, `@safeclaw/vault`.

### `@safeclaw/webchat`

Web-based chat interface.

- `WebChatAdapter`: HTTP server that serves a static SPA and handles chat messages
- Static file server with security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`)
- Path traversal protection via `resolve`-based validation
- Only serves `.html`, `.css`, `.js` files

Dependencies: `@safeclaw/core`.

## Request flow

A user message flows through these components:

```
User input
  │
  ▼
Channel Adapter (CLI readline or WebChat HTTP)
  │ creates InboundMessage { peer, content, timestamp }
  │
  ▼
Gateway (if WebChat)
  │ 1. Verify Bearer token (timing-safe)
  │ 2. Check rate limit (token bucket by IP)
  │ 3. Parse request body
  │
  ▼
Session Manager
  │ getOrCreate(peer) → Session
  │ Session keyed by channelId:peerId
  │
  ▼
Agent.processMessage(session, userMessage)
  │ 1. Add user message to session history
  │ 2. Build request: system prompt + history
  │ 3. Send to the configured model provider
  │
  ▼
Model Provider (CopilotProvider / OpenAIProvider / AnthropicProvider)
  │ Sends request to configured LLM API
  │ Returns: ChatCompletionResponse with choices
  │
  ▼
Agent (response handling)
  │ If finish_reason == "tool_calls":
  │   For each tool call:
  │     │
  │     ▼
  │   Tool Orchestrator.execute(request)
  │     │ 1. Look up ToolHandler by name
  │     │ 2. Check capabilities via CapabilityEnforcer
  │     │ 3. Execute handler
  │     │ 4. Record in AuditLog
  │     │
  │     ▼
  │   Tool Handler (read/write/edit/bash/web_fetch/web_search/process/apply_patch)
  │     │ Executes the operation
  │     │ Returns result string
  │     │
  │     ▼
  │   Agent adds tool result to session
  │   Loop back to model provider with updated history
  │
  │ If finish_reason == "stop":
  │   Add assistant message to session
  │   Return AgentResponse { message, toolCallsMade, model }
  │
  ▼
Channel Adapter
  │ Send response to user
  ▼
User sees response
```

The agent loops until either:
- The LLM returns a final response (no tool calls), or
- The maximum tool rounds limit is reached (default: 10)

## Data flow

### Vault encryption

```
User passphrase ──┐
                   │ scrypt (N=2^17, r=8, p=1)
Salt (16 bytes) ──┘
                   │
                   ▼
              256-bit key
                   │
                   ▼
Plaintext ──▶ AES-256-GCM ──▶ { ciphertext, iv, authTag }
             (12-byte random IV)         │
                                         ▼
                                    Vault file (0o600)
```

Alternatively, with OS keyring: a random 32-byte key is stored in GNOME Keyring and used directly (no scrypt derivation).

### Session management

```
InboundMessage { peer: { channelId, peerId } }
       │
       ▼
SessionManager.getOrCreate(peer)
       │ lookup by "channelId:peerId"
       │
       ├── Found → return existing Session
       │
       └── Not found → create new Session
                         │ random UUID as session ID
                         │ empty message history
                         │
                         ▼
                    Session stored in memory
```

Sessions are in-memory only. They do not persist across restarts.

### Audit logging

```
ToolOrchestrator.execute()
       │
       ▼
AuditLog.record(request, result)
       │
       ▼
AuditEntry {
  timestamp: Date,
  request: { skillId, toolName, args },
  result: { success, output, error, durationMs, sandboxed }
}
```

The audit log maintains the last N entries in memory (default: 100). The `safeclaw audit` command displays the log.

## Key design decisions

### Linux-only (v1)

SafeClaw v1 targets Linux exclusively. The sandboxing architecture depends on Landlock (kernel >= 5.13), seccomp-BPF, and Linux namespaces. These have no direct equivalents on macOS or Windows. Future versions may add platform-specific sandboxing.

### Multi-provider LLM support

SafeClaw supports multiple LLM providers through the `ModelProvider` interface: GitHub Copilot (default, using device flow OAuth), OpenAI (API key), and Anthropic (API key). All providers implement the same `chat()` and `chatStream()` methods using the OpenAI chat completions wire format as the common interface. Providers that use a different wire format (e.g. Anthropic) translate internally. Provider selection is vault-driven — the `provider` key in the vault determines which backend is used. API keys for third-party providers are stored encrypted in the vault alongside other secrets.

### Fail-closed defaults

Every security mechanism defaults to deny:

- Default sandbox policy: no filesystem, no network, minimal syscalls
- Default skill policy: reject unsigned
- Default auth: refuse to start without token
- Default capability: no grants until explicitly approved

This means misconfiguration results in denied access, not open access.

### In-memory state

Sessions, audit logs, and capability grants are stored in memory. This simplifies the architecture (no database, no migration path) but means state is lost on restart. The vault is the only persistent store, and it contains only encrypted secrets.

### Monorepo structure

The six packages have clear dependency boundaries:

```
@safeclaw/vault      (standalone)
@safeclaw/sandbox    (standalone)
@safeclaw/gateway    (standalone)
@safeclaw/core       (depends on: sandbox types)
@safeclaw/webchat    (depends on: core)
@safeclaw/cli        (depends on: core, gateway, sandbox, vault)
```

`vault`, `sandbox`, and `gateway` have no internal dependencies, making them independently testable and replaceable.

## Extension points

### ChannelAdapter interface

New messaging surfaces implement the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<OutboundMessage>): void;
  send(peer: PeerIdentity, content: OutboundMessage): Promise<void>;
}
```

The `id` is used as the `channelId` component of session keys. Implementing a new adapter (e.g., Telegram, Slack, Matrix) requires:

1. Implementing `ChannelAdapter`.
2. Mapping the platform's user identity to `PeerIdentity`.
3. Wiring the adapter to the gateway and agent.

### ToolHandler interface

New tools implement the `ToolHandler` interface:

```typescript
interface ToolHandler {
  name: string;
  description: string;
  requiredCapabilities: Capability[];
  execute(args: Record<string, unknown>): Promise<string>;
}
```

Register handlers with the `SimpleToolRegistry`:

```typescript
const registry = new SimpleToolRegistry();
registry.register({
  name: "my_tool",
  description: "Does something",
  requiredCapabilities: ["fs:read"],
  execute: async (args) => {
    // implementation
    return "result";
  },
});
```

The tool orchestrator automatically enforces capability checks before executing any registered handler.

### Skill system

Third-party skills provide tools through signed manifests. The skill system handles:

1. **Loading**: `SkillLoader` parses and validates manifest JSON.
2. **Verification**: `SkillInstaller` verifies Ed25519 signatures.
3. **Registration**: Skills and their capability requirements are registered in `CapabilityRegistry`.
4. **Enforcement**: `CapabilityEnforcer` checks grants on every tool execution.

See [Skill Development](skill-development.md) for the complete workflow.
