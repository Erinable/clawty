#!/usr/bin/env bash
set -euo pipefail

KEEP_CONFIG=false
SKIP_NPM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-config)
      KEEP_CONFIG=true
      shift
      ;;
    --skip-npm)
      SKIP_NPM=true
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Usage: uninstall.sh [options]

Options:
  --keep-config  keep ~/.clawty
  --skip-npm     skip npm uninstall -g clawty
  -h, --help     show help
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$SKIP_NPM" != "true" ]]; then
  npm uninstall -g clawty || true
fi

rm -rf "$HOME/.clawty/bin"
if [[ "$KEEP_CONFIG" != "true" ]]; then
  rm -rf "$HOME/.clawty"
fi

echo "clawty removed"
