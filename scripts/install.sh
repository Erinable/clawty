#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${CLAWTY_INSTALL_CHANNEL:-npm}"
VERSION="latest"
BINARY_URL="${CLAWTY_BINARY_URL:-}"
BIN_DIR="${CLAWTY_BIN_DIR:-$HOME/.clawty/bin}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --binary-url)
      BINARY_URL="${2:-}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'HELP'
Usage: install.sh [options]

Options:
  --channel <npm|binary>  install channel (default: npm)
  --version <version>     npm package version (default: latest)
  --binary-url <url>      download URL when channel=binary
  --bin-dir <path>        binary install dir (default: ~/.clawty/bin)
  -h, --help              show help
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$CHANNEL" == "npm" ]]; then
  echo "Installing clawty via npm (version: $VERSION)..."
  npm install -g "clawty@$VERSION"
  echo "Install complete. Run: clawty --help"
  exit 0
fi

if [[ "$CHANNEL" != "binary" ]]; then
  echo "Unsupported channel: $CHANNEL" >&2
  exit 1
fi

if [[ -z "$BINARY_URL" ]]; then
  echo "Binary install requires --binary-url or CLAWTY_BINARY_URL" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BINARY_URL" -o "$TMP_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_FILE" "$BINARY_URL"
else
  echo "curl or wget is required for binary install" >&2
  exit 1
fi

install -m 0755 "$TMP_FILE" "$BIN_DIR/clawty"
echo "Installed clawty to $BIN_DIR/clawty"
echo "Add to PATH if needed: export PATH=\"$BIN_DIR:\$PATH\""
