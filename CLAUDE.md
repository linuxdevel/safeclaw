# SafeClaw -- Claude Code / Copilot Instructions

> This file provides coding conventions and quick-reference for AI assistants working on this codebase.

## Quick Commands

```bash
pnpm build        # Build all packages (tsc --build)
pnpm test         # Run all tests (vitest run)
pnpm lint         # Lint (oxlint)
pnpm typecheck    # Type-check only (tsc --build --dry)
make -C native    # Build native C helper (requires musl-tools)
```

## Code Style Rules

### TypeScript
- **Strict mode**: All strict flags enabled, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- **ESM only**: Use `import type` for type-only imports. No CommonJS.
- **Target**: ES2024. Module resolution: Node16.
- **No `any`**: Use `unknown` and narrow with type guards.
- **No `==`**: Always use `===` (enforced by oxlint `eqeqeq: error`).
- **No `console.log`**: Use structured logging or remove before commit (oxlint `no-console: warn`).
- **Zero lint diagnostics**: All lint errors and warnings must be fixed before considering work complete. The GitHub CI workflow runs `pnpm lint` and will fail the build on any lint diagnostic. Never leave lint warnings as "pre-existing" or "to be ignored" -- fix them immediately.

### File Organization
- Source in `packages/<name>/src/`
- Tests co-located as `*.test.ts` next to source files
- Each package has `src/index.ts` barrel file exporting public API
- Types in `types.ts` per module directory

### Naming
- **Files**: kebab-case (`tool-registry.ts`, `rate-limit.ts`)
- **Types/Interfaces**: PascalCase (`CapabilityEnforcer`, `SandboxPolicy`)
- **Functions/Variables**: camelCase (`validateAuthToken`, `findHelper`)
- **Constants**: camelCase or UPPER_SNAKE for true constants
- **Error classes**: `<Domain>Error` (`AuthError`, `PermissionError`, `VaultError`)

### Patterns
- **Dependency injection**: Pass dependencies via constructor options or function parameters. No global state.
- **Fail-closed**: Default to denying access. Security checks must explicitly allow.
- **Custom error classes**: Each domain has its own error class extending `Error`.
- **No database**: All runtime state is in-memory. Only the vault persists to disk.

## Commit Messages

Use Conventional Commits format:

```
type(scope): description

# Types: feat, fix, test, docs, refactor, chore, ci
# Scopes: core, cli, sandbox, vault, native, gateway, webchat, security, skills, tools, ci
```

Examples:
- `feat(core): add streaming support to agent loop`
- `fix(sandbox): handle ENOENT for missing helper binary`
- `test(security): add crypto key rotation test`

## Adding a New Tool

1. Create `packages/core/src/tools/builtin/<name>.ts`
2. Implement the `ToolHandler` interface (from `packages/core/src/tools/types.ts`)
3. Declare `requiredCapabilities` on the handler
4. Register in `packages/core/src/tools/builtin/index.ts`
5. Add capability grants to `skills/builtin/manifest.json`
6. Write co-located test `<name>.test.ts`

## Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`
2. Add to `pnpm-workspace.yaml` (already uses `packages/*` glob)
3. Add project reference in root `tsconfig.json`
4. Package `tsconfig.json` should extend `../../tsconfig.build.json`

## Security Invariants (Never Violate)

- Tool calls MUST pass through `CapabilityEnforcer` before execution
- Sandbox execution MUST NOT be optional or bypassable by tool code
- Vault file permissions MUST be 0o600
- Auth tokens MUST use timing-safe comparison (`timingSafeEqual`)
- Skill manifests MUST have valid Ed25519 signatures before loading
- Rate limiting MUST NOT be removable without code changes
- `PR_SET_NO_NEW_PRIVS` MUST be set before any sandbox enforcement

## Package API Surface

| Package | Key Exports |
|---------|-------------|
| `@safeclaw/vault` | `Vault`, `encrypt`, `decrypt`, `deriveKeyFromPassphrase`, `KeyringProvider` |
| `@safeclaw/sandbox` | `Sandbox`, `detectKernelCapabilities`, `findHelper` |
| `@safeclaw/core` | `Agent`, `CapabilityRegistry`, `CapabilityEnforcer`, `ToolOrchestrator`, `SimpleToolRegistry`, `AuditLog`, `Session`, `SessionManager`, `CopilotClient`, `SkillLoader`, `SkillInstaller` |
| `@safeclaw/gateway` | `Gateway`, `validateAuthToken`, `RateLimiter` |
| `@safeclaw/webchat` | `WebChatAdapter` |
| `@safeclaw/cli` | `CliAdapter`, `bootstrapAgent`, CLI commands |
