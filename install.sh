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
# OS check — Linux only for v1
# ---------------------------------------------------------------------------
OS="$(uname -s)"
if [ "$OS" != "Linux" ]; then
  error "Error: SafeClaw currently supports Linux only."
  error "Detected OS: $OS"
  error "macOS and Windows support is planned for a future release."
  exit 1
fi

# ---------------------------------------------------------------------------
# Architecture detection
# ---------------------------------------------------------------------------
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  x86_64)  ARCH="x64"   ;;
  aarch64) ARCH="arm64"  ;;
  *)
    error "Error: Unsupported architecture: $RAW_ARCH"
    error "SafeClaw supports x86_64 (x64) and aarch64 (arm64)."
    exit 1
    ;;
esac
info "Detected architecture: $RAW_ARCH (mapped to $ARCH)"

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
  error "  # Using NodeSource:"
  error "  curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x | sudo -E bash -"
  error "  sudo apt-get install -y nodejs"
  error ""
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
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR" ]; then
  if [ "$FORCE" = true ]; then
    warn "Removing existing installation at $INSTALL_DIR (--force)"
    rm -rf "$INSTALL_DIR"
  else
    warn "An existing SafeClaw installation was found at $INSTALL_DIR"
    printf "Remove it and reinstall? [y/N] "
    # When piped, stdin may not be a terminal — default to abort
    if [ -t 0 ]; then
      read -r REPLY
    else
      REPLY=""
    fi
    case "$REPLY" in
      [yY]|[yY][eE][sS])
        rm -rf "$INSTALL_DIR"
        ;;
      *)
        error "Aborted. Re-run with --force to skip this prompt."
        exit 1
        ;;
    esac
  fi
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
ASSET_NAME="safeclaw-linux-${ARCH}.tar.gz"
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
