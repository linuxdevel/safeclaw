#!/usr/bin/env bash
set -euo pipefail

# SafeClaw installer
# Usage: curl -fsSL https://raw.githubusercontent.com/linuxdevel/safeclaw/main/install.sh | bash
#   or:  curl -fsSL https://raw.githubusercontent.com/linuxdevel/safeclaw/main/install.sh | bash -s -- --force

REPO="linuxdevel/safeclaw"
INSTALL_DIR="$HOME/.safeclaw"
BIN_DIR="$INSTALL_DIR/bin"
MIN_NODE_VERSION=22
FORCE=false

# ---------------------------------------------------------------------------
# Color helpers (disabled when stdout is not a terminal)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BOLD=''
  RESET=''
fi

info()    { printf "${BOLD}%s${RESET}\n" "$*"; }
success() { printf "${GREEN}%s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}%s${RESET}\n" "$*"; }
error()   { printf "${RED}%s${RESET}\n" "$*" >&2; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) error "Unknown option: $arg"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# OS and architecture detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"
RAW_ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$RAW_ARCH" in
      x86_64)  PLATFORM="linux-x64"  ;;
      aarch64) PLATFORM="linux-arm64" ;;
      *)
        error "Error: Unsupported architecture: $RAW_ARCH"
        error "SafeClaw supports x86_64 and aarch64 on Linux."
        exit 1
        ;;
    esac
    ;;
  Darwin)
    case "$RAW_ARCH" in
      arm64)   PLATFORM="darwin-arm64" ;;
      x86_64)  PLATFORM="darwin-x64"   ;;
      *)
        error "Error: Unsupported architecture: $RAW_ARCH"
        error "SafeClaw supports arm64 and x86_64 on macOS."
        exit 1
        ;;
    esac
    ;;
  *)
    error "Error: Unsupported OS: $OS"
    error "SafeClaw supports Linux and macOS."
    exit 1
    ;;
esac
info "Detected platform: $OS/$RAW_ARCH (mapped to $PLATFORM)"

# ---------------------------------------------------------------------------
# Node.js version check (>= 22)
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  error "Error: Node.js is not installed (or not in PATH)."
  error ""
  error "SafeClaw requires Node.js >= $MIN_NODE_VERSION."
  error "Install it with one of the following methods:"
  error ""
  error "  # Using nvm (recommended):"
  error "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  error "  nvm install $MIN_NODE_VERSION"
  error ""
  if [ "$OS" = "Darwin" ]; then
    error "  # Using Homebrew:"
    error "  brew install node@$MIN_NODE_VERSION"
    error ""
  else
    error "  # Using NodeSource (Linux):"
    error "  curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x | sudo -E bash -"
    error "  sudo apt-get install -y nodejs"
    error ""
  fi
  error "  # Using fnm:"
  error "  curl -fsSL https://fnm.vercel.app/install | bash"
  error "  fnm install $MIN_NODE_VERSION"
  exit 1
fi

NODE_VERSION="$(node --version)"                 # e.g. v22.5.0
NODE_MAJOR="${NODE_VERSION#v}"                    # 22.5.0
NODE_MAJOR="${NODE_MAJOR%%.*}"                    # 22

if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ] 2>/dev/null; then
  error "Error: Node.js $NODE_VERSION is too old."
  error "SafeClaw requires Node.js >= $MIN_NODE_VERSION."
  error ""
  error "Upgrade with:"
  error "  nvm install $MIN_NODE_VERSION    # if using nvm"
  error "  fnm install $MIN_NODE_VERSION    # if using fnm"
  exit 1
fi
success "Node.js $NODE_VERSION detected — OK"

# ---------------------------------------------------------------------------
# Handle existing installation
#
# On upgrade we preserve user data (vault.json, vault.json.salt) and
# overwrite everything else.  --force skips the confirmation prompt.
# ---------------------------------------------------------------------------
VAULT_FILES=("vault.json" "vault.json.salt")

if [ -d "$INSTALL_DIR" ]; then
  if [ "$FORCE" != true ] && [ -t 0 ]; then
    warn "An existing SafeClaw installation was found at $INSTALL_DIR"
    printf "Upgrade in place? (vault data is preserved) [Y/n] "
    read -r REPLY
    case "$REPLY" in
      [nN]|[nN][oO])
        error "Aborted."
        exit 1
        ;;
    esac
  fi

  info "Upgrading existing installation..."

  # Back up vault files that exist
  VAULT_TMPDIR="$(mktemp -d)"
  for f in "${VAULT_FILES[@]}"; do
    if [ -f "$INSTALL_DIR/$f" ]; then
      cp -p "$INSTALL_DIR/$f" "$VAULT_TMPDIR/$f"
    fi
  done

  # Wipe the install directory
  rm -rf "$INSTALL_DIR"

  # Restore vault files (mkdir first since we just removed the dir)
  mkdir -p "$INSTALL_DIR"
  for f in "${VAULT_FILES[@]}"; do
    if [ -f "$VAULT_TMPDIR/$f" ]; then
      mv "$VAULT_TMPDIR/$f" "$INSTALL_DIR/$f"
    fi
  done
  rm -rf "$VAULT_TMPDIR"
fi

# ---------------------------------------------------------------------------
# Determine latest release tag
# ---------------------------------------------------------------------------
info "Fetching latest release information..."

API_URL="https://api.github.com/repos/$REPO/releases/latest"
RELEASE_JSON="$(curl -fsSL "$API_URL")" || {
  error "Error: Failed to fetch release information from GitHub."
  error "URL: $API_URL"
  exit 1
}

TAG="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
if [ -z "$TAG" ]; then
  error "Error: Could not determine the latest release tag."
  exit 1
fi
info "Latest release: $TAG"

# ---------------------------------------------------------------------------
# Download tarball
# ---------------------------------------------------------------------------
ASSET_NAME="safeclaw-${PLATFORM}.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$ASSET_NAME"
TMPDIR="$(mktemp -d)"
TARBALL="$TMPDIR/$ASSET_NAME"

# Ensure temp files are always cleaned up
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

info "Downloading $ASSET_NAME..."
curl -fSL --progress-bar -o "$TARBALL" "$DOWNLOAD_URL" || {
  error "Error: Failed to download $DOWNLOAD_URL"
  exit 1
}
success "Download complete."

# ---------------------------------------------------------------------------
# Extract to ~/.safeclaw (strip one level)
# ---------------------------------------------------------------------------
info "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
tar xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1

# ---------------------------------------------------------------------------
# Download sandbox helper binary (Linux only)
# ---------------------------------------------------------------------------
if [ "$OS" = "Linux" ]; then
  HELPER_ASSET="safeclaw-sandbox-helper-linux-${RAW_ARCH}"
  HELPER_URL="https://github.com/$REPO/releases/download/$TAG/$HELPER_ASSET"
  SHA_URL="https://github.com/$REPO/releases/download/$TAG/SHA256SUMS"

  info "Downloading sandbox helper..."
  HELPER_DL="$TMPDIR/$HELPER_ASSET"
  SHA_DL="$TMPDIR/SHA256SUMS"

  if curl -fSL --progress-bar -o "$HELPER_DL" "$HELPER_URL" 2>/dev/null && \
     curl -fsSL -o "$SHA_DL" "$SHA_URL" 2>/dev/null; then

      EXPECTED_HASH="$(grep "$HELPER_ASSET" "$SHA_DL" | awk '{print $1}')"
      ACTUAL_HASH="$(sha256sum "$HELPER_DL" | awk '{print $1}')"

      if [ -n "$EXPECTED_HASH" ] && [ "$EXPECTED_HASH" = "$ACTUAL_HASH" ]; then
          mkdir -p "$BIN_DIR"
          install -m755 "$HELPER_DL" "$BIN_DIR/safeclaw-sandbox-helper"
          success "Sandbox helper installed (SHA-256 verified)."
      else
          warn "Warning: Sandbox helper checksum mismatch — skipping."
          warn "Expected: $EXPECTED_HASH"
          warn "Actual:   $ACTUAL_HASH"
          warn "SafeClaw will run with namespace-only sandboxing."
      fi
  else
      warn "Sandbox helper not available for $RAW_ARCH — skipping."
      warn "SafeClaw will run with namespace-only sandboxing."
  fi
else
  info "Sandbox helper is Linux-only — skipping on macOS."
fi

# ---------------------------------------------------------------------------
# Create wrapper script
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/safeclaw" <<'WRAPPER'
#!/usr/bin/env bash
exec node ~/.safeclaw/packages/cli/dist/cli.js "$@"
WRAPPER
chmod +x "$BIN_DIR/safeclaw"

# ---------------------------------------------------------------------------
# PATH setup
# ---------------------------------------------------------------------------
PATH_LINE='export PATH="$HOME/.safeclaw/bin:$PATH"'
MODIFIED_CONFIGS=()

if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.safeclaw/bin" 2>/dev/null; then
  info "$BIN_DIR is already in PATH — skipping shell config update."
else
  # ~/.profile — always
  if [ -f "$HOME/.profile" ]; then
    if ! grep -qF '.safeclaw/bin' "$HOME/.profile" 2>/dev/null; then
      printf '\n# SafeClaw\n%s\n' "$PATH_LINE" >> "$HOME/.profile"
      MODIFIED_CONFIGS+=("~/.profile")
    fi
  else
    printf '# SafeClaw\n%s\n' "$PATH_LINE" > "$HOME/.profile"
    MODIFIED_CONFIGS+=("~/.profile (created)")
  fi

  # ~/.bashrc — if bash is installed
  if command -v bash &>/dev/null && [ -f "$HOME/.bashrc" ]; then
    if ! grep -qF '.safeclaw/bin' "$HOME/.bashrc" 2>/dev/null; then
      printf '\n# SafeClaw\n%s\n' "$PATH_LINE" >> "$HOME/.bashrc"
      MODIFIED_CONFIGS+=("~/.bashrc")
    fi
  fi

  # ~/.zshrc — if zsh is installed
  if command -v zsh &>/dev/null; then
    if [ -f "$HOME/.zshrc" ] && ! grep -qF '.safeclaw/bin' "$HOME/.zshrc" 2>/dev/null; then
      printf '\n# SafeClaw\n%s\n' "$PATH_LINE" >> "$HOME/.zshrc"
      MODIFIED_CONFIGS+=("~/.zshrc")
    fi
    # ~/.zprofile — login shells on macOS (Terminal.app opens login shells)
    if [ "$OS" = "Darwin" ]; then
      if [ -f "$HOME/.zprofile" ] && ! grep -qF '.safeclaw/bin' "$HOME/.zprofile" 2>/dev/null; then
        printf '\n# SafeClaw\n%s\n' "$PATH_LINE" >> "$HOME/.zprofile"
        MODIFIED_CONFIGS+=("~/.zprofile")
      fi
    fi
  fi

  if [ ${#MODIFIED_CONFIGS[@]} -gt 0 ]; then
    info "Added PATH entry to: ${MODIFIED_CONFIGS[*]}"
  fi
fi

# ---------------------------------------------------------------------------
# Verify installation
# ---------------------------------------------------------------------------
info "Verifying installation..."
SAFECLAW_VERSION="$("$BIN_DIR/safeclaw" version 2>&1)" && {
  success "Verification passed: $SAFECLAW_VERSION"
} || {
  warn "Warning: 'safeclaw version' exited with an error."
  warn "Output: $SAFECLAW_VERSION"
  warn "The installation may still be usable — check the output above."
}

# ---------------------------------------------------------------------------
# Success message
# ---------------------------------------------------------------------------
printf '\n'
success "============================================"
success "  SafeClaw installed successfully!"
success "============================================"
printf '\n'
info "Installation path: $INSTALL_DIR"
printf '\n'

if [ ${#MODIFIED_CONFIGS[@]} -gt 0 ]; then
  warn "To use safeclaw right away, run:"
  warn ""
  if [[ " ${MODIFIED_CONFIGS[*]} " == *"~/.bashrc"* ]]; then
    warn "  source ~/.bashrc"
  elif [[ " ${MODIFIED_CONFIGS[*]} " == *"~/.zshrc"* ]]; then
    warn "  source ~/.zshrc"
  else
    warn "  source ~/.profile"
  fi
  warn ""
  warn "Or restart your shell."
  printf '\n'
fi

info "Getting started:"
info "  safeclaw onboard   — first-time setup wizard"
info "  safeclaw chat      — interactive AI chat (CLI)"
info "  safeclaw serve     — start gateway + webchat server"
info "  safeclaw audit     — security audit"
info "  safeclaw help      — usage information"
info "  safeclaw version   — show version"
