#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Cleaning previous build artifacts..."
rm -rf bundle/ safeclaw-linux-x64.tar.gz
pnpm -r exec rm -rf dist

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building all packages..."
pnpm build

echo "==> Creating bundle staging directory..."
mkdir -p bundle/safeclaw

# Copy built package artifacts
for pkg in packages/*/; do
  pkg_name="$(basename "$pkg")"
  mkdir -p "bundle/safeclaw/packages/$pkg_name"

  # Copy dist output
  if [ -d "$pkg/dist" ]; then
    cp -r "$pkg/dist" "bundle/safeclaw/packages/$pkg_name/dist"
  fi

  # Copy package.json
  if [ -f "$pkg/package.json" ]; then
    cp "$pkg/package.json" "bundle/safeclaw/packages/$pkg_name/package.json"
  fi
done

# Ensure webchat static SPA files are included
if [ -d "packages/webchat/dist/static" ]; then
  echo "==> Including webchat static assets..."
fi

# Copy skills
mkdir -p bundle/safeclaw/skills/builtin
cp skills/builtin/manifest.json bundle/safeclaw/skills/builtin/manifest.json

# Copy root workspace files
cp package.json bundle/safeclaw/package.json
cp pnpm-workspace.yaml bundle/safeclaw/pnpm-workspace.yaml
cp pnpm-lock.yaml bundle/safeclaw/pnpm-lock.yaml

echo "==> Installing production dependencies in bundle..."
(cd bundle/safeclaw && pnpm install --prod --frozen-lockfile)

echo "==> Creating tarball..."
tar czf safeclaw-linux-x64.tar.gz -C bundle safeclaw

TARBALL_SIZE="$(du -h safeclaw-linux-x64.tar.gz | cut -f1)"
echo ""
echo "Bundle complete:"
echo "  Path: $(pwd)/safeclaw-linux-x64.tar.gz"
echo "  Size: $TARBALL_SIZE"
