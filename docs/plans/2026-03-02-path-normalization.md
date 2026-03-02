# Path Normalization in Capability Enforcer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent path traversal attacks (e.g. `/tmp/../etc/passwd`) in capability enforcement by normalizing paths before constraint checking.

**Architecture:** The `CapabilityEnforcer.checkConstraints()` method in `packages/core/src/capabilities/enforcer.ts` uses raw `startsWith` for path matching. This allows `/tmp/../etc/passwd` to pass a `/tmp/` constraint. Fix by resolving paths with `path.resolve()` before comparison, and also resolving constraint paths at check time to handle relative constraint definitions. Both the context path and constraint paths must be normalized.

**Tech Stack:** TypeScript, vitest, node:path

---

### Task 1: Write failing tests for path traversal prevention

**Files:**
- Modify: `packages/core/src/capabilities/enforcer.test.ts`

**Step 1: Add path traversal tests**

Add these tests to the existing `describe("CapabilityEnforcer")` block:

```typescript
it("rejects path traversal via ..", () => {
  const registry = new CapabilityRegistry();
  grant(registry, {
    capability: "fs:read",
    constraints: { paths: ["/tmp/"] },
  });
  const enforcer = new CapabilityEnforcer(registry);

  // Direct traversal — should be denied
  expect(() =>
    enforcer.check("test-skill", "fs:read", { path: "/tmp/../etc/passwd" }),
  ).toThrow(CapabilityDeniedError);
});

it("rejects path traversal via encoded sequences", () => {
  const registry = new CapabilityRegistry();
  grant(registry, {
    capability: "fs:write",
    constraints: { paths: ["/home/user/"] },
  });
  const enforcer = new CapabilityEnforcer(registry);

  expect(() =>
    enforcer.check("test-skill", "fs:write", {
      path: "/home/user/../../etc/shadow",
    }),
  ).toThrow(CapabilityDeniedError);
});

it("allows legitimate paths after normalization", () => {
  const registry = new CapabilityRegistry();
  grant(registry, {
    capability: "fs:read",
    constraints: { paths: ["/tmp/"] },
  });
  const enforcer = new CapabilityEnforcer(registry);

  // Redundant path segments that still resolve under /tmp/
  expect(() =>
    enforcer.check("test-skill", "fs:read", {
      path: "/tmp/subdir/../other/file.txt",
    }),
  ).not.toThrow();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/capabilities/enforcer.test.ts`
Expected: FAIL — the path traversal test passes when it should be blocked

**Step 3: Verify the existing security test documents this**

The test at `test/security/permission-escalation.test.ts:82-97` currently documents this as a known limitation. After the fix, this test should be updated.

---

### Task 2: Implement path normalization in enforcer

**Files:**
- Modify: `packages/core/src/capabilities/enforcer.ts:1` (add import)
- Modify: `packages/core/src/capabilities/enforcer.ts:51-65` (path constraint logic)

**Step 1: Add path import**

```typescript
import { resolve } from "node:path";
```

**Step 2: Normalize paths before comparison**

Replace the path constraint check block (lines 51-65) with:

```typescript
if (context.path) {
  const pathGrants = grants.filter((g) => g.constraints?.paths);
  if (pathGrants.length > 0) {
    const normalizedPath = resolve(context.path);
    const allowed = pathGrants.some((g) =>
      g.constraints!.paths!.some((p) =>
        normalizedPath.startsWith(resolve(p)),
      ),
    );
    if (!allowed) {
      throw new CapabilityDeniedError(
        skillId,
        capability,
        `path "${context.path}" not in allowed paths`,
      );
    }
  }
}
```

Key changes:
- `context.path` is resolved via `resolve()` which eliminates `..` segments
- Constraint paths are also resolved for consistency
- Error message still shows the original path for debugging

**Step 3: Run enforcer tests**

Run: `pnpm vitest run packages/core/src/capabilities/enforcer.test.ts`
Expected: All tests PASS (including the new traversal tests)

**Step 4: Commit**

```
fix(core): normalize paths in capability enforcer to prevent traversal
```

---

### Task 3: Update the security integration test

**Files:**
- Modify: `test/security/permission-escalation.test.ts:82-97`

**Step 1: Update the known-limitation test**

The existing test documents the traversal as a known limitation. Change it to verify the fix:

```typescript
it("blocks path traversal via .. (FIXED)", () => {
  const registry = new CapabilityRegistry();
  registry.grantCapability({
    skillId: "traversal-test",
    capability: "fs:read",
    constraints: { paths: ["/tmp/"] },
    grantedAt: new Date(),
    grantedBy: "user",
  });
  const enforcer = new CapabilityEnforcer(registry);

  // Was previously a known limitation — now fixed
  expect(() =>
    enforcer.check("traversal-test", "fs:read", {
      path: "/tmp/../etc/passwd",
    }),
  ).toThrow(CapabilityDeniedError);
});
```

**Step 2: Run security tests**

Run: `pnpm vitest run test/security/permission-escalation.test.ts`
Expected: All tests PASS

**Step 3: Run full suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Commit**

```
test(security): update path traversal test to verify fix
```
