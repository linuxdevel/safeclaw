# SafeClaw

A security-first personal AI assistant with zero-trust architecture.

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
- [Skill Development](docs/skill-development.md)
- [Architecture](docs/architecture.md)

## License

ISC
