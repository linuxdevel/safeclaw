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
- GitHub Copilot API integration (Claude Sonnet 4 default)
- Interactive CLI and browser-based WebChat channels
- Built-in tools: file read/write/edit, bash execution, web fetch — all capability-gated
- 5-step onboarding wizard with kernel capability detection
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

## Roadmap

Planned features with implementation plans (in priority order):

| # | Feature | Plan | Priority | Status |
|---|---------|------|----------|--------|
| 1 | Tool parameter schemas | [plan](docs/plans/2026-03-03-tool-parameter-schemas.md) | High | Planned |
| 2 | Streaming responses | [plan](docs/plans/2026-03-03-streaming-responses.md) | High | Planned |
| 3 | Chat slash commands | [plan](docs/plans/2026-03-03-chat-commands.md) | High | Planned |
| 4 | Configuration file | [plan](docs/plans/2026-03-03-configuration-file.md) | High | Planned |
| 5 | Session persistence | [plan](docs/plans/2026-03-03-session-persistence.md) | Medium | Planned |
| 6 | Context compaction | [plan](docs/plans/2026-03-03-context-compaction.md) | Medium | Planned |
| 7 | WebSocket gateway | [plan](docs/plans/2026-03-03-websocket-gateway.md) | Medium | Planned |
| 8 | Multi-model support | [plan](docs/plans/2026-03-03-multi-model-support.md) | Medium | Planned |
| 9 | Web search tool | [plan](docs/plans/2026-03-03-web-search-tool.md) | Low | Planned |
| 10 | Background process management | [plan](docs/plans/2026-03-03-background-process-management.md) | Low | Planned |
| 11 | Doctor command | [plan](docs/plans/2026-03-03-doctor-command.md) | Low | Planned |
| 12 | Multi-file patch tool | [plan](docs/plans/2026-03-03-multi-file-patch-tool.md) | Low | Planned |

## CLI Commands

| Command | Description |
|---------|-------------|
| `safeclaw chat` | Interactive AI chat session |
| `safeclaw onboard` | First-time setup wizard |
| `safeclaw serve` | Start gateway + webchat server |
| `safeclaw audit` | Security audit report |
| `safeclaw audit --json` | Audit report in JSON format |
| `safeclaw help` | Show usage information |
| `safeclaw version` | Show version |

## Architecture

Monorepo structure:

- `@safeclaw/vault` — Encrypted secrets storage
- `@safeclaw/sandbox` — OS-level process sandboxing
- `@safeclaw/core` — Capabilities, agent runtime, sessions, tools, skills, copilot client
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
