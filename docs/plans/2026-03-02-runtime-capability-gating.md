# Runtime Capability Gating in Agent Bootstrap — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the unconditional capability grants in `bootstrapAgent` with proper skill-manifest-based grants, so tools are only accessible when their skill's manifest declares and is granted the required capabilities.

**Architecture:** Currently `bootstrapAgent()` in `packages/cli/src/commands/bootstrap.ts` grants all 5 builtin capabilities (`fs:read`, `fs:write`, `process:spawn`, `net:https`, `env:read`) to a hardcoded `"agent"` skillId. The fix: register the builtin skill manifest (`skills/builtin/manifest.json`), grant capabilities based on what the manifest declares, and use the manifest's `id` as the skillId for tool executions. The agent loop already uses `skillId: "agent"` when calling `orchestrator.execute()` — this needs to match.

**Tech Stack:** TypeScript, vitest, @safeclaw/core (CapabilityRegistry, SkillLoader)

---

### Task 1: Load and register builtin manifest in bootstrapAgent

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts:1-57` (imports, constants)
- Modify: `packages/cli/src/commands/bootstrap.ts:120-146` (bootstrapAgent body)
- Test: `packages/cli/src/commands/bootstrap.test.ts`

**Step 1: Write the failing test**

Add a test that verifies the builtin skill manifest is registered in the capability registry:

```typescript
it("registers builtin skill manifest in capability registry", async () => {
  const result = await bootstrapAgent(createDeps());
  const skills = result.capabilityRegistry.listSkills();
  expect(skills).toHaveLength(1);
  expect(skills[0]!.id).toBe("builtin");
});
```

Note: This test depends on Task 1 of the wire-audit-command plan (exposing `capabilityRegistry` from `BootstrapResult`). If that hasn't been done yet, do it first.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: FAIL — no skills registered (current code doesn't call `registerSkill`)

**Step 3: Implement manifest loading**

In `bootstrapAgent()`, after creating the `capabilityRegistry`, load the builtin manifest:

```typescript
import { SkillLoader } from "@safeclaw/core";

// In bootstrapAgent():
const loader = new SkillLoader();
const manifestPath = new URL(
  "../../../../skills/builtin/manifest.json",
  import.meta.url,
);
const manifestJson = readFile(manifestPath.pathname, "utf8");
const manifest = loader.parse(manifestJson);
capabilityRegistry.registerSkill(manifest);
```

Then grant capabilities based on the manifest's declared requirements instead of the hardcoded list:

```typescript
for (const req of manifest.requiredCapabilities) {
  capabilityRegistry.grantCapability({
    skillId: manifest.id,
    capability: req.capability,
    grantedAt: new Date(),
    grantedBy: "builtin",
  });
}
```

Remove the hardcoded `BUILTIN_CAPABILITIES` array and the existing grant loop.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/commands/bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(cli): load builtin skill manifest in bootstrap
```

---

### Task 2: Align agent skillId with manifest id

**Files:**
- Modify: `packages/core/src/agent/agent.ts:84-88` (skillId in execute call)
- Modify: `packages/core/src/agent/types.ts` (add skillId to AgentConfig)
- Test: `packages/core/src/agent/agent.test.ts`

**Step 1: Write the failing test**

Add a test that verifies the agent uses a configurable `skillId` for tool calls:

```typescript
it("uses configured skillId for tool execution requests", async () => {
  // ... setup with a mock orchestrator that captures the skillId ...
  const config = { ...DEFAULT_AGENT_CONFIG, skillId: "builtin" };
  const agent = new Agent(config, mockClient, mockOrchestrator);
  // ... process message with tool call ...
  // Verify orchestrator.execute was called with skillId: "builtin"
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — `skillId` not in AgentConfig, agent uses hardcoded `"agent"`

**Step 3: Add skillId to AgentConfig**

In `agent/types.ts`:

```typescript
export interface AgentConfig {
  // ... existing fields ...
  skillId: string;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  // ... existing defaults ...
  skillId: "builtin",
};
```

In `agent/agent.ts` line 84-88, change:

```typescript
const result = await this.orchestrator.execute({
  skillId: this.config.skillId,
  toolName: toolCall.function.name,
  args,
});
```

**Step 4: Run all tests**

Run: `pnpm test`
Expected: All pass. Existing tests may need `skillId` added to their configs, or they rely on `DEFAULT_AGENT_CONFIG` which now includes it.

**Step 5: Commit**

```
feat(core): make agent skillId configurable via AgentConfig
```

---

### Task 3: Wire manifest skillId into bootstrap agent construction

**Files:**
- Modify: `packages/cli/src/commands/bootstrap.ts` (pass skillId to Agent)

**Step 1: Update agent construction**

```typescript
const agent = new Agent(
  { ...DEFAULT_AGENT_CONFIG, model, skillId: manifest.id },
  client,
  orchestrator,
);
```

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass

**Step 3: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: Clean

**Step 4: Commit**

```
feat(cli): use manifest skillId in agent construction
```
