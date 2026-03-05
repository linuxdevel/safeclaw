# SafeClaw

A security-first personal AI assistant with zero-trust architecture.

> **Work in Progress** — SafeClaw is under active development. See the
> [Feature Status](#feature-status) table below for current implementation state.

## Overview

SafeClaw is a secure alternative to open-source AI assistants. Built with mandatory sandboxing, signed skills, encrypted secrets, and capability-based access control. Security is structural, not opt-in — every tool execution is sandboxed, every skill is signed, every secret is encrypted at rest.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/linuxdevel/safeclaw/main/install.sh | bash
```

Requires: Linux (x86\_64 or arm64), Node.js >= 22.

After install, run `safeclaw onboard` for first-time setup.

## Features

- Zero-trust security model with mandatory OS-level sandboxing (Landlock + seccomp-BPF + Linux namespaces)
- AES-256-GCM encrypted secrets vault with OS keyring or passphrase-derived keys
- Ed25519-signed skill manifests with capability declarations and runtime enforcement
- Multi-provider LLM support: GitHub Copilot, OpenAI, and Anthropic (Claude Sonnet 4 default)
- Interactive CLI and browser-based WebChat channels
- Built-in tools: file read/write/edit, bash execution, web fetch, web search, background process management, multi-file patch application — all capability-gated
- 5-step onboarding wizard with kernel capability detection
- `safeclaw doctor` diagnostic command with 12 checks across system, security, config, and connectivity
- Security audit CLI for inspecting skills, sessions, and tool executions
- HTTP gateway with token auth and rate limiting

## Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| Encrypted vault (AES-256-GCM + scrypt) | Done | OS keyring and passphrase-derived keys |
| Ed25519 skill signing and verification | Done | Sign, verify, reject unsigned |
| Capability declarations and enforcement | Done | Path/host/executable constraints |
| GitHub Copilot API client | Done | Streaming and non-streaming, device flow auth |
| Dynamic model discovery | Done | Fetches available models during onboarding |
| Agent loop with tool calling | Done | Multi-round tool execution |
| Built-in tools (read, write, edit, bash, web\_fetch) | Done | All declare required capabilities |
| Web search tool (web\_search) | Done | Brave Search API; conditionally included when `brave_api_key` is in vault |
| Background process management (`process`) | Done | Start/status/log/kill/list subcommands; max 8 concurrent, 1MB ring buffer, 1h auto-cleanup |
| Multi-file patch tool (`apply_patch`) | Done | Unified diff parsing, fuzzy hunk matching, atomic multi-file writes |
| Doctor command (`safeclaw doctor`) | Done | 12 diagnostic checks across 4 categories; also available as `/doctor` chat command |
| CLI channel (interactive chat) | Done | readline-based with passphrase masking |
| WebChat SPA | Done | Dark theme, localStorage auth config |
| HTTP gateway with auth and rate limiting | Done | Token-based, timing-safe comparison |
| Onboarding wizard | Done | 5-step: kernel check, auth, vault, keys, model |
| Session management | Done | Create, peer indexing, isolation |
| Audit logging (in-memory) | Done | Per-execution recording with rotation |
| CI/CD (GitHub Actions) | Done | Lint, build, typecheck, test, release |
| Install script with vault preservation | Done | Upgrade-safe, preserves vault files |
| OS-level sandboxing (Landlock + seccomp + namespaces) | Done | Namespace + Landlock + seccomp + capability drop via native helper |
| Sandbox-enforced tool execution | Done | Bash tool routed through sandbox; audit log records sandboxed status |
| `safeclaw audit` CLI command | Done | Wired into CLI; calls bootstrapAgent and runAudit |
| Path normalization in capability enforcer | Done | resolve()-based normalization prevents traversal |
| Runtime capability gating in agent bootstrap | Done | Loads builtin manifest; grants only declared capabilities |
| Tool parameter schemas (JSON Schema) | Done | All builtin tools declare parameter schemas |
| Streaming responses | Done | SSE-based streaming in agent loop and channels |
| Chat slash commands | Done | /help, /model, /clear, /compact, /session, /sessions, /export, /doctor |
| Configuration file (safeclaw.json) | Done | Model, prompt, tool rounds, gateway, sandbox settings |
| Session persistence (FileSessionStore) | Done | Sessions survive restarts; file-backed store |
| Context compaction | Done | LLM-powered conversation summarization at 80% context threshold |
| WebSocket gateway | Done | Real-time bidirectional communication |
| Multi-model provider support | Done | ModelProvider interface; Copilot, OpenAI, Anthropic providers |

## Roadmap

Planned features with implementation plans (in priority order):

| # | Feature | Plan | Priority | Status |
|---|---------|------|----------|--------|
| 1 | Tool parameter schemas | [plan](docs/plans/2026-03-03-tool-parameter-schemas.md) | High | Done |
| 2 | Streaming responses | [plan](docs/plans/2026-03-03-streaming-responses.md) | High | Done |
| 3 | Chat slash commands | [plan](docs/plans/2026-03-03-chat-commands.md) | High | Done |
| 4 | Configuration file | [plan](docs/plans/2026-03-03-configuration-file.md) | High | Done |
| 5 | Session persistence | [plan](docs/plans/2026-03-03-session-persistence.md) | Medium | Done |
| 6 | Context compaction | [plan](docs/plans/2026-03-03-context-compaction.md) | Medium | Done |
| 7 | WebSocket gateway | [plan](docs/plans/2026-03-03-websocket-gateway.md) | Medium | Done |
| 8 | Multi-model support | [plan](docs/plans/2026-03-03-multi-model-support.md) | Medium | Done |
| 9 | Web search tool | [plan](docs/plans/2026-03-03-web-search-tool.md) | Low | Done |
| 10 | Background process management | [plan](docs/plans/2026-03-03-background-process-management.md) | Low | Done |
| 11 | Doctor command | [plan](docs/plans/2026-03-03-doctor-command.md) | Low | Done |
| 12 | Multi-file patch tool | [plan](docs/plans/2026-03-03-multi-file-patch-tool.md) | Low | Done |

## CLI Commands

| Command | Description |
|---------|-------------|
| `safeclaw chat` | Interactive AI chat session |
| `safeclaw onboard` | First-time setup wizard |
| `safeclaw serve` | Start gateway + webchat server |
| `safeclaw audit` | Security audit report |
| `safeclaw audit --json` | Audit report in JSON format |
| `safeclaw doctor` | System diagnostic checks |
| `safeclaw help` | Show usage information |
| `safeclaw version` | Show version |

## Architecture

Monorepo structure:

- `@safeclaw/vault` — Encrypted secrets storage
- `@safeclaw/sandbox` — OS-level process sandboxing
- `@safeclaw/core` — Capabilities, agent runtime, sessions, tools, skills, model providers, copilot client
- `@safeclaw/gateway` — HTTP server with auth and rate limiting
- `@safeclaw/cli` — Command-line interface
- `@safeclaw/webchat` — Browser-based chat SPA

## Development

```bash
git clone git@github.com:linuxdevel/safeclaw.git
cd safeclaw
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Security Model](docs/security-model.md)
- [Sandboxing Deep Dive](docs/sandboxing.md) — enforcement layers, threat model, helper architecture
- [Skill Development](docs/skill-development.md)
- [Architecture](docs/architecture.md)

## License

ISC
