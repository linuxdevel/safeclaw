# SafeClaw Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a secure, full-featured personal AI assistant with zero-trust architecture as an alternative to OpenClaw.

**Architecture:** pnpm monorepo with six packages (`core`, `sandbox`, `vault`, `gateway`, `cli`, `webchat`). All tool execution runs inside mandatory OS-level sandboxes (Landlock + seccomp-BPF + Linux namespaces). Skills require Ed25519-signed manifests with declared capabilities. Secrets encrypted at rest with AES-256-GCM. LLM access via GitHub Copilot API only.

**Tech Stack:** TypeScript 5.x, Node.js 22+, pnpm 9+, Vitest, oxlint, `node:crypto` for Ed25519/AES-256-GCM, `landlock-node` (or raw FFI) for Landlock, `libseccomp` bindings for seccomp-BPF.

**Reference:** See `docs/plans/2026-03-02-safeclaw-design.md` for full architecture, threat model, and interface definitions.

---

## Phase 1: Foundation

Phase 1 builds the project scaffold and the three security-critical packages that everything else depends on: vault (encrypted secrets), sandbox (OS-level isolation), and the capability system (signed manifests + runtime enforcement).

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.oxlintrc.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/sandbox/package.json`
- Create: `packages/sandbox/tsconfig.json`
- Create: `packages/sandbox/src/index.ts`
- Create: `packages/vault/package.json`
- Create: `packages/vault/tsconfig.json`
- Create: `packages/vault/src/index.ts`
- Create: `packages/gateway/package.json`
- Create: `packages/gateway/tsconfig.json`
- Create: `packages/gateway/src/index.ts`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/webchat/package.json`
- Create: `packages/webchat/tsconfig.json`
- Create: `packages/webchat/src/index.ts`
- Create: `LICENSE`

**Step 1: Create root package.json**

```json
{
  "name": "safeclaw",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "oxlint .",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: Create root tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2024"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  },
  "references": [
    { "path": "packages/core" },
    { "path": "packages/sandbox" },
    { "path": "packages/vault" },
    { "path": "packages/gateway" },
    { "path": "packages/cli" },
    { "path": "packages/webchat" }
  ],
  "include": [],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create tsconfig.build.json**

This is the base config that each package extends.

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2024"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  },
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
```

**Step 6: Create .gitignore**

```
node_modules/
dist/
*.tgz
.env
.env.*
coverage/
.turbo/
```

**Step 7: Create .oxlintrc.json**

```json
{
  "rules": {
    "no-console": "warn",
    "no-debugger": "error",
    "eqeqeq": "error"
  }
}
```

**Step 8: Create package scaffolds for all 6 packages**

Each package gets a `package.json`, `tsconfig.json`, and `src/index.ts`.

Example for `packages/vault/package.json`:

```json
{
  "name": "@safeclaw/vault",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "files": ["dist"]
}
```

Example for `packages/vault/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.build.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Example for `packages/vault/src/index.ts`:

```typescript
// @safeclaw/vault - Encrypted secrets storage
```

Repeat this pattern for all packages: `core`, `sandbox`, `vault`, `gateway`, `cli`, `webchat`. Adjust the package name accordingly (e.g., `@safeclaw/core`, `@safeclaw/sandbox`, etc.).

For packages that depend on others, add `references` to their `tsconfig.json` and workspace dependencies to their `package.json`. These will be added in later tasks as dependencies become clear.

**Step 9: Create LICENSE**

Use ISC license (or user's preference — ask if unclear).

**Step 10: Install dependencies**

Run:
```bash
pnpm install
pnpm add -D -w typescript vitest @vitest/coverage-v8 oxlint
```

Expected: Clean install, `node_modules/` created, lockfile generated.

**Step 11: Verify scaffold works**

Run:
```bash
pnpm typecheck
pnpm test
pnpm lint
```

Expected: All pass (typecheck may warn about empty projects, tests find 0 tests, lint passes).

**Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with 6 packages"
```

---

### Task 2: Vault — Encrypted Secrets Storage (`@safeclaw/vault`)

The vault stores secrets encrypted at rest using AES-256-GCM. The encryption key is derived from the OS keyring (GNOME Keyring via `secret-tool`) with Argon2id passphrase as fallback. The vault refuses to operate if file permissions are wrong.

**Files:**
- Create: `packages/vault/src/types.ts`
- Create: `packages/vault/src/permissions.ts`
- Create: `packages/vault/src/permissions.test.ts`
- Create: `packages/vault/src/keyring.ts`
- Create: `packages/vault/src/keyring.test.ts`
- Create: `packages/vault/src/crypto.ts`
- Create: `packages/vault/src/crypto.test.ts`
- Create: `packages/vault/src/vault.ts`
- Create: `packages/vault/src/vault.test.ts`
- Modify: `packages/vault/src/index.ts`

**Step 1: Write vault types**

Create `packages/vault/src/types.ts`:

```typescript
/** A single encrypted entry stored on disk */
export interface EncryptedEntry {
  /** Base64-encoded AES-256-GCM ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (unique per encryption) */
  iv: string;
  /** Base64-encoded 16-byte auth tag */
  authTag: string;
}

/** The on-disk vault file format */
export interface VaultFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

/** How the master key was obtained */
export type KeySource = "keyring" | "passphrase";

/** Result of unlocking the vault */
export interface UnlockResult {
  key: Buffer;
  source: KeySource;
}

/** Options for vault initialization */
export interface VaultOptions {
  /** Path to the vault file on disk */
  path: string;
  /** Application name for keyring storage */
  appName?: string;
}
```

**Step 2: Write failing test for file permission checks**

Create `packages/vault/src/permissions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertFilePermissions, assertDirectoryPermissions } from "./permissions.js";
import * as fs from "node:fs";

vi.mock("node:fs");

describe("permissions", () => {
  const mockedFs = vi.mocked(fs);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("assertFilePermissions", () => {
    it("accepts mode 0o600", () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as fs.Stats);
      expect(() => assertFilePermissions("/tmp/vault.json")).not.toThrow();
    });

    it("rejects mode 0o644", () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100644 } as fs.Stats);
      expect(() => assertFilePermissions("/tmp/vault.json")).toThrow(
        /permissions.*\/tmp\/vault\.json/
      );
    });

    it("rejects mode 0o666", () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100666 } as fs.Stats);
      expect(() => assertFilePermissions("/tmp/vault.json")).toThrow();
    });
  });

  describe("assertDirectoryPermissions", () => {
    it("accepts mode 0o700", () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o040700 } as fs.Stats);
      expect(() => assertDirectoryPermissions("/tmp/vault")).not.toThrow();
    });

    it("rejects mode 0o755", () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o040755 } as fs.Stats);
      expect(() => assertDirectoryPermissions("/tmp/vault")).toThrow(
        /permissions.*\/tmp\/vault/
      );
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/vault/src/permissions.test.ts`
Expected: FAIL — `assertFilePermissions` not found

**Step 4: Implement permissions module**

Create `packages/vault/src/permissions.ts`:

```typescript
import { statSync } from "node:fs";

export class PermissionError extends Error {
  constructor(path: string, actual: string, expected: string) {
    super(
      `Insecure permissions on ${path}: got ${actual}, expected ${expected}. ` +
      `Fix with: chmod ${expected} ${path}`
    );
    this.name = "PermissionError";
  }
}

/** Extract the lower 9 permission bits from a stat mode */
function permBits(mode: number): number {
  return mode & 0o777;
}

function formatOctal(mode: number): string {
  return "0o" + mode.toString(8).padStart(3, "0");
}

/**
 * Assert a file has mode 0o600 (owner read/write only).
 * Throws PermissionError if not.
 */
export function assertFilePermissions(path: string): void {
  const { mode } = statSync(path);
  const perm = permBits(mode);
  if (perm !== 0o600) {
    throw new PermissionError(path, formatOctal(perm), "600");
  }
}

/**
 * Assert a directory has mode 0o700 (owner rwx only).
 * Throws PermissionError if not.
 */
export function assertDirectoryPermissions(path: string): void {
  const { mode } = statSync(path);
  const perm = permBits(mode);
  if (perm !== 0o700) {
    throw new PermissionError(path, formatOctal(perm), "700");
  }
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/vault/src/permissions.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/vault/src/types.ts packages/vault/src/permissions.ts packages/vault/src/permissions.test.ts
git commit -m "feat(vault): add types and file permission enforcement"
```

**Step 7: Write failing test for crypto operations**

Create `packages/vault/src/crypto.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, deriveKeyFromPassphrase } from "./crypto.js";

describe("crypto", () => {
  const testKey = Buffer.alloc(32, 0xab); // 256-bit key

  describe("encrypt / decrypt roundtrip", () => {
    it("encrypts and decrypts a simple string", () => {
      const plaintext = "my-secret-api-key";
      const encrypted = encrypt(plaintext, testKey);

      expect(encrypted.ciphertext).not.toBe(plaintext);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();

      const decrypted = decrypt(encrypted, testKey);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (unique IV)", () => {
      const plaintext = "same-input";
      const a = encrypt(plaintext, testKey);
      const b = encrypt(plaintext, testKey);

      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it("fails to decrypt with wrong key", () => {
      const plaintext = "secret";
      const encrypted = encrypt(plaintext, testKey);
      const wrongKey = Buffer.alloc(32, 0xcd);

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it("fails to decrypt with tampered ciphertext", () => {
      const encrypted = encrypt("secret", testKey);
      const tampered = Buffer.from(encrypted.ciphertext, "base64");
      tampered[0] = tampered[0]! ^ 0xff;
      encrypted.ciphertext = tampered.toString("base64");

      expect(() => decrypt(encrypted, testKey)).toThrow();
    });

    it("handles empty string", () => {
      const encrypted = encrypt("", testKey);
      const decrypted = decrypt(encrypted, testKey);
      expect(decrypted).toBe("");
    });

    it("handles unicode content", () => {
      const plaintext = "p\u00e4ssw\u00f6rd \ud83d\udd10";
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("deriveKeyFromPassphrase", () => {
    it("derives a 32-byte key", async () => {
      const key = await deriveKeyFromPassphrase("my-passphrase");
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("produces same key for same passphrase and salt", async () => {
      const salt = Buffer.from("fixed-salt-for-test");
      const a = await deriveKeyFromPassphrase("pass", salt);
      const b = await deriveKeyFromPassphrase("pass", salt);
      expect(a.equals(b)).toBe(true);
    });

    it("produces different key for different passphrase", async () => {
      const salt = Buffer.from("fixed-salt");
      const a = await deriveKeyFromPassphrase("pass-a", salt);
      const b = await deriveKeyFromPassphrase("pass-b", salt);
      expect(a.equals(b)).toBe(false);
    });
  });
});
```

**Step 8: Run test to verify it fails**

Run: `pnpm vitest run packages/vault/src/crypto.test.ts`
Expected: FAIL — `encrypt` not found

**Step 9: Implement crypto module**

Create `packages/vault/src/crypto.ts`:

```typescript
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import type { EncryptedEntry } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 2 ** 17; // N=131072
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const DEFAULT_SALT_LENGTH = 32;

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64-encoded ciphertext, IV, and auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted entry.
 * Throws if key is wrong or data has been tampered with.
 */
export function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, "base64");
  const authTag = Buffer.from(entry.authTag, "base64");
  const ciphertext = Buffer.from(entry.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Derive a 256-bit key from a passphrase using scrypt.
 * If no salt is provided, a random 32-byte salt is generated.
 * Returns the derived key. The salt must be stored alongside the vault
 * for future derivation.
 */
export function deriveKeyFromPassphrase(
  passphrase: string,
  salt?: Buffer,
): Promise<Buffer> {
  const actualSalt = salt ?? randomBytes(DEFAULT_SALT_LENGTH);

  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      actualSalt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey as Buffer);
        }
      },
    );
  });
}
```

**Step 10: Run test to verify it passes**

Run: `pnpm vitest run packages/vault/src/crypto.test.ts`
Expected: PASS

**Step 11: Commit**

```bash
git add packages/vault/src/crypto.ts packages/vault/src/crypto.test.ts
git commit -m "feat(vault): add AES-256-GCM encrypt/decrypt and scrypt key derivation"
```

**Step 12: Write failing test for keyring integration**

Create `packages/vault/src/keyring.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KeyringProvider } from "./keyring.js";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process");

describe("KeyringProvider", () => {
  const mockedExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores a key in the keyring via secret-tool", () => {
    const provider = new KeyringProvider("safeclaw");
    const key = Buffer.alloc(32, 0xab);

    provider.store(key);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "secret-tool",
      expect.arrayContaining(["store"]),
      expect.objectContaining({ input: key.toString("base64") }),
    );
  });

  it("retrieves a key from the keyring via secret-tool", () => {
    const key = Buffer.alloc(32, 0xab);
    mockedExecFileSync.mockReturnValue(key.toString("base64") + "\n");

    const provider = new KeyringProvider("safeclaw");
    const result = provider.retrieve();

    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBe(32);
    expect(result!.equals(key)).toBe(true);
  });

  it("returns null when keyring has no entry", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("No matching secret found");
    });

    const provider = new KeyringProvider("safeclaw");
    const result = provider.retrieve();

    expect(result).toBeNull();
  });
});
```

**Step 13: Run test to verify it fails**

Run: `pnpm vitest run packages/vault/src/keyring.test.ts`
Expected: FAIL — `KeyringProvider` not found

**Step 14: Implement keyring provider**

Create `packages/vault/src/keyring.ts`:

```typescript
import { execFileSync } from "node:child_process";

/**
 * Interacts with the Linux secret-tool (GNOME Keyring / libsecret)
 * to store and retrieve the vault master key.
 */
export class KeyringProvider {
  private readonly appName: string;

  constructor(appName: string = "safeclaw") {
    this.appName = appName;
  }

  /** Store a master key in the OS keyring */
  store(key: Buffer): void {
    execFileSync(
      "secret-tool",
      [
        "store",
        "--label", `${this.appName} vault key`,
        "application", this.appName,
        "type", "vault-master-key",
      ],
      {
        input: key.toString("base64"),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  /** Retrieve the master key from the OS keyring, or null if not found */
  retrieve(): Buffer | null {
    try {
      const stdout = execFileSync(
        "secret-tool",
        [
          "lookup",
          "application", this.appName,
          "type", "vault-master-key",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const b64 = stdout.toString("utf8").trim();
      if (!b64) return null;
      return Buffer.from(b64, "base64");
    } catch {
      return null;
    }
  }
}
```

**Step 15: Run test to verify it passes**

Run: `pnpm vitest run packages/vault/src/keyring.test.ts`
Expected: PASS

**Step 16: Commit**

```bash
git add packages/vault/src/keyring.ts packages/vault/src/keyring.test.ts
git commit -m "feat(vault): add OS keyring provider for master key storage"
```

**Step 17: Write failing test for Vault class**

Create `packages/vault/src/vault.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Vault } from "./vault.js";
import * as fs from "node:fs";
import * as permissions from "./permissions.js";

vi.mock("node:fs");
vi.mock("./permissions.js");

describe("Vault", () => {
  const mockedFs = vi.mocked(fs);
  const mockedPermissions = vi.mocked(permissions);
  const testKey = Buffer.alloc(32, 0xab);
  const vaultPath = "/tmp/test-vault/secrets.json";

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: permission checks pass
    mockedPermissions.assertFilePermissions.mockImplementation(() => {});
    mockedPermissions.assertDirectoryPermissions.mockImplementation(() => {});
  });

  it("creates a new vault file if none exists", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      vaultPath,
      expect.stringContaining('"version":1'),
      { mode: 0o600 },
    );
    expect(vault).toBeInstanceOf(Vault);
  });

  it("opens an existing vault file", () => {
    const vaultData = JSON.stringify({ version: 1, entries: {} });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(vaultData);

    const vault = Vault.open(vaultPath, testKey);

    expect(mockedPermissions.assertFilePermissions).toHaveBeenCalledWith(vaultPath);
    expect(vault).toBeInstanceOf(Vault);
  });

  it("refuses to open vault with wrong permissions", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedPermissions.assertFilePermissions.mockImplementation(() => {
      throw new Error("Insecure permissions");
    });

    expect(() => Vault.open(vaultPath, testKey)).toThrow("Insecure permissions");
  });

  it("stores and retrieves a secret", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);

    vault.set("api-key", "sk-12345");
    const retrieved = vault.get("api-key");

    expect(retrieved).toBe("sk-12345");
  });

  it("returns undefined for missing key", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);

    expect(vault.get("nonexistent")).toBeUndefined();
  });

  it("deletes a secret", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);

    vault.set("api-key", "sk-12345");
    vault.delete("api-key");

    expect(vault.get("api-key")).toBeUndefined();
  });

  it("lists all secret keys (not values)", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);

    vault.set("key-a", "value-a");
    vault.set("key-b", "value-b");

    expect(vault.keys()).toEqual(["key-a", "key-b"]);
  });

  it("persists to disk on save()", () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.chmodSync.mockImplementation(() => {});

    const vault = Vault.create(vaultPath, testKey);
    vault.set("key", "value");
    vault.save();

    // writeFileSync called on create + on save
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
    const lastCall = mockedFs.writeFileSync.mock.calls[1]!;
    expect(lastCall[0]).toBe(vaultPath);
    const written = JSON.parse(lastCall[1] as string);
    expect(written.version).toBe(1);
    expect(written.entries.key).toBeDefined();
    expect(written.entries.key.ciphertext).toBeDefined();
  });
});
```

**Step 18: Run test to verify it fails**

Run: `pnpm vitest run packages/vault/src/vault.test.ts`
Expected: FAIL — `Vault` not found

**Step 19: Implement Vault class**

Create `packages/vault/src/vault.ts`:

```typescript
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import type { VaultFile, EncryptedEntry } from "./types.js";
import { encrypt, decrypt } from "./crypto.js";
import { assertFilePermissions, assertDirectoryPermissions } from "./permissions.js";

export class Vault {
  private readonly path: string;
  private readonly key: Buffer;
  private data: VaultFile;

  private constructor(path: string, key: Buffer, data: VaultFile) {
    this.path = path;
    this.key = key;
    this.data = data;
  }

  /**
   * Create a new vault file at the given path.
   * Creates the parent directory with mode 0o700 if needed.
   * Writes an empty vault with mode 0o600.
   */
  static create(path: string, key: Buffer): Vault {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const data: VaultFile = { version: 1, entries: {} };
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    chmodSync(path, 0o600);

    return new Vault(path, key, data);
  }

  /**
   * Open an existing vault file.
   * Checks file permissions before reading.
   * Throws PermissionError if permissions are wrong.
   */
  static open(path: string, key: Buffer): Vault {
    assertFilePermissions(path);

    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as VaultFile;

    if (data.version !== 1) {
      throw new Error(`Unsupported vault version: ${data.version}`);
    }

    return new Vault(path, key, data);
  }

  /** Store a secret (encrypted in memory, call save() to persist) */
  set(name: string, value: string): void {
    this.data.entries[name] = encrypt(value, this.key);
  }

  /** Retrieve and decrypt a secret, or undefined if not found */
  get(name: string): string | undefined {
    const entry = this.data.entries[name];
    if (!entry) return undefined;
    return decrypt(entry, this.key);
  }

  /** Delete a secret */
  delete(name: string): boolean {
    if (!(name in this.data.entries)) return false;
    delete this.data.entries[name];
    return true;
  }

  /** List all secret names (not values) */
  keys(): string[] {
    return Object.keys(this.data.entries);
  }

  /** Persist the vault to disk with secure permissions */
  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
```

**Step 20: Run test to verify it passes**

Run: `pnpm vitest run packages/vault/src/vault.test.ts`
Expected: PASS

**Step 21: Update vault index.ts to export public API**

Modify `packages/vault/src/index.ts`:

```typescript
export { Vault } from "./vault.js";
export { KeyringProvider } from "./keyring.js";
export { deriveKeyFromPassphrase } from "./crypto.js";
export { PermissionError } from "./permissions.js";
export type {
  VaultFile,
  VaultOptions,
  EncryptedEntry,
  KeySource,
  UnlockResult,
} from "./types.js";
```

**Step 22: Run all vault tests**

Run: `pnpm vitest run packages/vault/`
Expected: All PASS

**Step 23: Commit**

```bash
git add packages/vault/
git commit -m "feat(vault): add Vault class with encrypted storage, keyring, and permissions"
```

---

### Task 3: Sandbox — OS-Level Isolation (`@safeclaw/sandbox`)

The sandbox enforces mandatory OS-level isolation using three Linux kernel mechanisms: Landlock (filesystem ACLs), seccomp-BPF (syscall filtering), and Linux namespaces (PID, NET, MNT, USER). Every tool execution must pass through the sandbox.

**Files:**
- Create: `packages/sandbox/src/types.ts`
- Create: `packages/sandbox/src/detect.ts`
- Create: `packages/sandbox/src/detect.test.ts`
- Create: `packages/sandbox/src/landlock.ts`
- Create: `packages/sandbox/src/landlock.test.ts`
- Create: `packages/sandbox/src/seccomp.ts`
- Create: `packages/sandbox/src/seccomp.test.ts`
- Create: `packages/sandbox/src/namespace.ts`
- Create: `packages/sandbox/src/namespace.test.ts`
- Create: `packages/sandbox/src/sandbox.ts`
- Create: `packages/sandbox/src/sandbox.test.ts`
- Modify: `packages/sandbox/src/index.ts`

**Step 1: Write sandbox types**

Create `packages/sandbox/src/types.ts`:

```typescript
/** Filesystem access rule for Landlock */
export interface PathRule {
  path: string;
  access: "read" | "write" | "readwrite" | "execute";
}

/** Sandbox policy — defines isolation constraints for a single execution */
export interface SandboxPolicy {
  /** Filesystem ACLs */
  filesystem: {
    allow: PathRule[];
    deny: PathRule[];
  };
  /** Syscall filter (allowlist — everything else denied) */
  syscalls: {
    allow: string[];
    defaultDeny: true;
  };
  /** Network access level */
  network: "none" | "localhost" | "filtered";
  /** Linux namespace isolation */
  namespaces: {
    pid: boolean;
    net: boolean;
    mnt: boolean;
    user: boolean;
  };
  /** Optional: max execution time in ms */
  timeoutMs?: number;
}

/** Result of a sandboxed execution */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  killReason?: "timeout" | "oom" | "signal";
}

/** Kernel feature availability */
export interface KernelCapabilities {
  landlock: { supported: boolean; abiVersion: number };
  seccomp: { supported: boolean };
  namespaces: {
    user: boolean;
    pid: boolean;
    net: boolean;
    mnt: boolean;
  };
}

/** Default sandbox policy — maximum restriction */
export const DEFAULT_POLICY: SandboxPolicy = {
  filesystem: { allow: [], deny: [] },
  syscalls: { allow: ["read", "write", "exit", "exit_group", "brk", "mmap", "close", "fstat", "mprotect", "munmap", "rt_sigaction", "rt_sigprocmask", "ioctl", "access", "getpid", "clone", "execve", "wait4", "uname", "fcntl", "getcwd", "arch_prctl", "set_tid_address", "set_robust_list", "rseq", "prlimit64", "getrandom"], defaultDeny: true },
  network: "none",
  namespaces: { pid: true, net: true, mnt: true, user: true },
  timeoutMs: 30000,
};
```

**Step 2: Write failing test for kernel feature detection**

Create `packages/sandbox/src/detect.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectKernelCapabilities, assertSandboxSupported } from "./detect.js";
import * as fs from "node:fs";
import * as child_process from "node:child_process";

vi.mock("node:fs");
vi.mock("node:child_process");

describe("detect", () => {
  const mockedFs = vi.mocked(fs);
  const mockedCp = vi.mocked(child_process);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("detectKernelCapabilities", () => {
    it("detects Landlock support from kernel version", () => {
      mockedFs.readFileSync.mockImplementation((path: any) => {
        if (path === "/proc/sys/kernel/osrelease") return "6.1.0-generic\n";
        if (path === "/proc/self/status") return "Seccomp:\t2\n";
        return "";
      });
      mockedFs.existsSync.mockReturnValue(true);

      const caps = detectKernelCapabilities();

      expect(caps.landlock.supported).toBe(true);
      expect(caps.seccomp.supported).toBe(true);
    });

    it("detects missing namespace support", () => {
      mockedFs.readFileSync.mockImplementation((path: any) => {
        if (path === "/proc/sys/kernel/osrelease") return "6.1.0\n";
        if (path === "/proc/self/status") return "Seccomp:\t2\n";
        return "";
      });
      mockedFs.existsSync.mockImplementation((path: any) => {
        if (typeof path === "string" && path.includes("user")) return false;
        return true;
      });

      const caps = detectKernelCapabilities();

      expect(caps.namespaces.user).toBe(false);
    });
  });

  describe("assertSandboxSupported", () => {
    it("throws if Landlock is not supported", () => {
      mockedFs.readFileSync.mockImplementation((path: any) => {
        if (path === "/proc/sys/kernel/osrelease") return "4.0.0\n";
        if (path === "/proc/self/status") return "Seccomp:\t2\n";
        return "";
      });
      mockedFs.existsSync.mockReturnValue(true);

      expect(() => assertSandboxSupported()).toThrow(/Landlock/);
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/sandbox/src/detect.test.ts`
Expected: FAIL

**Step 4: Implement kernel feature detection**

Create `packages/sandbox/src/detect.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import type { KernelCapabilities } from "./types.js";

/** Minimum kernel version for Landlock ABI v1 */
const LANDLOCK_MIN_KERNEL = [5, 13];

function parseKernelVersion(release: string): [number, number] {
  const parts = release.trim().split(".");
  return [parseInt(parts[0] ?? "0", 10), parseInt(parts[1] ?? "0", 10)];
}

function kernelAtLeast(release: string, min: [number, number]): boolean {
  const [major, minor] = parseKernelVersion(release);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/**
 * Detect which sandbox kernel features are available on this system.
 */
export function detectKernelCapabilities(): KernelCapabilities {
  const release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
  const status = readFileSync("/proc/self/status", "utf8");

  const landlockSupported = kernelAtLeast(release, LANDLOCK_MIN_KERNEL as [number, number]);
  // Landlock ABI version: 1 for 5.13+, 2 for 5.19+, 3 for 6.2+
  let landlockAbi = 0;
  if (landlockSupported) {
    const [major, minor] = parseKernelVersion(release);
    if (major > 6 || (major === 6 && minor >= 2)) landlockAbi = 3;
    else if (major > 5 || (major === 5 && minor >= 19)) landlockAbi = 2;
    else landlockAbi = 1;
  }

  const seccompSupported = /Seccomp:\s*[12]/.test(status);

  return {
    landlock: { supported: landlockSupported, abiVersion: landlockAbi },
    seccomp: { supported: seccompSupported },
    namespaces: {
      user: existsSync("/proc/self/ns/user"),
      pid: existsSync("/proc/self/ns/pid"),
      net: existsSync("/proc/self/ns/net"),
      mnt: existsSync("/proc/self/ns/mnt"),
    },
  };
}

/**
 * Assert that the current system supports all required sandbox features.
 * Throws with a descriptive error if any feature is missing.
 */
export function assertSandboxSupported(): KernelCapabilities {
  const caps = detectKernelCapabilities();

  const missing: string[] = [];
  if (!caps.landlock.supported) missing.push("Landlock (requires kernel >= 5.13)");
  if (!caps.seccomp.supported) missing.push("seccomp-BPF");
  if (!caps.namespaces.user) missing.push("User namespaces");
  if (!caps.namespaces.pid) missing.push("PID namespaces");

  if (missing.length > 0) {
    throw new Error(
      `SafeClaw requires mandatory sandbox support. Missing kernel features: ${missing.join(", ")}. ` +
      `SafeClaw v1 is Linux-only and requires a modern kernel (>= 5.13).`
    );
  }

  return caps;
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/sandbox/src/detect.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/sandbox/src/types.ts packages/sandbox/src/detect.ts packages/sandbox/src/detect.test.ts
git commit -m "feat(sandbox): add types, default policy, and kernel feature detection"
```

**Step 7 - 12: Implement Landlock, seccomp, and namespace wrappers**

These follow the same TDD pattern. Each module wraps a Linux kernel API:

- `landlock.ts` — Uses the Landlock syscalls (via `node:ffi` or a native addon) to restrict filesystem access. Applies `PathRule[]` from the policy.
- `seccomp.ts` — Applies a seccomp-BPF filter that allowlists specific syscalls and kills the process on denied calls.
- `namespace.ts` — Uses `clone(2)` with `CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWUSER` flags to create isolated namespaces.

**Note:** These modules will require native bindings. The exact implementation depends on whether we use:
- A) `node-ffi-napi` for raw syscall access
- B) A dedicated npm package like `landlock-node`
- C) A custom native addon (C++ via `node-gyp`)

Decision to be made during implementation based on what's available and maintainable. The test structure remains the same — mock the native layer, test the policy-to-syscall translation logic.

**Step 13: Implement the top-level Sandbox class**

Create `packages/sandbox/src/sandbox.ts` — This is the main entry point that:
1. Checks kernel capabilities via `assertSandboxSupported()`
2. Accepts a `SandboxPolicy`
3. Spawns a child process with all three isolation layers applied
4. Enforces timeout and returns `SandboxResult`

```typescript
// Simplified structure — full implementation in execution phase
import type { SandboxPolicy, SandboxResult } from "./types.js";
import { assertSandboxSupported } from "./detect.js";

export class Sandbox {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    assertSandboxSupported();
    this.policy = policy;
  }

  /**
   * Execute a command inside the sandbox with all isolation layers.
   * Returns the result after execution completes or timeout.
   */
  async execute(command: string, args: string[]): Promise<SandboxResult> {
    // Implementation:
    // 1. Create namespaces (clone with CLONE_NEW*)
    // 2. Apply Landlock ruleset (filesystem ACL)
    // 3. Apply seccomp-BPF filter (syscall allowlist)
    // 4. execve the command
    // 5. Wait for completion or timeout
    // 6. Return SandboxResult
    throw new Error("Not yet implemented");
  }
}
```

**Step 14: Update sandbox index.ts**

```typescript
export { Sandbox } from "./sandbox.js";
export { detectKernelCapabilities, assertSandboxSupported } from "./detect.js";
export { DEFAULT_POLICY } from "./types.js";
export type {
  SandboxPolicy,
  SandboxResult,
  PathRule,
  KernelCapabilities,
} from "./types.js";
```

**Step 15: Run all sandbox tests**

Run: `pnpm vitest run packages/sandbox/`
Expected: All PASS

**Step 16: Commit**

```bash
git add packages/sandbox/
git commit -m "feat(sandbox): add Sandbox class with Landlock, seccomp, namespace wrappers"
```

---

### Task 4: Capability System — Signed Manifests + Runtime Enforcement (`@safeclaw/core`)

The capability system is the trust layer for skills. It handles Ed25519 signature verification of skill manifests, tracks capability grants, and enforces them at runtime.

**Files:**
- Create: `packages/core/src/capabilities/types.ts`
- Create: `packages/core/src/capabilities/signer.ts`
- Create: `packages/core/src/capabilities/signer.test.ts`
- Create: `packages/core/src/capabilities/verifier.ts`
- Create: `packages/core/src/capabilities/verifier.test.ts`
- Create: `packages/core/src/capabilities/registry.ts`
- Create: `packages/core/src/capabilities/registry.test.ts`
- Create: `packages/core/src/capabilities/enforcer.ts`
- Create: `packages/core/src/capabilities/enforcer.test.ts`
- Create: `packages/core/src/capabilities/index.ts`

**Step 1: Write capability types**

Create `packages/core/src/capabilities/types.ts`:

```typescript
/** Available capabilities that a skill can request */
export type Capability =
  | "fs:read"
  | "fs:write"
  | "net:http"
  | "net:https"
  | "process:spawn"
  | "env:read"
  | "secret:read"
  | "secret:write";

/** Constraints on a capability grant */
export interface CapabilityConstraints {
  /** For fs:read/fs:write — allowed path patterns */
  paths?: string[];
  /** For net:* — allowed hostnames */
  hosts?: string[];
  /** For process:spawn — allowed executables */
  executables?: string[];
}

/** A tool provided by a skill */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Signed skill manifest */
export interface SkillManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  /** Ed25519 signature over the canonical manifest content (hex) */
  signature: string;
  /** Ed25519 public key (hex) */
  publicKey: string;
  requiredCapabilities: CapabilityWithConstraints[];
  tools: ToolDefinition[];
}

export interface CapabilityWithConstraints {
  capability: Capability;
  constraints?: CapabilityConstraints;
  reason: string;
}

/** Runtime capability grant — created when user approves a skill */
export interface CapabilityGrant {
  skillId: string;
  capability: Capability;
  constraints?: CapabilityConstraints;
  grantedAt: Date;
  grantedBy: "user" | "builtin";
}

/** Signature verification result */
export interface VerifyResult {
  valid: boolean;
  error?: string;
  publicKey?: string;
}
```

**Step 2: Write failing test for Ed25519 signing**

Create `packages/core/src/capabilities/signer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, signManifest } from "./signer.js";

describe("signer", () => {
  it("generates an Ed25519 key pair", () => {
    const keyPair = generateSigningKeyPair();

    expect(keyPair.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPair.privateKey).toMatch(/^[0-9a-f]{128}$/);
  });

  it("signs manifest content deterministically", () => {
    const keyPair = generateSigningKeyPair();
    const content = JSON.stringify({ id: "test-skill", version: "1.0.0" });

    const sig1 = signManifest(content, keyPair.privateKey);
    const sig2 = signManifest(content, keyPair.privateKey);

    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{128}$/);
  });

  it("produces different signatures for different content", () => {
    const keyPair = generateSigningKeyPair();

    const sig1 = signManifest("content-a", keyPair.privateKey);
    const sig2 = signManifest("content-b", keyPair.privateKey);

    expect(sig1).not.toBe(sig2);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/capabilities/signer.test.ts`
Expected: FAIL

**Step 4: Implement signer**

Create `packages/core/src/capabilities/signer.ts`:

```typescript
import { generateKeyPairSync, sign } from "node:crypto";

export interface SigningKeyPair {
  publicKey: string;  // hex
  privateKey: string; // hex
}

/** Generate a new Ed25519 signing key pair */
export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });

  // Ed25519 public key is last 32 bytes of SPKI DER
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  // Ed25519 private key seed is bytes 16-48 of PKCS8 DER (32 bytes before public key, or use full DER)
  const privHex = privDer.toString("hex");

  return {
    publicKey: pubRaw.toString("hex"),
    privateKey: privHex,
  };
}

/** Sign manifest content with an Ed25519 private key */
export function signManifest(content: string, privateKeyHex: string): string {
  const { createPrivateKey } = await import("node:crypto");
  const keyObj = createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  });

  const signature = sign(null, Buffer.from(content, "utf8"), keyObj);
  return signature.toString("hex");
}
```

**Note:** The signer uses `node:crypto` Ed25519 support (available since Node 16). The private key is stored as PKCS8 DER hex for compatibility. During implementation, adjust the DER parsing if needed — the test verifies the round-trip behavior.

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/capabilities/signer.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/capabilities/
git commit -m "feat(core): add Ed25519 signing for skill manifests"
```

**Step 7: Write failing test for signature verification**

Create `packages/core/src/capabilities/verifier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { verifyManifestSignature } from "./verifier.js";
import { generateSigningKeyPair, signManifest } from "./signer.js";

describe("verifier", () => {
  it("accepts a valid signature", () => {
    const keyPair = generateSigningKeyPair();
    const content = JSON.stringify({ id: "test", version: "1.0.0" });
    const signature = signManifest(content, keyPair.privateKey);

    const result = verifyManifestSignature(content, signature, keyPair.publicKey);

    expect(result.valid).toBe(true);
  });

  it("rejects a tampered content", () => {
    const keyPair = generateSigningKeyPair();
    const content = JSON.stringify({ id: "test", version: "1.0.0" });
    const signature = signManifest(content, keyPair.privateKey);

    const tampered = JSON.stringify({ id: "test", version: "2.0.0" });
    const result = verifyManifestSignature(tampered, signature, keyPair.publicKey);

    expect(result.valid).toBe(false);
  });

  it("rejects a wrong public key", () => {
    const keyPair1 = generateSigningKeyPair();
    const keyPair2 = generateSigningKeyPair();
    const content = "some content";
    const signature = signManifest(content, keyPair1.privateKey);

    const result = verifyManifestSignature(content, signature, keyPair2.publicKey);

    expect(result.valid).toBe(false);
  });

  it("rejects an invalid signature format", () => {
    const keyPair = generateSigningKeyPair();
    const result = verifyManifestSignature("content", "not-hex", keyPair.publicKey);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

**Step 8: Run test, implement verifier, run test, commit**

Same TDD cycle. The verifier uses `crypto.verify()` with the Ed25519 public key.

**Step 9-12: Implement CapabilityRegistry**

The registry stores:
- Installed skill manifests (verified)
- Capability grants (user-approved)
- Pinned public keys (trusted signers)

TDD cycle: write test -> fail -> implement -> pass -> commit.

**Step 13-16: Implement CapabilityEnforcer**

The enforcer is called at tool-execution time to check:
1. Does the skill have a grant for this capability?
2. Do the constraints allow this specific operation?
3. If no grant, reject with a clear error.

TDD cycle: write test -> fail -> implement -> pass -> commit.

**Step 17: Update core index.ts**

```typescript
export { generateSigningKeyPair, signManifest } from "./capabilities/signer.js";
export { verifyManifestSignature } from "./capabilities/verifier.js";
export { CapabilityRegistry } from "./capabilities/registry.js";
export { CapabilityEnforcer } from "./capabilities/enforcer.js";
export type {
  Capability,
  CapabilityConstraints,
  CapabilityGrant,
  CapabilityWithConstraints,
  SkillManifest,
  ToolDefinition,
  VerifyResult,
} from "./capabilities/types.js";
```

**Step 18: Run all core tests**

Run: `pnpm vitest run packages/core/`
Expected: All PASS

**Step 19: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add capability system with signing, verification, registry, and enforcer"
```

---

## Phase 2: Core Runtime

Phase 2 builds the runtime that connects the security foundation (Phase 1) to actual LLM-powered agent behavior.

---

### Task 5: GitHub Copilot API Client (`@safeclaw/core`)

**Files:**
- Create: `packages/core/src/copilot/types.ts`
- Create: `packages/core/src/copilot/auth.ts`
- Create: `packages/core/src/copilot/auth.test.ts`
- Create: `packages/core/src/copilot/client.ts`
- Create: `packages/core/src/copilot/client.test.ts`
- Create: `packages/core/src/copilot/index.ts`

Implements:
- GitHub device flow OAuth authentication
- Model selection (Claude Opus 4.6 default, with fallback)
- Chat completions API (streaming + non-streaming)
- Tool calling support (function calling format)
- Rate limiting and retry logic

TDD cycle per module. Mock HTTP calls in tests.

**Commit:** `feat(core): add GitHub Copilot API client with device flow auth`

---

### Task 6: Session Manager (`@safeclaw/core`)

**Files:**
- Create: `packages/core/src/sessions/types.ts`
- Create: `packages/core/src/sessions/session.ts`
- Create: `packages/core/src/sessions/session.test.ts`
- Create: `packages/core/src/sessions/manager.ts`
- Create: `packages/core/src/sessions/manager.test.ts`
- Create: `packages/core/src/sessions/index.ts`

Implements:
- Per-channel-peer session isolation (default)
- Session lifecycle (create, resume, destroy)
- Conversation history storage (in-memory for v1, extensible)
- Session metadata (channel, peer identity, created/updated timestamps)

TDD cycle per module.

**Commit:** `feat(core): add session manager with per-channel-peer isolation`

---

### Task 7: Tool Orchestrator (`@safeclaw/core`)

**Files:**
- Create: `packages/core/src/tools/types.ts`
- Create: `packages/core/src/tools/orchestrator.ts`
- Create: `packages/core/src/tools/orchestrator.test.ts`
- Create: `packages/core/src/tools/index.ts`

Implements the critical path: **capability check -> sandbox -> execute -> return result**.

1. Receives a tool call from the agent
2. Looks up the tool's required capabilities
3. Checks grants via CapabilityEnforcer
4. Builds a SandboxPolicy from the capability constraints
5. Executes in sandbox
6. Returns result to agent

TDD cycle.

**Commit:** `feat(core): add tool orchestrator with capability-gated sandbox execution`

---

### Task 8: Agent Runtime (`@safeclaw/core`)

**Files:**
- Create: `packages/core/src/agent/types.ts`
- Create: `packages/core/src/agent/agent.ts`
- Create: `packages/core/src/agent/agent.test.ts`
- Create: `packages/core/src/agent/index.ts`

Implements:
- Main agent loop: receive message -> build prompt -> call Copilot API -> handle tool calls -> return response
- Streaming response support
- System prompt management (injection-resistant content wrapping)
- Multi-turn conversation with session history

TDD cycle.

**Commit:** `feat(core): add agent runtime with streaming and tool calling`

---

### Task 9: Gateway Server (`@safeclaw/gateway`)

**Files:**
- Create: `packages/gateway/src/types.ts`
- Create: `packages/gateway/src/auth.ts`
- Create: `packages/gateway/src/auth.test.ts`
- Create: `packages/gateway/src/server.ts`
- Create: `packages/gateway/src/server.test.ts`
- Create: `packages/gateway/src/rate-limit.ts`
- Create: `packages/gateway/src/rate-limit.test.ts`

**Dependencies:** `packages/gateway/package.json` adds:
```json
{
  "dependencies": {
    "@safeclaw/core": "workspace:*"
  }
}
```

Implements:
- WebSocket + HTTP server (using `ws` + Node `http`)
- Mandatory authentication (fail-closed — no `none` mode)
- Token validation (minimum 32 chars, constant-time comparison)
- Rate limiting (token bucket per client)
- Message routing to agent runtime
- Config validation at startup (refuse insecure configs)

TDD cycle per module.

**Commit:** `feat(gateway): add WS+HTTP server with mandatory auth and rate limiting`

---

## Phase 3: Channels & Skills

Phase 3 adds the user-facing channel adapters and the skill loading system.

---

### Task 10: Channel Adapter Interface + CLI Channel (`@safeclaw/cli`)

**Files:**
- Create: `packages/core/src/channels/types.ts`
- Create: `packages/core/src/channels/adapter.ts`
- Create: `packages/cli/src/adapter.ts`
- Create: `packages/cli/src/adapter.test.ts`
- Create: `packages/cli/src/commands/chat.ts`
- Create: `packages/cli/src/commands/chat.test.ts`
- Create: `packages/cli/src/commands/audit.ts`
- Create: `packages/cli/src/commands/skill.ts`
- Create: `packages/cli/src/main.ts`

**Dependencies:** `packages/cli/package.json` adds:
```json
{
  "dependencies": {
    "@safeclaw/core": "workspace:*",
    "@safeclaw/gateway": "workspace:*"
  }
}
```

Implements:
- `ChannelAdapter` interface in core (as defined in design doc)
- CLI adapter implementing `ChannelAdapter`
- Interactive chat command (readline-based)
- Audit command (list capability grants, session history)
- Skill management command (install, list, inspect, remove)
- Binary entry point (`safeclaw` command)

TDD cycle per module.

**Commit:** `feat(cli): add CLI channel adapter and commands`

---

### Task 11: Skill Loading System (`@safeclaw/core`)

**Files:**
- Create: `packages/core/src/skills/types.ts`
- Create: `packages/core/src/skills/loader.ts`
- Create: `packages/core/src/skills/loader.test.ts`
- Create: `packages/core/src/skills/installer.ts`
- Create: `packages/core/src/skills/installer.test.ts`
- Create: `packages/core/src/skills/index.ts`

Implements:
- Load skill manifest from disk
- Verify Ed25519 signature (reject unsigned unless `--allow-unsigned`)
- Parse and validate required capabilities
- Present capabilities to user for approval
- Register approved skills in CapabilityRegistry
- Load skill tools into Tool Orchestrator

TDD cycle.

**Commit:** `feat(core): add skill loader with signature verification and capability approval`

---

### Task 12: Built-in Tools (`skills/builtin/`)

**Files:**
- Create: `skills/builtin/manifest.json` (signed manifest for built-in tools)
- Create: `skills/builtin/src/read.ts`
- Create: `skills/builtin/src/write.ts`
- Create: `skills/builtin/src/edit.ts`
- Create: `skills/builtin/src/bash.ts`
- Create: `skills/builtin/src/web-fetch.ts`
- Create: `skills/builtin/src/index.ts`
- Create: `skills/builtin/src/read.test.ts`
- Create: `skills/builtin/src/write.test.ts`
- Create: `skills/builtin/src/edit.test.ts`
- Create: `skills/builtin/src/bash.test.ts`
- Create: `skills/builtin/src/web-fetch.test.ts`

Implements the 5 core tools. Each tool:
1. Declares its required capabilities in the manifest
2. Validates inputs
3. Executes via the sandbox
4. Returns structured output

Built-in tools are self-signed with a hard-coded key pair (trusted by default).

TDD cycle per tool.

**Commit:** `feat(skills): add built-in tools (read, write, edit, bash, web_fetch)`

---

### Task 13: WebChat Channel (`@safeclaw/webchat`)

**Files:**
- Create: `packages/webchat/src/adapter.ts`
- Create: `packages/webchat/src/adapter.test.ts`
- Create: `packages/webchat/src/static/index.html`
- Create: `packages/webchat/src/static/app.js`
- Create: `packages/webchat/src/static/style.css`

Implements:
- WebChat adapter implementing `ChannelAdapter`
- Static file serving from gateway
- WebSocket client in browser
- Minimal chat UI (input box, message list, markdown rendering)

TDD cycle for adapter. Manual testing for UI.

**Commit:** `feat(webchat): add WebChat channel adapter and SPA`

---

## Phase 4: Hardening & Polish

---

### Task 14: Security Test Suite

**Files:**
- Create: `test/security/sandbox-escape.test.ts`
- Create: `test/security/auth-bypass.test.ts`
- Create: `test/security/permission-escalation.test.ts`
- Create: `test/security/crypto-validation.test.ts`

Integration tests that verify:
- Sandbox actually blocks forbidden syscalls
- Auth cannot be bypassed
- Capability enforcer rejects undeclared operations
- Vault encryption actually works end-to-end (not just mocked)

**Commit:** `test(security): add security integration test suite`

---

### Task 15: Onboarding Wizard

**Files:**
- Create: `packages/cli/src/commands/onboard.ts`
- Create: `packages/cli/src/commands/onboard.test.ts`

Interactive first-run experience:
1. Check kernel capabilities
2. Authenticate with GitHub Copilot
3. Create vault with OS keyring or passphrase
4. Generate signing key pair
5. Select default model

**Commit:** `feat(cli): add onboarding wizard for first-run setup`

---

### Task 16: Audit CLI

**Files:**
- Modify: `packages/cli/src/commands/audit.ts`

Enhance the audit command:
- Show all installed skills and their capability grants
- Show active sessions
- Show recent tool executions with sandbox policies applied
- Export audit log as JSON

**Commit:** `feat(cli): enhance audit command with full security visibility`

---

### Task 17: Documentation

**Files:**
- Create: `docs/getting-started.md`
- Create: `docs/security-model.md`
- Create: `docs/skill-development.md`
- Create: `docs/architecture.md`

Document:
- Installation and first-run
- Security model and threat mitigations
- How to develop and sign skills
- Architecture overview

**Commit:** `docs: add getting started, security model, skill development, and architecture guides`

---

## Execution Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| Phase 1 | Tasks 1-4 | Foundation: scaffold, vault, sandbox, capabilities |
| Phase 2 | Tasks 5-9 | Core Runtime: Copilot client, sessions, tools, agent, gateway |
| Phase 3 | Tasks 10-13 | Channels & Skills: CLI, skill loading, built-in tools, WebChat |
| Phase 4 | Tasks 14-17 | Hardening: security tests, onboarding, audit, docs |

**Total tasks:** 17
**TDD throughout:** Every implementation task follows write-test -> fail -> implement -> pass -> commit.
**Estimated commits:** ~25-30 (frequent, small, focused)
