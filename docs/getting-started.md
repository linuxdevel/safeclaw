# Getting Started

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 9.0.0
- **Linux** with kernel >= 5.13 (required for Landlock, seccomp-BPF, and namespaces)
- **GNOME Keyring** (`secret-tool`) if using OS keyring for vault encryption (optional; passphrase fallback available)
- A **GitHub account** with Copilot access (for default Copilot provider), or an **OpenAI** or **Anthropic** API key

### Verifying kernel support

SafeClaw requires mandatory sandboxing. Check that your kernel supports the necessary features:

```bash
# Kernel version (must be >= 5.13)
uname -r

# Seccomp support
grep Seccomp /proc/self/status

# Namespace support
ls /proc/self/ns/{user,pid,net,mnt}
```

All four namespaces (user, PID, net, mount) must be available. If any are missing, SafeClaw will warn during onboarding and sandbox isolation will be limited.

## Installation

```bash
git clone https://github.com/user/safeclaw.git
cd safeclaw
pnpm install
pnpm build
```

## First run: onboarding wizard

On first run, SafeClaw walks you through a six-step onboarding wizard.

```bash
safeclaw onboard
```

### Step 1: Check kernel capabilities

The wizard detects Landlock, seccomp, and namespace support. Output looks like:

```
=== Step 1: Kernel Capabilities ===

  Landlock:    supported (ABI v3)
  Seccomp:     supported
  Namespaces:  user=yes pid=yes net=yes mnt=yes

  All kernel features available.
```

If any features are unavailable, a warning is printed. SafeClaw continues but sandbox isolation may be limited.

### Step 2: Authenticate with GitHub Copilot

SafeClaw uses GitHub's device flow OAuth to authenticate:

1. The wizard displays a URL and a one-time code.
2. Open the URL in your browser and enter the code.
3. Authorize the application on GitHub.
4. The wizard polls until authorization completes.

```
=== Step 2: GitHub Copilot Authentication ===

Authenticate with GitHub Copilot now? (y/n): y

  Open: https://github.com/login/device
  Enter code: ABCD-1234

  Waiting for authorization...
  Authenticated successfully.
```

The OAuth token is stored in the encrypted vault (created in the next step). You can skip this step and authenticate later.

### Step 3: Create vault

The vault stores secrets encrypted at rest using AES-256-GCM. You choose how the encryption key is managed:

1. **OS Keyring** (recommended) -- a random 256-bit key is generated and stored in GNOME Keyring via `secret-tool`. If the keyring is unavailable, the wizard falls back to passphrase.
2. **Passphrase** -- you enter a passphrase (minimum 8 characters). A key is derived using scrypt (N=2^17, r=8, p=1). The salt is saved to `<vault-path>.salt`.

```
=== Step 3: Create Vault ===

  Choose key source:
  1) OS Keyring
  2) Passphrase

Select (1 or 2): 1
  Vault created with OS keyring.
```

The vault file is written with mode `0o600` (owner read/write only). See [Security Model](security-model.md) for details on vault encryption.

### Step 4: Generate Ed25519 signing key pair

An Ed25519 key pair is generated for signing skill manifests. The private key is stored in the vault. The public key is printed so you can share it with skill consumers.

```
=== Step 4: Generate Signing Key Pair ===

  Public key: a1b2c3d4...
  Private key stored in vault.
```

See [Skill Development](skill-development.md) for how to use the key pair to sign skills.

### Step 5: Select default model

Choose which LLM model to use by default. Available models:

| # | Model | Notes |
|---|-------|-------|
| 1 | `claude-sonnet-4` | Default |
| 2 | `claude-opus-4` | |
| 3 | `gpt-4.1` | |
| 4 | `gemini-2.5-pro` | |
| 5 | `o4-mini` | |

```
=== Step 5: Select Default Model ===

  1) claude-sonnet-4 (default)
  2) claude-opus-4
  3) gpt-4.1
  4) gemini-2.5-pro
  5) o4-mini

Select model (1-5) [1]: 1
  Selected: claude-sonnet-4
```

The selection is saved in the vault.

### Step 6: Configure Model Providers (Optional)

Optionally provide API keys for alternative LLM providers:

```
=== Step 6: Configure Model Providers (Optional) ===

  Press Enter to skip any provider you don't want to configure.

OpenAI API key (Enter to skip):
Anthropic API key (Enter to skip):
```

If you provide one or more API keys, you'll be prompted to select a default provider. API keys are stored encrypted in the vault using AES-256-GCM.

## Starting the CLI

```bash
safeclaw chat
```

This starts an interactive chat session. Type your message and press Enter. The agent processes your message through the LLM, executes any tool calls, and prints the response. Empty lines are ignored.

The prompt is `> `. Type your message after the prompt:

```
> What files are in the current directory?
```

The agent has access to built-in tools: `read`, `write`, `edit`, `bash`, `web_fetch`, and `process`. If a `brave_api_key` is stored in the vault, the `web_search` tool is also available. The `process` tool manages background processes (start, status, log, kill, list) with automatic cleanup after 1 hour and a maximum of 8 concurrent processes. Each tool requires specific capabilities that are checked at runtime. See [Architecture](architecture.md) for the request flow.

## Starting the WebChat UI

SafeClaw also provides a web-based chat interface. The WebChat adapter starts an HTTP server that serves a single-page application:

```bash
safeclaw webchat
```

The server binds to `127.0.0.1` by default. Open the displayed URL in your browser to start chatting. The SPA communicates with the agent through the same gateway that the CLI uses.

Security headers are set on all static file responses:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'`

## Audit command

View the current security state of SafeClaw:

```bash
safeclaw audit
safeclaw audit --format json
```

The audit report shows:
- Installed skills and their granted capabilities
- Active sessions
- Recent tool executions (success/failure, duration, sandboxed status)

## Configuration overview

SafeClaw stores configuration and secrets in the encrypted vault. Key vault entries:

| Entry | Description |
|-------|-------------|
| `github_token` | GitHub OAuth access token |
| `signing_private_key` | Ed25519 private key for signing manifests |
| `default_model` | Selected default LLM model |
| `provider` | Default LLM provider (`copilot`, `openai`, or `anthropic`) |
| `openai_api_key` | OpenAI API key (optional) |
| `anthropic_api_key` | Anthropic API key (optional) |
| `brave_api_key` | Brave Search API key for web\_search tool (optional) |

The gateway binds to `127.0.0.1:18789` by default with a rate limit of 60 requests per 60-second window. The auth token must be at least 32 characters. See [Security Model](security-model.md) for details.
