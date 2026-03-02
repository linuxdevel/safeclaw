export { Vault } from "./vault.js";
export { KeyringProvider } from "./keyring.js";
export { encrypt, decrypt, deriveKeyFromPassphrase } from "./crypto.js";
export {
  assertFilePermissions,
  assertDirectoryPermissions,
  PermissionError,
} from "./permissions.js";
export type {
  VaultFile,
  VaultOptions,
  EncryptedEntry,
  KeySource,
  UnlockResult,
} from "./types.js";
