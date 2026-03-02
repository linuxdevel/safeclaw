import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "./sandbox.js";
import { DEFAULT_POLICY } from "./types.js";
import type { SandboxPolicy } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = join(
  __dirname,
  "..",
  "..",
  "..",
  "native",
  "safeclaw-sandbox-helper",
);
const helperExists = existsSync(helperPath);

/**
 * Probe whether user namespaces work on this machine.
 * GitHub Actions runners and some containers restrict unprivileged
 * user namespaces, causing `unshare --user` to fail.
 */
let canUnshareUser = false;
try {
  execFileSync("unshare", ["--user", "--map-root-user", "--", "/bin/true"], {
    timeout: 3000,
  });
  canUnshareUser = true;
} catch {
  // user namespaces not available — skip dependent tests
}

/**
 * Policy that allows /bin/echo to run through the full spawn chain.
 * Extends DEFAULT_POLICY's syscall list with dynamic linker requirements,
 * and grants filesystem execute access to binary and library paths.
 *
 * Libraries need "execute" (not "read") because the kernel maps shared
 * objects with PROT_EXEC; Landlock's EXECUTE right covers this.
 */
const ECHO_POLICY: SandboxPolicy = {
  ...DEFAULT_POLICY,
  filesystem: {
    allow: [
      { path: "/bin", access: "execute" },
      { path: "/usr/bin", access: "execute" },
      { path: "/lib", access: "execute" },
      { path: "/lib64", access: "execute" },
      { path: "/usr/lib", access: "execute" },
      { path: "/usr/lib64", access: "execute" },
      { path: "/etc", access: "read" },
    ],
    deny: [],
  },
  syscalls: {
    defaultDeny: true,
    allow: [
      ...DEFAULT_POLICY.syscalls.allow,
      "openat",
      "pread64",
      "newfstatat",
      "writev",
    ],
  },
};

describe("Sandbox integration (real binary)", () => {
  it.skipIf(!helperExists || !canUnshareUser)(
    "seccomp enforcement blocks missing syscalls with DEFAULT_POLICY",
    async () => {
      process.env["SAFECLAW_HELPER_PATH"] = helperPath;

      try {
        const sandbox = new Sandbox(DEFAULT_POLICY);
        const result = await sandbox.execute("/bin/echo", [
          "should-not-appear",
        ]);

        // DEFAULT_POLICY allows basic syscalls but omits openat/pread64
        // needed by the dynamic linker, so the child is killed by SIGSYS.
        // This proves seccomp enforcement is actually working.
        expect(result.enforcement).toBeDefined();
        expect(result.enforcement!.namespaces).toBe(true);
        expect(result.enforcement!.landlock).toBe(true);
        expect(result.enforcement!.seccomp).toBe(true);
        expect(result.enforcement!.capDrop).toBe(true);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
      } finally {
        delete process.env["SAFECLAW_HELPER_PATH"];
      }
    },
  );

  it.skipIf(!helperExists || !canUnshareUser)(
    "full spawn chain produces output with sufficient syscall allowlist",
    async () => {
      process.env["SAFECLAW_HELPER_PATH"] = helperPath;

      try {
        const sandbox = new Sandbox(ECHO_POLICY);
        const result = await sandbox.execute("/bin/echo", [
          "integration-test",
        ]);

        expect(result.stdout).toContain("integration-test");
        expect(result.exitCode).toBe(0);
        expect(result.enforcement).toBeDefined();
        expect(result.enforcement!.namespaces).toBe(true);
        expect(result.enforcement!.landlock).toBe(true);
        expect(result.enforcement!.seccomp).toBe(true);
        expect(result.enforcement!.capDrop).toBe(true);
      } finally {
        delete process.env["SAFECLAW_HELPER_PATH"];
      }
    },
  );

  it.skipIf(!canUnshareUser)(
    "reports enforcement metadata for every execution",
    async () => {
      const sandbox = new Sandbox(DEFAULT_POLICY);
      const result = await sandbox.execute("/bin/true", []);

      // Even without helper verification, enforcement metadata is present
      expect(result.enforcement).toBeDefined();
      expect(result.enforcement!.namespaces).toBe(true);
    },
  );
});
