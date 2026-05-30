#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="${1:-}"

if ! command -v lipo >/dev/null 2>&1; then
  echo "lipo is required to verify macOS universal binaries" >&2
  exit 1
fi

if [[ -z "$APP_PATH" ]]; then
  for candidate in "$ROOT_DIR"/dist/mac-universal/*.app "$ROOT_DIR"/dist/mac/*.app; do
    if [[ -d "$candidate" ]]; then
      APP_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "No macOS .app bundle found. Pass the .app path or build with npm run dist:mac:dir." >&2
  exit 1
fi

APP_NAME="$(basename "$APP_PATH" .app)"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/$APP_NAME"
ELECTRON_FRAMEWORK="$APP_PATH/Contents/Frameworks/Electron Framework.framework/Electron Framework"

verify_universal_binary() {
  local path="$1"
  local label="$2"

  if [[ ! -f "$path" ]]; then
    echo "Missing $label at $path" >&2
    exit 1
  fi

  local info
  info="$(lipo -info "$path")"
  echo "$label: $info"

  if [[ "$info" != *"x86_64"* || "$info" != *"arm64"* ]]; then
    echo "$label is not universal. Expected both x86_64 and arm64 slices." >&2
    exit 1
  fi
}

verify_universal_binary "$APP_EXECUTABLE" "App executable"
verify_universal_binary "$ELECTRON_FRAMEWORK" "Electron framework"

echo "Verified universal macOS app: $APP_PATH"
