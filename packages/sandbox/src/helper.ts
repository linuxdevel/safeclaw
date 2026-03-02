import { accessSync, constants } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HELPER_NAME = "safeclaw-sandbox-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// TODO: Re-add SHA-256 integrity verification of the helper binary.
// The hash was removed because builds are not yet reproducible — the binary
// hash changes across compiler versions and build environments, and neither
// ci.yml nor release.yml updates the embedded hash. Once we have reproducible
// builds or a release process that stamps the hash, re-introduce verification
// so that a tampered helper binary is detected before use.

export function findHelper(): string | undefined {
  const candidates: string[] = [];

  // 1. Environment variable
  const envPath = process.env["SAFECLAW_HELPER_PATH"];
  if (envPath !== undefined) {
    candidates.push(envPath);
  }

  // 2. Co-located path (from src/ or dist/ → ../../../native/)
  const colocated = resolve(__dirname, "..", "..", "..", "native", HELPER_NAME);
  candidates.push(colocated);

  // 3. Installed path (~/.safeclaw/bin/)
  const home = process.env["HOME"];
  if (home !== undefined) {
    candidates.push(join(home, ".safeclaw", "bin", HELPER_NAME));
  }

  // Check each candidate
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // 4. System PATH via `which`
  try {
    const result = execFileSync("which", [HELPER_NAME], {
      encoding: "utf8",
    });
    const whichPath = result.trim();
    if (whichPath.length > 0) {
      return whichPath;
    }
  } catch {
    // not found on PATH
  }

  return undefined;
}
