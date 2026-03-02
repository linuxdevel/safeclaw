/**
 * Known-good SHA-256 hash of the safeclaw-sandbox-helper binary.
 *
 * Updated by the build/release process. If this hash does not match
 * the binary found on disk, the helper is not used and SafeClaw falls
 * back to namespace-only sandboxing.
 *
 * To update: sha256sum native/safeclaw-sandbox-helper
 */
export const KNOWN_HELPER_HASH =
  "sha256:132f0a73439ea47206f06e2ae1af19e82234eb63b49893f739b0f2cd11154cc6";
