# SafeClaw -- AI Agent Context

> Security-first personal AI coding assistant with zero-trust architecture.

## What This Project Is

SafeClaw is an AI coding assistant with multi-provider LLM support (GitHub Copilot, OpenAI, Anthropic), mandatory OS-level sandboxing, capability-based access control, encrypted secret storage, and signed skill verification. Every tool execution is sandboxed via Linux kernel features (Landlock, seccomp-BPF, namespaces). There is no way to disable security enforcement -- it is structural.

The target user is an individual developer who wants AI-assisted coding with strong guarantees against prompt injection, malicious tool calls, and data exfiltration.

**Linux-only. Node.js >= 22. pnpm 9+.**

## Repository Structure

```
safeclaw/
├── packages/           # pnpm monorepo workspace packages
│   ├── vault/          # @safeclaw/vault -- AES-256-GCM encrypted key-value store
│   ├── sandbox/        # @safeclaw/sandbox -- OS-level process sandboxing wrapper
│   ├── core/           # @safeclaw/core -- agent runtime, capabilities, tools, sessions, copilot client
│   ├── gateway/        # @safeclaw/gateway -- HTTP server with auth + rate limiting
│   ├── webchat/        # @safeclaw/webchat -- browser chat SPA + static file server
│   └── cli/            # @safeclaw/cli -- CLI entry point (top of dependency tree)
├── native/             # C11 sandbox helper binary (musl-gcc, statically linked)
├── skills/             # Builtin skill manifests (Ed25519-signed)
├── test/               # Cross-cutting security tests
├── docs/               # Architecture, security model, sandboxing, skills docs
│   └── plans/          # Design documents and implementation plans
└── scripts/            # Build/release scripts
```

## Package Dependency Graph

```
vault (standalone)     sandbox (standalone)
      \                    |
       \                   v
        +-----> core <-----+
               / | \
              /  |  \
             v   v   v
        gateway webchat cli (depends on all)
```

## Key Architectural Concepts

### Agent Loop
`packages/core/src/agent/agent.ts` -- Multi-round tool-calling loop. Sends messages to the configured model provider, receives tool call requests, executes them through the ToolOrchestrator, feeds results back. Continues until the model produces a final text response.

### Model Providers
- `packages/core/src/providers/types.ts` -- `ModelProvider` interface (common `chat()` and `chatStream()` methods)
- `packages/core/src/providers/copilot.ts` -- `CopilotProvider` wraps existing `CopilotClient`
- `packages/core/src/providers/openai.ts` -- `OpenAIProvider` uses native `fetch` against OpenAI API
- `packages/core/src/providers/anthropic.ts` -- `AnthropicProvider` translates OpenAI wire format to/from Anthropic Messages API
- `packages/core/src/providers/registry.ts` -- `ProviderRegistry` manages available providers
- Provider selection is vault-driven: `vault.get("provider")` returns `"copilot"` (default), `"openai"`, or `"anthropic"`

### Capability System
- `packages/core/src/capabilities/registry.ts` -- Tracks which skills have which capabilities
- `packages/core/src/capabilities/enforcer.ts` -- Checks every tool call against granted capabilities at runtime
- `packages/core/src/capabilities/verifier.ts` -- Ed25519 signature verification for skill manifests
- **8 capability types**: `fs:read`, `fs:write`, `net:http`, `net:https`, `process:spawn`, `env:read`, `secret:read`, `secret:write`
- Capabilities have constraints (e.g., allowed paths, allowed hosts)

### Tool Orchestrator
`packages/core/src/tools/orchestrator.ts` -- Central tool execution pipeline:
1. Capability check (enforcer)
2. Sandbox execution (if available) or direct execution
3. Audit logging (timestamp, duration, result, sandbox status)

### Builtin Tools
Located in `packages/core/src/tools/builtin/`:
- `read.ts`, `write.ts`, `edit.ts` -- File operations
- `bash.ts` -- Shell command execution
- `web-fetch.ts` -- HTTP fetching

Each tool declares `requiredCapabilities` and implements a `ToolHandler` interface.

### Sandbox
- `packages/sandbox/src/sandbox.ts` -- Spawns child process with `unshare` + native helper
- `native/src/main.c` -- C helper binary that applies: Landlock filesystem rules, seccomp-BPF syscall filtering, capability dropping, `PR_SET_NO_NEW_PRIVS`
- Policy sent to helper via fd 3 as JSON

### Vault
`packages/vault/src/vault.ts` -- AES-256-GCM encrypted JSON file store. Keys derived via scrypt from passphrase or fetched from OS keyring (GNOME `secret-tool`). File permissions enforced at 0o600.

### Channel Adapters
`packages/core/src/channels/types.ts` defines `ChannelAdapter` interface (`connect`, `disconnect`, `onMessage`, `send`). Two implementations:
- `packages/cli/src/adapter.ts` -- readline-based terminal
- `packages/webchat/src/adapter.ts` -- HTTP/SSE-based browser SPA

### Gateway
`packages/gateway/src/server.ts` -- HTTP server with:
- Bearer token auth (timing-safe comparison, min 32 chars)
- Token bucket rate limiting per client IP
- Single endpoint: `POST /api/chat`
- Localhost-only binding

## Entry Point and Bootstrap

The main entry point is `packages/cli/src/cli.ts` (registered as `safeclaw` binary).

Bootstrap flow (`packages/cli/src/commands/bootstrap.ts`):
1. Open vault (keyring or passphrase)
2. Read provider config from vault (`provider` key, defaults to `"copilot"`)
3. Create appropriate `ModelProvider` (CopilotProvider, OpenAIProvider, or AnthropicProvider)
4. Load builtin skill manifest
5. Create: CapabilityRegistry -> CapabilityEnforcer -> ToolRegistry -> Sandbox -> ToolOrchestrator -> ContextCompactor -> Agent
6. Return `{ agent, sessionManager, capabilityRegistry, auditLog }`

CLI commands: `chat` (default), `onboard`, `audit`, `serve`/`server`, `help`, `version`

## Technology Stack

| Aspect | Choice |
|--------|--------|
| Language | TypeScript (strict, ES2024 target) |
| Runtime | Node.js >= 22 |
| Modules | ESM (`"type": "module"`, `"module": "Node16"`) |
| Package manager | pnpm 9+ with workspaces |
| Build | `tsc` with project references (composite builds) |
| Tests | Vitest 4.x with v8 coverage |
| Linter | OxLint 1.50+ |
| Native code | C11, statically linked with musl-gcc |
| LLM API | Multi-provider: GitHub Copilot (device flow OAuth), OpenAI, Anthropic |
| Crypto | Node.js `crypto` -- AES-256-GCM, scrypt, Ed25519 |
| CI | GitHub Actions |

## Development Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages (tsc --build)
pnpm test             # Run all tests (vitest run)
pnpm lint             # Lint with oxlint
pnpm typecheck        # Type-check without emitting (tsc --build --dry)
pnpm bundle           # Create release bundle

# Native sandbox helper
make -C native        # Build (requires musl-tools)
make -C native check  # Run native tests
```

## Testing Patterns

- **Co-located tests**: `*.test.ts` files next to source files
- **Dependency injection**: All external dependencies are injectable via constructor/function parameters for testability
- **Mocking**: `vi.mock()` for module mocking, `vi.fn()` for function mocks
- **Security tests**: Dedicated `test/security/` directory with sandbox-escape, permission-escalation, crypto-validation, and auth-bypass tests
- **Native tests**: Shell scripts + compiled C test binaries in `native/test/`
- **Vitest config**: Module aliases map `@safeclaw/*` to source files (`vitest.config.ts`)

## Data Storage

- **No database** -- all runtime state is in-memory (sessions, audit log, capability registry)
- **Vault**: JSON file on disk (`~/.safeclaw/vault.json`), AES-256-GCM encrypted, 0o600 permissions
- **Config**: `~/.safeclaw/` directory

## Git Policy

**Never commit or push changes.** When work is complete (or at a logical stopping point), stop and ask the user to commit by providing a ready-to-run `git commit` command line with a good commit message. Example:

```
Ready to commit. Run:

git add -A && git commit -m "feat(tools): add JSON Schema parameters to all builtin tools"
```

The user will review and run the command themselves. Do not run `git add`, `git commit`, `git push`, or any other git write operation.

## Conventions

- **Commit style**: Conventional Commits -- `type(scope): description` (e.g., `feat(core): add agent runtime`)
- **Scopes**: `core`, `cli`, `sandbox`, `vault`, `native`, `gateway`, `webchat`, `security`, `skills`, `tools`, `ci`
- **Error handling**: Fail-closed (deny by default), custom error classes per domain
- **Exports**: Each package has `src/index.ts` barrel file re-exporting public API
- **No classes for data**: Use TypeScript interfaces/types for data shapes, classes for stateful components
- **Security principle**: Zero-trust, mandatory enforcement, no opt-out

## Important Files to Read First

When getting oriented with this codebase, read these files in order:
1. `docs/architecture.md` -- Full system architecture with diagrams
2. `docs/security-model.md` -- Security philosophy and threat model
3. `packages/core/src/agent/agent.ts` -- The central agent loop
4. `packages/core/src/tools/orchestrator.ts` -- How tool calls flow
5. `packages/core/src/capabilities/enforcer.ts` -- How capabilities are checked
6. `packages/cli/src/commands/bootstrap.ts` -- How everything gets wired together
7. `packages/sandbox/src/sandbox.ts` -- How sandboxing works
8. `native/src/main.c` -- The native sandbox helper entry point
