# Skill Development

Skills extend SafeClaw with new tools. Each skill is defined by a manifest that declares its identity, required capabilities, and tools. Skills must be signed with Ed25519 to be installed (unless `--allow-unsigned` is used for development).

## Skill manifest format

A skill manifest is a JSON file with this structure:

```json
{
  "id": "my-skill",
  "version": "1.0.0",
  "name": "My Skill",
  "description": "What this skill does",
  "signature": "<hex-encoded Ed25519 signature>",
  "publicKey": "<hex-encoded 32-byte public key>",
  "requiredCapabilities": [
    {
      "capability": "fs:read",
      "constraints": { "paths": ["/home/user/data"] },
      "reason": "Read data files for processing"
    }
  ],
  "tools": [
    {
      "name": "my_tool",
      "description": "What this tool does",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "Input data" }
        },
        "required": ["input"]
      }
    }
  ]
}
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the skill. Must be non-empty. |
| `version` | string | Semantic version string. Must be non-empty. |
| `name` | string | Human-readable name. Must be non-empty. |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | What the skill does |
| `signature` | string | Hex-encoded Ed25519 signature (required unless `--allow-unsigned`) |
| `publicKey` | string | Hex-encoded 32-byte Ed25519 public key |
| `requiredCapabilities` | array | Capabilities the skill needs |
| `tools` | array | Tools the skill provides |

## Capability types

Each capability controls access to a specific resource. Declare only the capabilities your skill actually needs.

| Capability | What it controls | Constraint type |
|-----------|-----------------|----------------|
| `fs:read` | Reading files from disk | `paths`: allowed path prefixes |
| `fs:write` | Writing files to disk | `paths`: allowed path prefixes |
| `net:http` | Making HTTP requests | `hosts`: allowed hostnames |
| `net:https` | Making HTTPS requests | `hosts`: allowed hostnames |
| `process:spawn` | Spawning child processes | `executables`: allowed executable names |
| `env:read` | Reading environment variables | (none) |
| `secret:read` | Reading secrets from the vault | (none) |
| `secret:write` | Writing secrets to the vault | (none) |

## Constraints

Constraints narrow the scope of a capability to specific resources. Using constraints is strongly recommended — they limit the blast radius if a skill is compromised.

### Path constraints

Applies to `fs:read` and `fs:write`. Paths are checked with prefix matching.

```json
{
  "capability": "fs:read",
  "constraints": { "paths": ["/home/user/projects", "/tmp/safeclaw"] },
  "reason": "Read project files and temporary data"
}
```

A grant for `/home/user/projects` allows access to any file under that directory (e.g., `/home/user/projects/src/main.ts`). It does not allow access to `/home/user/documents`.

### Host constraints

Applies to `net:http` and `net:https`. Hosts are matched exactly (not prefix).

```json
{
  "capability": "net:https",
  "constraints": { "hosts": ["api.github.com", "registry.npmjs.org"] },
  "reason": "Fetch package metadata"
}
```

### Executable constraints

Applies to `process:spawn`. Executables are matched exactly.

```json
{
  "capability": "process:spawn",
  "constraints": { "executables": ["git", "node"] },
  "reason": "Run git and node commands"
}
```

## Tool definition format

Each tool in the `tools` array defines a function the LLM can call:

```json
{
  "name": "search_files",
  "description": "Search for files matching a glob pattern",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "Glob pattern to match files"
      },
      "directory": {
        "type": "string",
        "description": "Root directory to search from"
      }
    },
    "required": ["pattern"]
  }
}
```

Tool names must be unique within a skill. The `parameters` object follows JSON Schema conventions and is passed to the LLM for function calling.

## Signing your skill

### Step 1: Generate a key pair

If you haven't already generated a key pair during onboarding, generate one programmatically:

```typescript
import { generateSigningKeyPair } from "@safeclaw/core";

const { publicKey, privateKey } = generateSigningKeyPair();
// publicKey: hex string (32-byte Ed25519 public key)
// privateKey: hex string (PKCS#8 DER-encoded private key)

console.log("Public key:", publicKey);
console.log("Private key:", privateKey);
// Store the private key securely. It is saved in the vault during onboarding.
```

### Step 2: Create the manifest without signature

Write your manifest with all fields except `signature`:

```json
{
  "id": "my-skill",
  "version": "1.0.0",
  "name": "My Skill",
  "description": "Example skill",
  "publicKey": "<your-public-key-hex>",
  "requiredCapabilities": [],
  "tools": []
}
```

### Step 3: Sign the manifest

The signing process:

1. Remove the `signature` field (if present).
2. Serialize the remaining fields as JSON with keys sorted alphabetically.
3. Sign the serialized JSON with Ed25519.

```typescript
import { signManifest } from "@safeclaw/core";

// manifest is the object WITHOUT the signature field
const { signature: _, ...manifestWithoutSignature } = manifest;
const canonical = JSON.stringify(
  manifestWithoutSignature,
  Object.keys(manifestWithoutSignature).sort()
);

const signature = signManifest(canonical, privateKeyHex);
// signature: hex-encoded Ed25519 signature

// Add the signature to the manifest
manifest.signature = signature;
```

### Step 4: Save the signed manifest

Write the complete manifest (with `signature`) to a JSON file:

```json
{
  "id": "my-skill",
  "version": "1.0.0",
  "name": "My Skill",
  "description": "Example skill",
  "signature": "<hex-encoded-signature>",
  "publicKey": "<your-public-key-hex>",
  "requiredCapabilities": [],
  "tools": []
}
```

## Installing skills

Skills are loaded and installed through the `SkillLoader` and `SkillInstaller`:

```typescript
import {
  SkillLoader,
  SkillInstaller,
  CapabilityRegistry,
} from "@safeclaw/core";

const registry = new CapabilityRegistry();
const loader = new SkillLoader();
const installer = new SkillInstaller(registry);

// Load from file
const result = loader.loadFromFile("path/to/manifest.json");
if (!result.success) {
  console.error("Failed to load:", result.error);
  process.exit(1);
}

// Install (verifies signature, registers skill)
const manifest = installer.install(result.manifest, {
  allowUnsigned: false,  // default: reject unsigned
  autoApprove: false,    // default: don't auto-approve capabilities
});
```

### Install options

| Option | Default | Effect |
|--------|---------|--------|
| `allowUnsigned` | `false` | If `true`, allow skills without a `signature` field |
| `autoApprove` | `false` | If `true`, automatically grant all requested capabilities (used for built-in skills) |

When `autoApprove` is `false`, capabilities must be explicitly granted after installation:

```typescript
registry.grantCapability({
  skillId: "my-skill",
  capability: "fs:read",
  constraints: { paths: ["/home/user/data"] },
  grantedAt: new Date(),
  grantedBy: "user",
});
```

## Testing skills

### Verify the manifest loads

```typescript
const loader = new SkillLoader();
const result = loader.loadFromString(JSON.stringify(manifest));
console.log(result.success); // true
```

### Verify the signature

```typescript
import { verifyManifestSignature } from "@safeclaw/core";

const { signature, publicKey, ...rest } = manifest;
const canonical = JSON.stringify(rest, Object.keys(rest).sort());
const result = verifyManifestSignature(canonical, signature, publicKey);
console.log(result.valid); // true
```

### Test capability enforcement

```typescript
import {
  CapabilityRegistry,
  CapabilityEnforcer,
  SkillInstaller,
} from "@safeclaw/core";

const registry = new CapabilityRegistry();
const enforcer = new CapabilityEnforcer(registry);
const installer = new SkillInstaller(registry);

// Install and grant capabilities
installer.install(manifest, { autoApprove: true });

// Test enforcement
enforcer.check("my-skill", "fs:read", { path: "/home/user/data/file.txt" });
// No error = allowed

try {
  enforcer.check("my-skill", "fs:read", { path: "/etc/passwd" });
} catch (err) {
  console.log(err.message); // Capability denied: path not in allowed paths
}
```

## Best practices

### Minimal capabilities

Declare only the capabilities your skill needs. A skill that reads files from a single directory should not request `fs:write` or unrestricted `fs:read`.

```json
// Good: specific path constraint
{
  "capability": "fs:read",
  "constraints": { "paths": ["/home/user/notes"] },
  "reason": "Read user notes for summarization"
}

// Bad: no constraint (unrestricted read access)
{
  "capability": "fs:read",
  "reason": "Read files"
}
```

### Specific constraints

Use the narrowest constraints possible:

- Prefer specific paths over broad directories.
- List only the hosts your skill actually contacts.
- Name only the executables your skill spawns.

### Meaningful reasons

The `reason` field explains to the user why your skill needs each capability. Write clear, specific reasons:

```json
// Good
"reason": "Read CSV files from the data directory for analysis"

// Bad
"reason": "Needs file access"
```

### Version your manifests

Use semantic versioning. When you change capabilities or tools, bump the version. Users reviewing capability grants can see what changed.

### Keep private keys secure

- During onboarding, the private key is stored in the encrypted vault.
- Never commit private keys to version control.
- Never embed private keys in manifest files.
- If a key is compromised, generate a new pair and re-sign all manifests.
