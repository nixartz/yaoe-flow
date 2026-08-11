#!/usr/bin/env bash
# YAOE-FLOW one-line installer — Linux/macOS. Detects OS+architecture,
# downloads the right binary from the latest GitHub release (or updates an
# existing install), validates the checksum and installs it on the PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/nixartz/yaoe-flow/main/scripts/install.sh | bash
#
# Env vars:
#   YAOE_RELEASE_REPO   release owner/repo (default: nixartz/yaoe-flow)
#   YAOE_VERSION        pin a version (e.g. v0.1.0) — default: latest
#   YAOE_INSTALL_DIR    custom destination (default: /usr/local/bin or ~/.local/bin)
#   YAOE_DRY_RUN=1      show what would happen without downloading/installing
#   YAOE_FORCE_BASELINE force the AVX2 auto-detection below (1 = baseline
#                       asset, 0 = standard asset) — only meaningful on x64
set -euo pipefail

REPO="${YAOE_RELEASE_REPO:-nixartz/yaoe-flow}"
TAG="${YAOE_VERSION:-}" # empty = latest
DRY_RUN="${YAOE_DRY_RUN:-}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *)
    echo "OS not supported by this script: $os (Windows: use install.ps1)" >&2
    exit 1
    ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac
asset="yaoe-flow-$os-$arch"

# The x64 binaries ship in two flavors: the standard one needs a CPU with
# AVX2 (Haswell/2013+ — Bun's compiled binaries use it unconditionally and
# crash with "Illegal instruction" on older CPUs, e.g. pre-2013 Intel Macs);
# "-baseline" targets Nehalem/2008+ instead, no AVX2 required. arm64 has no
# such split (Apple Silicon / ARM servers don't hit this).
has_avx2() {
  case "$os" in
    linux) grep -qm1 '\bavx2\b' /proc/cpuinfo 2>/dev/null ;;
    darwin) sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2 ;;
    *) return 0 ;; # unknown probe — assume modern, matches prior behavior
  esac
}
if [ "$arch" = "x64" ]; then
  case "${YAOE_FORCE_BASELINE:-}" in
    1) asset="${asset}-baseline" ;;
    0) ;;
    *)
      if ! has_avx2; then
        echo "ℹ️  CPU lacks AVX2 — using the baseline build (set YAOE_FORCE_BASELINE=0 to override)"
        asset="${asset}-baseline"
      fi
      ;;
  esac
fi

# Bun-compiled Linux binaries link against glibc >= 2.17 (RHEL7/Ubuntu 14.04+
# era) and are NOT musl-compatible — Alpine/Void and other musl distros need a
# different build that isn't in the release matrix today. Advisory only (no
# fallback asset exists, unlike AVX2): the point is to name the exact symptom
# ("Illegal instruction"/dynamic-linker error, not a normal error message) so
# a bug report is diagnosable instead of a mystery crash after install.
if [ "$os" = linux ] && [ -z "${YAOE_SKIP_GLIBC_CHECK:-}" ]; then
  glibc_ver=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  if [ -z "$glibc_ver" ]; then
    glibc_ver=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
  fi
  if [ -n "$glibc_ver" ]; then
    glibc_major=${glibc_ver%%.*}
    glibc_minor=${glibc_ver#*.}
    glibc_minor=${glibc_minor%%.*}
    if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 17 ]; }; then
      echo "⚠️  glibc $glibc_ver detected (need >= 2.17) — this binary will likely fail to start with a" >&2
      echo "   dynamic-linker error, not a normal error message. musl distros (Alpine, Void) are not" >&2
      echo "   supported by this installer. Set YAOE_SKIP_GLIBC_CHECK=1 to silence this and proceed anyway." >&2
    fi
  else
    echo "ℹ️  could not detect glibc version — proceeding (set YAOE_SKIP_GLIBC_CHECK=1 to silence this check)" >&2
  fi
fi

api="https://api.github.com/repos/$REPO/releases"
if [ -z "$TAG" ]; then
  # No -f: a 404 (repo without a release yet) falls through to the friendly
  # "-z TAG" message below instead of aborting with a raw curl error (set -e).
  TAG=$(curl -sSL "$api/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)
fi
if [ -z "$TAG" ]; then
  echo "❌ no release found in $REPO — has the release pipeline run yet?" >&2
  exit 1
fi
base="https://github.com/$REPO/releases/download/$TAG"

if [ -n "$DRY_RUN" ]; then
  echo "[dry-run] would download $asset ($TAG) from $base and install into \${YAOE_INSTALL_DIR:-/usr/local/bin or ~/.local/bin}"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

download() {
  # Simple retry (3 attempts) — the one-liner runs on freshly provisioned VMs,
  # where a transient network failure should not abort the setup.
  local url="$1" out="$2" attempt
  for attempt in 1 2 3; do
    if curl -fsSL --retry 2 -o "$out" "$url"; then return 0; fi
    echo "  attempt $attempt failed, retrying in 2s..." >&2
    sleep 2
  done
  echo "❌ failed to download $url after 3 attempts" >&2
  return 1
}

echo "Downloading $asset ($TAG)…"
download "$base/$asset" "$tmp/$asset"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

(cd "$tmp" && grep " $asset\$" SHA256SUMS | shasum -a 256 -c -) || {
  echo "❌ invalid checksum — aborting (nothing installed)" >&2
  exit 1
}

dir="${YAOE_INSTALL_DIR:-/usr/local/bin}"
if [ ! -w "$dir" ] 2>/dev/null; then
  dir="$HOME/.local/bin"
  mkdir -p "$dir"
fi

previous=""
if [ -x "$dir/yaoe-flow" ]; then
  previous=$("$dir/yaoe-flow" version 2>/dev/null | head -1 || true)
fi

install -m 0755 "$tmp/$asset" "$dir/yaoe-flow"

# macOS without notarization: remove the quarantine flag from the downloaded
# binary, otherwise Gatekeeper blocks execution — documented and printed here.
if [ "$os" = darwin ]; then
  if xattr -d com.apple.quarantine "$dir/yaoe-flow" 2>/dev/null; then
    echo "ℹ️  quarantine flag removed (binary is not notarized yet)"
  fi
fi

echo ""
if [ -n "$previous" ]; then
  echo "✅ updated: $dir/yaoe-flow ($TAG)"
  echo "   previous: $previous"
else
  echo "✅ installed: $dir/yaoe-flow ($TAG)"
fi
echo "📦 Executable location: $dir/yaoe-flow"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "⚠️  $dir is not on your PATH — add it before running \"yaoe-flow\" (e.g. export PATH=\"$dir:\$PATH\")" ;;
esac

echo "
Next steps:
  yaoe-flow setup     # first-run guided wizard (config lives in ~/.yaoe-flow)
  yaoe-flow daemon -d # start the service in the background
  yaoe-flow status    # quick health check

To update later: re-run this installer (idempotent) or \"yaoe-flow update\".
To uninstall:
  yaoe-flow stop            # stop the daemon (if running)
  rm $dir/yaoe-flow         # remove the executable
  rm -rf ~/.yaoe-flow       # remove config/data/logs/worktrees (irreversible)"
