import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionData } from "./types.js";

const SESSION_FILE_MODE = 0o600;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Persistence interface for session data.
 */
export interface SessionStore {
  save(data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

/**
 * Persists sessions as JSON files on disk.
 *
 * Layout: `{baseDir}/sessions/{id}.json`
 * File permissions: 0o600 (session history may contain sensitive data).
 */
export class FileSessionStore implements SessionStore {
  readonly #sessionsDir: string;

  constructor(baseDir: string) {
    this.#sessionsDir = join(baseDir, "sessions");
  }

  async save(data: SessionData): Promise<void> {
    this.#validateId(data.metadata.id);
    await mkdir(this.#sessionsDir, { recursive: true });
    const filePath = join(this.#sessionsDir, `${data.metadata.id}.json`);
    const json = JSON.stringify(data, null, 2);
    await writeFile(filePath, json, { encoding: "utf8", mode: SESSION_FILE_MODE });
  }

  async load(id: string): Promise<SessionData | null> {
    this.#validateId(id);
    const filePath = join(this.#sessionsDir, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as SessionData;
    // Reconstruct Date objects from ISO strings
    parsed.metadata.createdAt = new Date(parsed.metadata.createdAt);
    parsed.metadata.updatedAt = new Date(parsed.metadata.updatedAt);
    return parsed;
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -5));
  }

  async delete(id: string): Promise<void> {
    this.#validateId(id);
    const filePath = join(this.#sessionsDir, `${id}.json`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  #validateId(id: string): void {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(`Invalid session id: "${id}"`);
    }
  }
}
