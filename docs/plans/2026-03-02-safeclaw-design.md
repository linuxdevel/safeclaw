# SafeClaw Design Document

**Date:** 2026-03-02
**Status:** Approved
**Product:** SafeClaw -- Secure Alternative to OpenClaw

## Overview

SafeClaw is a full-featured personal AI assistant that replaces OpenClaw with a
redesigned zero-trust security architecture. Where OpenClaw treats security as
opt-in configuration, SafeClaw makes it mandatory and structural.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Full OpenClaw replacement | All features, redesigned security model |
| Security model | Zero-trust architecture | Mandatory sandboxing, signed skills, encrypted secrets, capability-based access |
| Tech stack | TypeScript / Node.js | Same as OpenClaw for ecosystem familiarity |
| Sandboxing | OS-level (Landlock + seccomp-BPF + namespaces) | Strongest isolation without Docker overhead |
| Channels (v1) | CLI + WebChat via adapter pattern | Build the interface right, channels are pluggable |
| Skills trust | Signed manifests + capability approval | Ed25519 signatures + declared capabilities + user approval + runtime enforcement |
| Platform (v1) | Linux only | OS-level sandboxing requires Linux kernel features |
| Platform (future) | macOS, Windows | Docker fallback or platform-native sandboxing |
| OpenClaw compat | Future scanner tool | Analyzes, rewrites, and signs OpenClaw skills for SafeClaw |
| LLM provider | GitHub Copilot API only | Corporate agreement with Microsoft |
| Default model | Claude Opus 4.6 (via Copilot) | Best prompt injection resistance |

## Goals

- Full-featured personal AI assistant with zero-trust architecture
- Mandatory OS-level sandboxing for all tool execution (no opt-out)
- Signed capability manifests for skills/plugins
- Encrypted secrets at rest (AES-256-GCM)
- Channel adapter pattern (CLI + WebChat first)
- GitHub Copilot API as LLM provider

## Non-Goals

- Multi-tenant hostile isolation (personal assistant model)
- macOS/Windows native sandboxing in v1
- Mobile apps, Voice, Canvas in v1
- Backward-compatible config with OpenClaw
- Direct OpenClaw skill compatibility

## Architecture

```
                    +-----------------------------------+
                    |        SafeClaw Gateway            |
                    |  +-----------+ +--------------+    |
 CLI --------------+->| Auth      | | Capability   |    |
 WebChat -----------+>| (mandatory| | Registry     |    |
 [Adapters] --------+>| fail-     | | (signed      |    |
                    |  | closed)   | | manifests)   |    |
                    |  +-----+-----+ +------+-------+    |
                    |        |               |            |
                    |  +-----v---------------v---------+  |
                    |  |      Session Manager           |  |
                    |  |  (per-channel-peer default)     |  |
                    |  +-------------+------------------+  |
                    |               |                      |
                    |  +------------v------------------+   |
                    |  |      Agent Runtime            |   |
                    |  |  +------------------------+   |   |
                    |  |  |   Tool Orchestrator     |   |   |
                    |  |  |  +------------------+  |   |   |
                    |  |  |  | Capability       |  |   |   |
                    |  |  |  | Enforcer         |  |   |   |
                    |  |  |  +--------+---------+  |   |   |
                    |  |  +-----------+------------+   |   |
                    |  +--------------+----------------+   |
                    +-----------------+--------------------+
                                     |
                    +----------------v---------------------+
                    |       Sandbox Layer                   |
                    |  (MANDATORY - no bypass)              |
                    |  +----------+ +--------------+       |
                    |  | Landlock | | Seccomp-BPF  |       |
                    |  | (fs ACL) | | (syscall     |       |
                    |  |          | |  filter)     |       |
                    |  +----------+ +--------------+       |
                    |  +----------------------------+      |
                    |  | Linux Namespaces            |      |
                    |  | (PID, NET, MNT, USER)       |      |
                    |  +----------------------------+      |
                    +--------------------------------------+
                                     |
                    +----------------v---------------------+
                    |       Secrets Vault                   |
                    |  AES-256-GCM at rest                  |
                    |  Key: OS keyring or Argon2id          |
                    +--------------------------------------+
                                     |
                    +----------------v---------------------+
                    |    GitHub Copilot API Client          |
                    |  OAuth device flow auth               |
                    |  Model selection / failover           |
                    +--------------------------------------+
```

### Components

| Component | Package | Role |
|-----------|---------|------|
| Gateway | `@safeclaw/gateway` | WS + HTTP control plane. Mandatory auth (fail-closed). |
| Capability Registry | `@safeclaw/core` | Signed skill manifests. Capability grants. Ed25519 verification. |
| Session Manager | `@safeclaw/core` | Per-channel-peer isolation by default. |
| Agent Runtime | `@safeclaw/core` | LLM interaction via GitHub Copilot API. Tool calling. Streaming. |
| Tool Orchestrator | `@safeclaw/core` | Capability check -> sandbox -> execute -> return result. |
| Capability Enforcer | `@safeclaw/core` | Runtime policy engine. Rejects undeclared tool calls. |
| Sandbox Layer | `@safeclaw/sandbox` | Mandatory OS-level isolation. Landlock + seccomp-BPF + namespaces. |
| Secrets Vault | `@safeclaw/vault` | Encrypted credential store. Never writes plaintext to disk. |
| Copilot API Client | `@safeclaw/core` | GitHub device flow OAuth. Model selection. Failover. |
| CLI Channel | `@safeclaw/cli` | Interactive terminal + commands. |
| WebChat Channel | `@safeclaw/webchat` | Browser SPA served from gateway. |

### Key Interfaces

```typescript
// Channel adapter -- pluggable messaging surface
interface ChannelAdapter {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(target: PeerIdentity, content: OutboundMessage): Promise<void>;
}

// Skill manifest -- signed capability declaration
interface SkillManifest {
  id: string;
  version: string;
  signature: string;        // Ed25519 over manifest content
  publicKey: string;         // signing key fingerprint
  requiredCapabilities: Capability[];
  tools: ToolDefinition[];
}

// Capability grant -- runtime permission record
interface CapabilityGrant {
  skillId: string;
  capability: Capability;
  grantedAt: Date;
  constraints?: CapabilityConstraints;
}

// Sandbox policy -- per-execution isolation config
interface SandboxPolicy {
  filesystem: { allow: PathRule[]; deny: PathRule[] };
  syscalls: { allow: string[]; defaultDeny: true };
  network: 'none' | 'localhost' | 'filtered';
  namespaces: { pid: true; net: true; mnt: true; user: true };
}
```

## Threat Model

### Assets

| Asset | Classification | Description |
|-------|---------------|-------------|
| GitHub Copilot OAuth tokens | Critical | LLM API authentication |
| Channel credentials | Critical | Future channel tokens |
| Session transcripts | Sensitive | Conversation history, PII |
| Skill code + manifests | Trusted Code | Executable skills/plugins |
| Gateway config | Sensitive | Auth tokens, policies |
| Host filesystem | Critical | User's disk |
| Network access | Critical | Data exfiltration vector |
| Signing keys | Critical | Ed25519 keys for skill signing |

### Trust Boundaries

```
+---------------------------------------------------+
| TB1: External Network (untrusted)                 |
|  +---------------------------------------------+ |
|  | TB2: Channel Messages (untrusted input)      | |
|  |  +-----------------------------------------+ | |
|  |  | TB3: Gateway Process (trusted)          | | |
|  |  |  +-----------------------------------+ | | |
|  |  |  | TB4: Agent Runtime (semi-trusted)  | | | |
|  |  |  |  +-----------------------------+  | | | |
|  |  |  |  | TB5: Tool Sandbox            |  | | | |
|  |  |  |  | (untrusted execution)        |  | | | |
|  |  |  |  +-----------------------------+  | | | |
|  |  |  +-----------------------------------+ | | |
|  |  +-----------------------------------------+ | |
|  +---------------------------------------------+ |
+---------------------------------------------------+
```

### STRIDE Analysis

#### T-001: Prompt Injection via Channel Messages
- **STRIDE:** Elevation of Privilege
- **Impact:** Critical
- **Mitigations:** Mandatory sandboxing; capability enforcer blocks undeclared tools; default network = none; injection-resistant content wrapping

#### T-002: Malicious Skill Installation
- **STRIDE:** Tampering + Elevation of Privilege
- **Impact:** Critical
- **Mitigations:** Ed25519 signatures required; capability manifest approval; skills in sandbox (not in-process); --allow-unsigned flag required for unsigned

#### T-003: Credential Theft from Disk
- **STRIDE:** Information Disclosure
- **Impact:** Critical
- **Mitigations:** AES-256-GCM at rest; key from OS keyring or Argon2id; per-session keys; refuse to start on wrong permissions

#### T-004: Gateway API Abuse
- **STRIDE:** Spoofing + Elevation of Privilege
- **Impact:** High
- **Mitigations:** Auth mandatory (fail-closed); min token length 32; rate limiting; config changes require re-auth

#### T-005: Sandbox Escape
- **STRIDE:** Elevation of Privilege
- **Impact:** Critical
- **Mitigations:** Defense in depth (3 layers); unprivileged user namespace; no dangerous caps; kernel version checks

#### T-006: Data Exfiltration via Tools
- **STRIDE:** Information Disclosure
- **Impact:** High
- **Mitigations:** Default network = none; capability declaration required; DNS allowlist; outbound logging

#### T-007: Supply Chain Attack on Skills
- **STRIDE:** Tampering
- **Impact:** High
- **Mitigations:** Signature verification against pinned keys; no auto-install; future scanner for OpenClaw skills

### STRIDE Summary

| Category | Threats | Mitigated |
|----------|---------|-----------|
| Spoofing | 1 | 1 |
| Tampering | 2 | 2 |
| Repudiation | 0 | 0 |
| Information Disclosure | 2 | 2 |
| Denial of Service | 0 | 0 |
| Elevation of Privilege | 3 | 3 |

## Security Differences from OpenClaw

| Concern | OpenClaw | SafeClaw |
|---------|----------|----------|
| Sandboxing | Opt-in Docker, off by default | Mandatory OS-level, always on |
| Auth | Configurable, `none` allowed | Mandatory, fail-closed, no `none` |
| Skills/Plugins | Trusted code, no verification | Signed manifests + capability approval |
| Secrets on disk | Plaintext in ~/.openclaw/ | AES-256-GCM encrypted, key in OS keyring |
| Session isolation | main session shared by default | Per-channel-peer by default |
| Tool permissions | Allow/deny lists in config | Capability-based, declared in manifests |
| Network for tools | Host network by default | No network by default, allowlist-gated |
| Config security | Misconfiguration = full compromise | Secure defaults, refuse insecure configs |
| File permissions | Checked but not enforced | Enforced at startup (refuse to start) |

## Package Structure

```
safeclaw/
  packages/
    core/           # Agent runtime, sessions, capabilities, tools, Copilot client
    sandbox/        # Landlock, seccomp-BPF, namespace wrappers
    vault/          # Encrypted secrets storage
    gateway/        # WS + HTTP server, auth, rate limiting
    cli/            # CLI channel + commands
    webchat/        # WebChat SPA + adapter
  skills/
    builtin/        # Built-in tools (read, write, edit, bash, web_fetch)
  docs/
    plans/          # Design docs and implementation plans
  test/
    unit/
    integration/
    e2e/
    security/       # Sandbox escape, auth bypass tests
  package.json
  pnpm-workspace.yaml
  tsconfig.json
  vitest.config.ts
  LICENSE
```
