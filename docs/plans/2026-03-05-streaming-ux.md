# Streaming UX (Phase 1 — readline)

> SafeClaw v2 — Feature 4

## Problem

When the user sends a prompt, the CLI goes silent until the full response arrives. No indication of whether the agent is thinking, running tools, or stuck. This makes SafeClaw feel broken.

## Design Decisions

- **Two-phase approach**: Phase 1 improves the current readline CLI. Phase 2 (Feature 5, TUI) gets the full visual treatment.
- **No dependencies**: ANSI escape codes only — no chalk, no ora. Keeps the zero-dependency philosophy for now.
- **Always stream**: Switch default chat path to streaming. Non-streaming path remains for programmatic use.

## Tasks

### Task 1: ANSI formatting helpers

**File**: `packages/cli/src/formatting.ts`

Create utility functions:
```typescript
// Colors
export function cyan(text: string): string;
export function red(text: string): string;
export function dim(text: string): string;
export function bold(text: string): string;
export function green(text: string): string;
export function yellow(text: string): string;
export function reset(text: string): string;

// Spinner
export class Spinner {
  constructor(stream: NodeJS.WritableStream);
  start(message: string): void;
  stop(): void;
  update(message: string): void;
}
```

Spinner uses braille characters (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), updates every 80ms, writes to the stream with `\r` to overwrite the current line. `stop()` clears the spinner line.

Color functions should detect `NO_COLOR` env var and `stream.isTTY` to disable colors when appropriate.

**Test**: `packages/cli/src/formatting.test.ts`
- Color functions wrap text in correct ANSI codes
- Colors disabled when NO_COLOR is set
- Spinner start/stop/update lifecycle

### Task 2: Streaming chat integration

**File**: `packages/cli/src/adapter.ts`

Modify the `CliAdapter` to:
1. Show spinner with "Thinking..." immediately when message is sent
2. On first `text_delta` event: stop spinner, start printing tokens
3. On `tool_start` event: print `→ Running: toolName(args summary)` in cyan
4. On `tool_result` event: print `✓ toolName completed (duration)` in green, or `✗ toolName failed` in red
5. On `error` event: print error in red
6. On `done` event: print newline, re-show prompt

Use the streaming handler path (`onStreamMessage`) which already exists.

**Test**: `packages/cli/src/adapter.test.ts`
- Spinner starts on message send
- Spinner stops on first text delta
- Tool start/result printed with correct formatting
- Error events printed in red

### Task 3: Switch chat to streaming by default

**File**: `packages/cli/src/commands/chat.ts` (or wherever `setupChat` wires things)

Ensure the chat command always uses `processMessageStream` rather than `processMessage`. The non-streaming path remains available for programmatic API use but is not the default CLI experience.

**Test**: Verify streaming is the default code path.

### Task 4: Documentation

Update `docs/getting-started.md` to mention streaming output and tool progress indicators.
