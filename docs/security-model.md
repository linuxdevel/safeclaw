# Security Model

SafeClaw is built on a zero-trust, defense-in-depth security architecture. Every component assumes that other components may be compromised and enforces its own security boundaries independently.

## Security philosophy

Two principles drive every design decision:

1. **Zero-trust**: No component trusts another without verification. Skills must be signed. Capabilities must be granted. Auth tokens must be validated. There is no "trusted" mode.
2. **Fail-closed defaults**: Security mechanisms cannot be disabled. The gateway refuses to start without a valid auth token. Unsigned skills are rejected by default. The default sandbox policy denies everything.

## Sandboxing architecture

SafeClaw uses three Linux kernel mechanisms for mandatory process isolation. Sandboxing cannot be disabled.

### Landlock

Landlock (kernel >= 5.13) restricts filesystem access at the kernel level. The sandbox policy specifies allowed and denied paths with access levels (`read`, `write`, `readwrite`, `execute`). Paths not explicitly allowed are inaccessible.

### seccomp-BPF

seccomp-BPF filters system calls. All policies use `defaultDeny: true` and allow only explicitly listed syscalls. Any syscall not in the allow list is blocked.

**DEFAULT_POLICY** allows a minimal set for basic process operation (~28 syscalls):

```
read, write, exit, exit_group, brk, mmap, close, fstat, mprotect,
munmap, rt_sigaction, rt_sigprocmask, ioctl, access, getpid, clone,
execve, wait4, uname, fcntl, getcwd, arch_prctl, set_tid_address,
set_robust_list, rseq, prlimit64, getrandom
```

**Development policy** (`PolicyBuilder.forDevelopment()`) expands this to ~120 syscalls organized by category:

- **Core I/O**: read, write, open, openat, close, lseek, pread64, pwrite64, readv, writev, sendfile
- **Memory**: mmap, mprotect, munmap, brk, mremap, madvise, msync
- **File metadata**: stat, fstat, lstat, newfstatat, fstatfs, statfs, statx
- **Directory**: getdents64, mkdir, rmdir, chdir, fchdir, getcwd
- **File operations**: rename, renameat2, unlink, unlinkat, link, linkat, symlink, symlinkat, readlink, readlinkat
- **File descriptors**: dup, dup2, dup3, fcntl, pipe, pipe2, eventfd2, epoll_create1, epoll_ctl, epoll_wait, epoll_pwait, select, pselect6, poll, ppoll
- **Permissions**: chmod, fchmod, fchmodat, chown, fchown, access, faccessat, faccessat2, umask
- **Process**: fork, vfork, clone, clone3, execve, execveat, wait4, waitid, exit, exit_group, getpid, getppid, gettid, getuid, getgid, geteuid, getegid, getgroups, setsid, setpgid, getpgid, getpgrp
- **Signals**: rt_sigaction, rt_sigprocmask, rt_sigreturn, kill, tgkill, rt_sigsuspend, sigaltstack
- **Time/clock**: clock_gettime, clock_getres, gettimeofday, nanosleep, clock_nanosleep, timer_create, timer_settime, timer_delete, timerfd_create, timerfd_settime, timerfd_gettime
- **Networking**: socket, connect, bind, listen, accept, accept4, recvfrom, sendto, recvmsg, sendmsg, shutdown, setsockopt, getsockopt, getpeername, getsockname, socketpair
- **Misc**: ioctl, prctl, arch_prctl, set_tid_address, set_robust_list, futex, sched_yield, sched_getaffinity, uname, prlimit64, getrandom, rseq, memfd_create, copy_file_range, fadvise64, fallocate, ftruncate, truncate, mlock, munlock, mincore

### Linux namespaces

Four namespace types isolate sandboxed processes:

| Namespace | Purpose |
|-----------|---------|
| PID | Process sees only its own PID tree |
| Network | No network access (or localhost-only) |
| Mount | Isolated filesystem view |
| User | Unprivileged user mapping |

### DEFAULT_POLICY

The default sandbox policy is maximally restrictive:

```typescript
const DEFAULT_POLICY: SandboxPolicy = {
  filesystem: { allow: [], deny: [] },        // no filesystem access
  syscalls: { allow: [...], defaultDeny: true }, // minimal syscalls only
  network: "none",                              // no network
  namespaces: { pid: true, net: true, mnt: true, user: true }, // all isolated
  timeoutMs: 30_000,                            // 30-second timeout
};
```

Skills that need filesystem or network access must declare capabilities, and those capabilities must be granted before the tool orchestrator will allow execution.

### Development policy (PolicyBuilder)

For practical software development, `PolicyBuilder.forDevelopment(cwd)` creates a policy that allows compilers, package managers, and standard dev tools to run while maintaining security:

```typescript
const policy = PolicyBuilder.forDevelopment(process.cwd());
const sandbox = new Sandbox(policy);
```

The development policy grants:
- **Execute access**: `/usr/bin`, `/usr/local/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/lib/jvm`, `/usr/lib/gcc`, `/usr/libexec`, plus the Node.js install prefix
- **Read access**: `/usr/include`, `/usr/share`, shared library paths (`/lib`, `/usr/lib`, `/lib64`, `/usr/lib64`), `/etc`, `/proc`, `/dev/null`, `/dev/urandom`, `/dev/zero`, `/dev/random`
- **Read-write access**: CWD, `/tmp`, `~/.safeclaw`
- **Extra paths**: `DevelopmentPolicyOptions` supports `extraExecutePaths` (e.g., `~/.cargo/bin`, `~/.rustup`) and `extraReadWritePaths` for user-local toolchains
- **Expanded syscalls**: ~120 syscalls (see seccomp-BPF section above)
- **Network**: `"none"` (unchanged from default)
- **Namespaces**: all enabled (PID, net, mount, user)

For a detailed explanation of enforcement layers, the helper binary architecture, policy format, and security guarantees, see [Sandboxing Deep Dive](sandboxing.md).

## Capability system

Skills declare the capabilities they need. The runtime enforces them.

### Capability types

| Capability | Controls |
|-----------|----------|
| `fs:read` | Reading files |
| `fs:write` | Writing files |
| `net:http` | HTTP network requests |
| `net:https` | HTTPS network requests |
| `process:spawn` | Spawning child processes |
| `env:read` | Reading environment variables |
| `secret:read` | Reading vault secrets |
| `secret:write` | Writing vault secrets |

### Declaration

Skills declare required capabilities in their manifest with optional constraints:

```json
{
  "requiredCapabilities": [
    {
      "capability": "fs:read",
      "constraints": { "paths": ["/home/user/projects"] },
      "reason": "Read project files for analysis"
    },
    {
      "capability": "net:https",
      "constraints": { "hosts": ["api.example.com"] },
      "reason": "Fetch data from API"
    }
  ]
}
```

### Constraints

Constraints narrow the scope of a capability:

| Constraint | Applies to | Effect |
|-----------|-----------|--------|
| `paths` | `fs:read`, `fs:write` | Only the listed path prefixes are accessible |
| `hosts` | `net:http`, `net:https` | Only the listed hostnames can be contacted |
| `executables` | `process:spawn` | Only the listed executables can be spawned |

Paths are checked with prefix matching: a grant for `/home/user/projects` allows access to `/home/user/projects/src/main.ts`.

### Enforcement

The `CapabilityEnforcer` checks capabilities at runtime, before every tool execution:

1. The tool orchestrator receives an execution request containing the skill ID and tool name.
2. The orchestrator looks up the tool handler and its required capabilities.
3. For each required capability, the enforcer checks whether a matching grant exists in the `CapabilityRegistry`.
4. If a grant exists and the context (path, host, executable) matches the grant's constraints, execution proceeds.
5. If any check fails, a `CapabilityDeniedError` is thrown and the tool execution is blocked.

There is no fallback. A missing or invalid grant always results in denial.

### Grants

Capabilities are granted through two mechanisms:

- **`builtin`**: Auto-approved when installing built-in skills (with `autoApprove: true`).
- **`user`**: Explicitly approved by the user during skill installation.

Grants are recorded with the skill ID, capability, constraints, timestamp, and granting authority. They can be revoked per-skill.

## Signed skills

Skills are signed with Ed25519 to ensure integrity and authenticity.

### Signing

The manifest is signed by:

1. Removing the `signature` field from the manifest.
2. Serializing the remaining fields as JSON with sorted keys (canonical form).
3. Signing the canonical JSON with the Ed25519 private key.
4. Encoding the signature as a hex string in the `signature` field.

```typescript
import { generateSigningKeyPair, signManifest } from "@safeclaw/core";

const { publicKey, privateKey } = generateSigningKeyPair();
// publicKey: hex-encoded 32-byte Ed25519 public key
// privateKey: hex-encoded PKCS#8 DER private key

const signature = signManifest(canonicalJson, privateKey);
// signature: hex-encoded Ed25519 signature
```

### Verification

On installation, the `SkillInstaller`:

1. Extracts the `signature` and `publicKey` from the manifest.
2. Reconstructs the canonical content (manifest without `signature`, keys sorted).
3. Verifies the Ed25519 signature against the public key.
4. Rejects the skill if the signature is invalid.

### Unsigned skill handling

Unsigned skills (no `signature` field) are rejected by default. To install an unsigned skill, pass the `--allow-unsigned` flag. This is intended for local development only and should not be used in production.

See [Skill Development](skill-development.md) for the complete signing workflow.

## Vault encryption

The vault stores secrets encrypted at rest. No plaintext secrets are ever written to disk.

### Encryption scheme

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **IV**: 12 bytes, randomly generated per entry
- **Auth tag**: 16 bytes (GCM authentication tag)
- **Key length**: 32 bytes (256 bits)

Each entry is stored as:

```json
{
  "ciphertext": "<base64>",
  "iv": "<base64>",
  "authTag": "<base64>"
}
```

GCM provides both confidentiality and integrity. Tampered ciphertext or auth tags cause decryption to fail.

### Key derivation

When using passphrase-based key management:

- **Algorithm**: scrypt
- **Parameters**: N=2^17 (131072), r=8, p=1
- **Key length**: 32 bytes
- **Salt**: 16 bytes, randomly generated, stored separately at `<vault-path>.salt`
- **Memory limit**: 256 MB

### Key storage

Two options:

1. **OS Keyring**: Key stored via `secret-tool` (GNOME Keyring / libsecret). The key is a random 32-byte value encoded as base64.
2. **Passphrase**: Key derived from user passphrase using scrypt. The salt is saved to disk with mode `0o600`.

### File permissions

The vault file is always written with mode `0o600` (owner read/write only). The vault refuses to open files with permissions more permissive than this (`assertFilePermissions` check).

## Gateway security

The HTTP gateway enforces authentication and rate limiting on all requests.

### Mandatory authentication

- The gateway constructor validates the auth token at startup. If the token is missing or shorter than 32 characters, the gateway throws an `AuthError` and refuses to start. There is no unauthenticated mode.
- Request tokens are compared using `crypto.timingSafeEqual` to prevent timing attacks.
- Only `POST /api/chat` requests are accepted. All other paths return 404.

### Rate limiting

Token bucket rate limiting is applied per client IP address:

- **Default**: 60 requests per 60-second window
- Requests exceeding the limit receive HTTP 429

### Fail-closed behavior

If no message handler is registered, the gateway returns HTTP 500 rather than silently discarding messages. Invalid request bodies return HTTP 400.

## Session isolation

Sessions are isolated by channel and peer identity. The `SessionManager` uses a composite key of `channelId:peerId` to look up sessions. A CLI user (`cli:local`) cannot access a WebChat user's session (`webchat:<peer-id>`), and vice versa.

Each session maintains its own conversation history (message array). Sessions are created on first contact and destroyed explicitly.

## STRIDE threat model

| Threat | Mitigation |
|--------|-----------|
| **Spoofing** | Auth tokens (>= 32 chars, timing-safe comparison), Ed25519 signed skill manifests |
| **Tampering** | AES-256-GCM authenticated encryption (vault), Ed25519 signatures (skills) |
| **Repudiation** | Audit log records every tool execution with timestamp, skill ID, tool name, result, and duration |
| **Information Disclosure** | Encrypted vault, `0o600` file permissions, session isolation, no plaintext secrets on disk |
| **Denial of Service** | Rate limiting (token bucket), sandbox timeouts (default 30s), seccomp syscall filtering |
| **Elevation of Privilege** | Capability enforcement (per-skill grants with constraints), sandbox namespaces (PID, net, mount, user), minimal syscall allowlist |

## Comparison with opt-in security

Many AI assistant frameworks treat security as optional:

| Aspect | Opt-in (typical) | SafeClaw (mandatory) |
|--------|------------------|---------------------|
| Sandboxing | Disabled by default, enable with flag | Always on, cannot be disabled |
| Skill signing | Not required | Required by default (`--allow-unsigned` for dev only) |
| Auth | Optional, can run without | Required, gateway refuses to start without token |
| Capabilities | Granted implicitly or not checked | Explicitly declared, enforced at every tool call |
| Secrets | Plaintext config files | AES-256-GCM encrypted vault with permission checks |
| Default policy | Allow-all | Deny-all (no fs, no network, minimal syscalls) |

The tradeoff is friction: SafeClaw requires more setup (onboarding wizard, signing keys, capability declarations). The benefit is that security failures require active circumvention rather than passive neglect.
