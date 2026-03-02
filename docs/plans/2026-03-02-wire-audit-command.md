# Wire Audit CLI Command — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the existing `runAudit()` function to the `safeclaw audit` CLI command so it reports real state from a running instance.

**Architecture:** The `runAudit()` function in `commands/audit.ts` is fully implemented and tested (8 tests). The problem is `cli.ts` has a placeholder `runAuditCommand()` that prints a static message. The fix has two parts: (1) for standalone `safeclaw audit`, bootstrap the agent stack and run audit against it, and (2) make `bootstrapAgent` return the registry, auditLog, and sessionManager so audit can inspect them.

**Tech Stack:** TypeScript, vitest, @safeclaw/core (CapabilityRegistry, SessionManager, AuditLog)

---

### Task 1: Expose audit dependencies from bootstrapAgent

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:46-49` (BootstrapResult interface)
- Modify: `packages/cli/src/commands/bootstrap.ts:120-146` (bootstrapAgent return)
- Modify: `packages/cli/src/commands/bootstrap.test.ts` (update assertions)

**Step 1: Write the failing test**

Add a test to `bootstrap.test.ts` that asserts the bootstrap result includes `capabilityRegistry`, `auditLog`, and `sessionManager`:

```typescript
it("returns capabilityRegistry, auditLog, and sessionManager", async () => {
  const result = await bootstrapAgent(createDeps());
  expect(result.capabilityRegistry).toBeInstanceOf(CapabilityRegistry);
  expect(result.auditLog).toBeInstanceOf(AuditLog);
  expect(result.sessionManager).toBeInstanceOf(SessionManager);
});
```

Import `CapabilityRegistry` and `AuditLog` from `@safeclaw/core` in the test file.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: FAIL — `result.capabilityRegistry` is undefined

**Step 3: Update BootstrapResult and bootstrapAgent**

In `bootstrap.ts`, expand `BootstrapResult`:

```typescript
export interface BootstrapResult {
  agent: Agent;
  sessionManager: SessionManager;
  capabilityRegistry: CapabilityRegistry;
  auditLog: AuditLog;
}
```

Import `AuditLog` from `@safeclaw/core`.

In `bootstrapAgent()`, create the `AuditLog` instance and return all four:

```typescript
const auditLog = new AuditLog();
const orchestrator = new ToolOrchestrator(enforcer, toolRegistry);
// ... agent construction unchanged ...

return { agent, sessionManager, capabilityRegistry, auditLog };
```

Where `capabilityRegistry` is the existing local variable (currently named `capabilityRegistry` at line 121).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(cli): expose audit dependencies from bootstrapAgent
```

---

### Task 2: Wire runAudit into cli.ts audit command

**Files:**
- Modify: `packages/cli/src/cli.ts:1-14` (imports)
- Modify: `packages/cli/src/cli.ts:85-98` (replace runAuditCommand)
- Modify: `packages/cli/src/cli.ts:177-180` (switch case)

**Step 1: Replace the stub runAuditCommand**

Delete the `runAuditCommand` function (lines 85-98) and replace with:

```typescript
import { runAudit } from "./commands/audit.js";

async function runAuditCommand(jsonFlag: boolean): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { capabilityRegistry, sessionManager, auditLog } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  runAudit({
    output: process.stdout,
    registry: capabilityRegistry,
    sessionManager,
    auditLog,
    format: jsonFlag ? "json" : "text",
  });
}
```

**Step 2: Update the switch case**

Change the audit case from sync to async:

```typescript
case "audit": {
  const jsonFlag = args.includes("--json");
  await runAuditCommand(jsonFlag);
  break;
}
```

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All 345+ tests pass

**Step 4: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: Clean

**Step 5: Commit**

```
feat(cli): wire runAudit into safeclaw audit command
```

---

### Task 3: Verify end-to-end (manual)

**Step 1:** Run `safeclaw audit` — should now bootstrap, open vault, and print the audit report (skills, sessions, executions).

**Step 2:** Run `safeclaw audit --json` — should output valid JSON.

**Step 3:** If vault doesn't exist, should print the "Run 'safeclaw onboard'" error (same as `safeclaw chat`).
