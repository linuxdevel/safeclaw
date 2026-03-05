# Automatic Context Compaction

> SafeClaw v2 — Feature 3

## Problem

Every agent (main + future sub-agents) needs to automatically compact its session when approaching the model's token limit. Currently `ContextCompactor` exists but is optional. It should be mandatory so that agents never hit token limits and crash.

## Design Decisions

- **Compactor required**: every Agent instance must have a ContextCompactor. If not provided, a default is created.
- **Per-model token limits**: `ModelProvider` interface gains `maxContextTokens` property. Each provider returns the limit for its configured model.
- **Keep estimation**: 4 chars ≈ 1 token. The 80% threshold gives enough margin.
- **Sub-agents compact independently**: each gets its own compactor instance.

## Tasks

### Task 1: Add maxContextTokens to ModelProvider

**File**: `packages/core/src/providers/types.ts`

Add to `ModelProvider` interface:
```typescript
readonly maxContextTokens: number;
```

**Files**: `packages/core/src/providers/copilot.ts`, `openai.ts`, `anthropic.ts`

Each provider returns its model's context limit:
- Copilot: 128000 (default, can vary by model)
- OpenAI: 128000 (GPT-4o), configurable via constructor
- Anthropic: 200000 (Claude), configurable via constructor

**Tests**: Update existing provider tests to assert `maxContextTokens` is present and correct.

### Task 2: Make compactor required in Agent

**File**: `packages/core/src/agent/agent.ts`

Change `AgentConfig.compactor` from optional to required. If callers don't provide one, the Agent constructor creates a default `ContextCompactor` using the provider's `maxContextTokens`.

Update `AgentConfig`:
```typescript
interface AgentConfig {
  // ...existing fields...
  compactor?: ContextCompactor;  // still optional in config, but Agent ensures one exists
}
```

In the constructor:
```typescript
this.compactor = config.compactor ?? new ContextCompactor(this.provider, {
  maxTokens: this.provider.maxContextTokens,
  threshold: 0.8,
});
```

**Test**: `packages/core/src/agent/agent.test.ts`
- Agent creates default compactor when none provided
- Agent uses provided compactor when given
- Compaction triggers at 80% threshold

### Task 3: Update ContextCompactor to use provider limits

**File**: `packages/core/src/agent/compactor.ts`

Currently the compactor has hardcoded limits. Change it to read `maxContextTokens` from the provider (passed via constructor). Keep the 80% threshold as default but make it configurable.

**Test**: `packages/core/src/agent/compactor.test.ts`
- Uses provider's maxContextTokens
- shouldCompact returns true at 80% threshold
- shouldCompact returns false below threshold

### Task 4: Update bootstrap

**File**: `packages/cli/src/commands/bootstrap.ts`

Remove explicit compactor creation if Agent now handles it internally. Or keep explicit creation if custom threshold is desired.

### Task 5: Documentation

Update `AGENTS.md` and `docs/architecture.md` to document automatic compaction behavior.
