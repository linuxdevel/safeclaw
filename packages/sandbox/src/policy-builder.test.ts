import { describe, it, expect, beforeEach } from "vitest";
import { PolicyBuilder } from "./policy-builder.js";
import type { SandboxPolicy, PathRule } from "./types.js";

describe("PolicyBuilder", () => {
  describe("addReadExecute()", () => {
    it("adds a path with read access", () => {
      const policy = new PolicyBuilder().addReadExecute("/usr/bin").build();
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/usr/bin",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("execute");
    });
  });

  describe("addReadWrite()", () => {
    it("adds a path with readwrite access", () => {
      const policy = new PolicyBuilder().addReadWrite("/tmp").build();
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/tmp",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("readwrite");
    });
  });

  describe("addReadOnly()", () => {
    it("adds a path with read access", () => {
      const policy = new PolicyBuilder().addReadOnly("/etc").build();
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/etc",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("read");
    });
  });

  describe("build()", () => {
    it("returns a valid SandboxPolicy", () => {
      const policy = new PolicyBuilder().build();
      expect(policy.filesystem).toBeDefined();
      expect(policy.filesystem.allow).toBeInstanceOf(Array);
      expect(policy.filesystem.deny).toBeInstanceOf(Array);
      expect(policy.syscalls.defaultDeny).toBe(true);
      expect(policy.network).toBe("none");
      expect(policy.namespaces).toEqual({
        pid: true,
        net: true,
        mnt: true,
        user: true,
      });
    });

    it("starts with an empty policy", () => {
      const policy = new PolicyBuilder().build();
      expect(policy.filesystem.allow).toHaveLength(0);
      expect(policy.syscalls.allow).toHaveLength(0);
    });

    it("chains builder methods", () => {
      const builder = new PolicyBuilder();
      const result = builder
        .addReadExecute("/bin")
        .addReadWrite("/tmp")
        .addReadOnly("/etc");
      expect(result).toBe(builder);
    });
  });

  describe("forDevelopment()", () => {
    let policy: SandboxPolicy;

    beforeEach(() => {
      policy = PolicyBuilder.forDevelopment("/home/dev/project");
    });

    it("includes CWD as readwrite", () => {
      const cwd = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/home/dev/project",
      );
      expect(cwd).toBeDefined();
      expect(cwd!.access).toBe("readwrite");
    });

    it("includes /tmp as readwrite", () => {
      const tmp = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/tmp",
      );
      expect(tmp).toBeDefined();
      expect(tmp!.access).toBe("readwrite");
    });

    it("includes standard command paths as execute", () => {
      const expectedPaths = ["/bin", "/usr/bin", "/usr/local/bin"];
      for (const p of expectedPaths) {
        const rule = policy.filesystem.allow.find(
          (r: PathRule) => r.path === p,
        );
        expect(rule, `expected ${p} to be in allow list`).toBeDefined();
        expect(rule!.access).toBe("execute");
      }
    });

    it("includes shared library paths as execute", () => {
      const expectedPaths = ["/usr/lib", "/lib", "/lib64"];
      for (const p of expectedPaths) {
        const rule = policy.filesystem.allow.find(
          (r: PathRule) => r.path === p,
        );
        expect(rule, `expected ${p} to be in allow list`).toBeDefined();
        expect(rule!.access).toBe("execute");
      }
    });

    it("includes /etc as read-only", () => {
      const etc = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/etc",
      );
      expect(etc).toBeDefined();
      expect(etc!.access).toBe("read");
    });

    it("includes /proc/self as read-only", () => {
      const proc = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/proc/self",
      );
      expect(proc).toBeDefined();
      expect(proc!.access).toBe("read");
    });

    it("includes device nodes as read-only", () => {
      const devices = ["/dev/null", "/dev/urandom", "/dev/zero"];
      for (const d of devices) {
        const rule = policy.filesystem.allow.find(
          (r: PathRule) => r.path === d,
        );
        expect(rule, `expected ${d} to be in allow list`).toBeDefined();
        expect(rule!.access).toBe("read");
      }
    });

    it("includes Node.js install path as execute", () => {
      // Node.js install path is derived from process.execPath
      // It should be something like /usr/local or /home/user/.nvm/versions/...
      const nodeRules = policy.filesystem.allow.filter(
        (r: PathRule) => r.access === "execute",
      );
      // The node install dir should be in the allow list
      const nodeInstallDir = process.execPath
        .split("/")
        .slice(0, -2)
        .join("/");
      const found = nodeRules.some(
        (r: PathRule) => r.path === nodeInstallDir,
      );
      // Node install might already be under /usr/local/bin or /usr/bin
      // so it might not be a separate entry. Just verify it's accessible.
      const coveredByStandard = [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/usr/lib",
        "/lib",
        "/lib64",
      ].some((p) => nodeInstallDir.startsWith(p) || nodeInstallDir === p);
      expect(
        found || coveredByStandard,
        `Node.js install dir ${nodeInstallDir} should be accessible`,
      ).toBe(true);
    });

    it("includes ~/.safeclaw as readwrite", () => {
      const safeclaw = policy.filesystem.allow.find((r: PathRule) =>
        r.path.endsWith("/.safeclaw"),
      );
      expect(safeclaw).toBeDefined();
      expect(safeclaw!.access).toBe("readwrite");
    });

    it("has network set to none", () => {
      expect(policy.network).toBe("none");
    });

    it("has all namespaces enabled", () => {
      expect(policy.namespaces).toEqual({
        pid: true,
        net: true,
        mnt: true,
        user: true,
      });
    });

    it("has an expanded syscall allowlist", () => {
      // Should have significantly more than the DEFAULT_POLICY's 26 syscalls
      expect(policy.syscalls.allow.length).toBeGreaterThan(50);
      expect(policy.syscalls.defaultDeny).toBe(true);
    });

    it("includes essential syscalls for development tools", () => {
      const essentialSyscalls = [
        "openat",
        "stat",
        "readlink",
        "getdents64",
        "pipe2",
        "clone",
        "execve",
        "futex",
        "clock_gettime",
        "newfstatat",
        "clone3",
        "mkdir",
        "unlink",
        "rename",
      ];
      for (const sc of essentialSyscalls) {
        expect(
          policy.syscalls.allow,
          `expected syscall "${sc}" to be allowed`,
        ).toContain(sc);
      }
    });

    it("has a 30-second timeout", () => {
      expect(policy.timeoutMs).toBe(30_000);
    });

    it("does not duplicate paths", () => {
      const paths = policy.filesystem.allow.map((r: PathRule) => r.path);
      const unique = new Set(paths);
      expect(paths.length).toBe(unique.size);
    });

    it("includes compiler and toolchain paths as execute", () => {
      // JDK, GCC libs, Go toolchain — compilers need their internal libs
      const compilerPaths = ["/usr/lib/jvm", "/usr/lib/gcc", "/usr/libexec"];
      for (const p of compilerPaths) {
        const rule = policy.filesystem.allow.find(
          (r: PathRule) => r.path === p,
        );
        expect(rule, `expected ${p} to be in allow list`).toBeDefined();
        expect(rule!.access).toBe("execute");
      }
    });

    it("includes /usr/include as read-only for C/C++ headers", () => {
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/usr/include",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("read");
    });

    it("includes /usr/share as read-only for compiler support files", () => {
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/usr/share",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("read");
    });
  });

  describe("forDevelopment() with user toolchains", () => {
    it("includes ~/.cargo as execute when it exists", () => {
      // forDevelopment detects user-local toolchains
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraExecutePaths: ["/home/dev/.cargo"],
      });
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/home/dev/.cargo",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("execute");
    });

    it("includes ~/.rustup as execute when provided", () => {
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraExecutePaths: ["/home/dev/.rustup"],
      });
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/home/dev/.rustup",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("execute");
    });

    it("includes extra readwrite paths", () => {
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraReadWritePaths: ["/home/dev/.cache"],
      });
      const rule = policy.filesystem.allow.find(
        (r: PathRule) => r.path === "/home/dev/.cache",
      );
      expect(rule).toBeDefined();
      expect(rule!.access).toBe("readwrite");
    });

    it("deduplicates extra paths against standard paths", () => {
      const policy = PolicyBuilder.forDevelopment("/home/dev/project", {
        extraExecutePaths: ["/usr/bin"], // already a standard path
      });
      const matches = policy.filesystem.allow.filter(
        (r: PathRule) => r.path === "/usr/bin",
      );
      expect(matches).toHaveLength(1);
    });
  });
});
