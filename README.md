# SafeClaw

A security-first personal AI coding assistant with zero-trust architecture.

## Overview

SafeClaw is a secure AI coding assistant with mandatory OS-level sandboxing, signed skills, encrypted secrets, and capability-based access control. Security is structural, not opt-in — every tool execution is sandboxed, every skill is signed, every secret is encrypted at rest.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/linuxdevel/safeclaw/main/install.sh | bash
```

Requires: Linux (x86\_64 or arm64), Node.js >= 22.

After install, run `safeclaw onboard` for first-time setup.

## Features

### Security

- Zero-trust security model with mandatory OS-level sandboxing (Landlock + seccomp-BPF + Linux namespaces)
- Development-ready sandbox policy via `PolicyBuilder.forDevelopment()` — allows compilers (GCC, JVM), package managers, and standard dev tools while enforcing kernel-level access control
- AES-256-GCM encrypted secrets vault with OS keyring or passphrase-derived keys
- Ed25519-signed skill manifests with capability declarations and runtime enforcement
- Capability-based access control with path/host/executable constraints
- Native C helper binary for sandbox enforcement (musl-gcc, statically linked)

### AI & Models

- Multi-provider LLM support: GitHub Copilot, OpenAI, and Anthropic
- Streaming responses with SSE-based token delivery
- Context compaction via LLM-powered conversation summarization
- Configurable default model with dynamic model discovery during onboarding

### Tools

- Built-in tools: file read/write/edit, bash execution, web fetch, web search, background process management, multi-file patch application — all capability-gated
- Advisory command validation in bash tool warns when binaries are outside allowed paths (Landlock enforces the real boundary)
- Web search via Brave Search API (conditionally included when API key is in vault)
- Background process management with ring buffer output capture (1MB max, 8 concurrent, 1h auto-cleanup)
- Multi-file patch tool with unified diff parsing, fuzzy hunk matching, and atomic writes

### Interface

- Interactive CLI with chat slash commands (/help, /model, /clear, /compact, /session, /sessions, /export, /doctor)
- Browser-based WebChat SPA with dark theme
- HTTP gateway with token auth and rate limiting
- WebSocket gateway for real-time bidirectional communication
- `safeclaw doctor` diagnostic command with 12 checks across system, security, config, and connectivity

### Infrastructure

- 5-step onboarding wizard with kernel capability detection
- Session persistence via file-backed store
- Configuration file (safeclaw.json) for model, prompt, tool rounds, gateway, sandbox settings
- Security audit CLI for inspecting skills, sessions, and tool executions
- CI/CD via GitHub Actions (lint, build, typecheck, test, release)
- Install script with vault preservation for upgrades

## Roadmap (v2)

Planned features in implementation order:

| # | Feature | Plan | Priority |
|---|---------|------|----------|
| 1 | Sandbox command execution & CWD permissions | [plan](docs/plans/2026-03-05-sandbox-permissions.md) | **Done** |
| 2 | Automatic context compaction | [plan](docs/plans/2026-03-05-context-compaction.md) | High |
| 3 | Streaming UX (Phase 1 — readline) | [plan](docs/plans/2026-03-05-streaming-ux.md) | High |
| 4 | Better CLI/TUI (Ink-based) | [plan](docs/plans/2026-03-05-tui.md) | High |
| 5 | Parallel agents | [plan](docs/plans/2026-03-05-parallel-agents.md) | Medium |
| 6 | Long-running background agents | [plan](docs/plans/2026-03-05-background-agents.md) | Medium |
| 7 | Superpowers skill integration | [plan](docs/plans/2026-03-05-superpowers-integration.md) | Medium |

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
- `@safeclaw/sandbox` — OS-level process sandboxing with `PolicyBuilder` for development-ready policies
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
