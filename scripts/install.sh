#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${1:-dist/gpt-niri-voice}"
TARGET_DIR="${2:-$HOME/.local/bin}"
TARGET_PATH="$TARGET_DIR/gpt-niri-voice"

if [[ ! -f "$SOURCE_PATH" ]]; then
  printf 'Binary not found: %s\n' "$SOURCE_PATH" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
install -m 755 "$SOURCE_PATH" "$TARGET_PATH"

printf 'Installed %s\n' "$TARGET_PATH"

case ":$PATH:" in
  *":$TARGET_DIR:"*) ;;
  *) printf 'Add %s to PATH to run gpt-niri-voice globally.\n' "$TARGET_DIR" ;;
esac
