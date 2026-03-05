# Superpowers Skill Integration

> SafeClaw v2 — Feature 8 (independent, but benefits from Features 6+7)

## Problem

The [superpowers](https://github.com/obra/superpowers) repo contains valuable skill files for development workflows (brainstorming, TDD, debugging, code review, etc.). SafeClaw should integrate with this ecosystem while maintaining its zero-trust security model.

## Superpowers Repository Structure

```
superpowers/
├── .opencode/plugins/superpowers.js    # OpenCode plugin (system prompt hook)
├── .claude-plugin/plugin.json          # Claude Code plugin metadata
├── .cursor-plugin/                     # Cursor plugin config
├── .codex/                             # Codex plugin config
├── skills/                             # Skill files (SKILL.md with YAML frontmatter)
│   ├── using-superpowers/SKILL.md      # Bootstrap skill (injected into system prompt)
│   ├── brainstorming/SKILL.md
│   ├── test-driven-development/SKILL.md
│   ├── systematic-debugging/SKILL.md
│   └── ... (15+ skills)
├── agents/                             # Agent profile definitions
├── commands/                           # Custom slash commands (JS/Shell)
├── hooks/                              # Lifecycle hooks
└── lib/                                # Shared utilities (JS)
```

Each skill is a `SKILL.md` file with YAML frontmatter (`name`, `description`) and markdown body containing instructions. Skills are pure text, not executable code. The OpenCode plugin uses `experimental.chat.system.transform` to inject the `using-superpowers` bootstrap into every system prompt, plus tool mapping instructions.

## Design Decisions

- **Clone + security scan + prompt injection**: skills are loaded as prompt text, not capability-granting manifests.
- **Security scan**: defense-in-depth against prompt injection. Skills are text, not code, but we still scan.
- **Platform-specific dirs ignored**: `.opencode/`, `.claude-plugin/`, `.cursor-plugin/`, `.codex/` are not loaded.
- **Executable code not loaded**: `lib/`, `commands/` contain JS/Shell — SafeClaw does not execute them.
- **Skill priority**: project > personal > superpowers > builtin (matches OpenCode's model).

## Tasks

### Task 1: Skill security scanner

**File**: `packages/core/src/skills/scanner.ts`

```typescript
interface ScanResult {
  file: string;
  status: "pass" | "warn" | "fail";
  issues: ScanIssue[];
}

interface ScanIssue {
  severity: "warn" | "fail";
  line: number;
  description: string;
  pattern: string;
}

class SkillScanner {
  scan(content: string, filePath: string): ScanResult;
  scanDirectory(dirPath: string): Promise<ScanResult[]>;
}
```

Patterns to detect:
- **Prompt injection (fail)**: "ignore previous instructions", "ignore system prompt", "you are now", "your new instructions are", "disregard all prior"
- **Capability escalation (fail)**: "you have permission to", "you are allowed to", "grant yourself", "bypass security", "disable sandbox"
- **Data exfiltration (warn)**: "send to URL", "encode and output", "base64 encode", "curl", "wget", "fetch("
- **Path traversal (warn)**: references to `../../`, `/etc/shadow`, `/etc/passwd` (as targets, not examples), absolute paths outside CWD and ~/.safeclaw/
- **Code execution (warn)**: `eval(`, `exec(`, `Function(`, `import(` in code blocks

Files that `fail` are quarantined (not loaded). Files with `warn` require user confirmation during install.

**Test**: `packages/core/src/skills/scanner.test.ts`
- Detects prompt injection patterns → fail
- Detects capability escalation → fail
- Detects data exfiltration patterns → warn
- Clean skill files → pass
- Multiple issues in one file
- Frontmatter-only files → pass

### Task 2: SKILL.md loader (frontmatter + markdown)

**File**: `packages/core/src/skills/loader.ts` (modify existing)

Add support for loading SKILL.md format:
```typescript
interface SkillContent {
  name: string;
  description: string;
  content: string;   // markdown body (frontmatter stripped)
  filePath: string;
}

class SkillLoader {
  // existing methods...
  loadSkillMd(filePath: string): Promise<SkillContent>;
  listSkills(directory: string): Promise<Array<{ name: string; description: string }>>;
}
```

Parse YAML frontmatter (simple key: value parsing, no dependency needed — same approach as superpowers plugin). Strip frontmatter, return markdown body.

**Test**: Update `packages/core/src/skills/loader.test.ts`
- Parses name and description from frontmatter
- Strips frontmatter from content
- Handles files without frontmatter
- Lists skills from directory

### Task 3: Skill registry (file-based)

**File**: `packages/core/src/skills/skill-registry.ts`

```typescript
interface SkillRegistryEntry {
  name: string;
  source: string;           // "superpowers", "personal", "project"
  directory: string;
  scanResult: "pass" | "warn";
  contentHash: string;
  installedAt: string;
}

class SkillRegistry {
  constructor(registryPath: string);  // ~/.safeclaw/skills/registry.json

  register(entry: SkillRegistryEntry): Promise<void>;
  unregister(name: string): Promise<void>;
  list(): Promise<SkillRegistryEntry[]>;
  get(name: string): Promise<SkillRegistryEntry | undefined>;
  save(): Promise<void>;
  load(): Promise<void>;
}
```

**Test**: `packages/core/src/skills/skill-registry.test.ts`

### Task 4: load_skill builtin tool

**File**: `packages/core/src/tools/builtin/load-skill.ts`

```typescript
{
  name: "load_skill",
  description: "Load a skill's instructions into the current session or list available skills",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["load", "list"], description: "Action to perform" },
      name: { type: "string", description: "Skill name to load (for action: load)" }
    },
    required: ["action"]
  },
  requiredCapabilities: ["fs:read"],
  execute: async (args) => {
    // action: "list" → return skill names + descriptions
    // action: "load" → read SKILL.md, strip frontmatter, return content
    //                   (agent injects into its own context)
  }
}
```

**Test**: `packages/core/src/tools/builtin/load-skill.test.ts`

### Task 5: /skills slash commands

**File**: `packages/cli/src/commands/chat-commands.ts`

Add `/skills` command handler:
- `/skills install superpowers` — git clone, scan, register
- `/skills update superpowers` — git pull, re-scan changed files
- `/skills uninstall superpowers` — remove directory + deregister
- `/skills list` — show installed skill sets and individual skills
- `/skills scan <path>` — manually scan a skill directory

The install command:
1. `git clone https://github.com/obra/superpowers ~/.safeclaw/skills/superpowers/`
2. Run `SkillScanner.scanDirectory()` on `skills/` subdirectory only
3. Show scan results to user
4. If any files fail, warn and quarantine
5. If any files warn, ask for confirmation
6. Register in SkillRegistry

**Test**: `packages/cli/src/commands/chat-commands.test.ts` — add /skills tests

### Task 6: Bootstrap skill injection

**File**: `packages/core/src/agent/agent.ts`

On agent startup, if superpowers is installed:
1. Load `using-superpowers/SKILL.md`
2. Append to system prompt with SafeClaw-specific tool mapping:
   - `TodoWrite` → session-level task tracking
   - `Task` with subagents → `spawn_agent` tool
   - `Skill` tool → `load_skill` tool
   - File operations → builtin read, write, edit tools

The injection mirrors what the OpenCode plugin does via `experimental.chat.system.transform`.

### Task 7: Skill priority resolution

**File**: `packages/core/src/skills/loader.ts` (extend)

When loading a skill by name, search in priority order:
1. Project skills: `.safeclaw/skills/` in CWD
2. Personal skills: `~/.safeclaw/skills/custom/`
3. Superpowers skills: `~/.safeclaw/skills/superpowers/skills/`
4. Builtin skills: `skills/builtin/`

First match wins.

### Task 8: Register load_skill tool

**Files**:
- `packages/core/src/tools/builtin/index.ts` — add load_skill
- `packages/core/src/tools/index.ts` — barrel exports
- `skills/builtin/manifest.json` — add capability declarations
- `packages/core/src/tools/builtin/index.test.ts` — update tool count

### Task 9: Documentation

Update AGENTS.md, README.md, docs/architecture.md, docs/getting-started.md with skill integration information.
