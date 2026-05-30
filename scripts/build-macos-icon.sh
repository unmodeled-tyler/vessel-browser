#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PNG="${1:-$ROOT_DIR/resources/vessel-icon.png}"
OUTPUT_ICNS="${2:-$ROOT_DIR/resources/vessel-icon.icns}"

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required to generate macOS icon assets" >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required to generate macOS icon assets" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/vessel-icon.XXXXXX")"
resized_png="$tmp_dir/vessel-icon-resized.png"
square_png="$tmp_dir/vessel-icon-square.png"
iconset_dir="$tmp_dir/vessel-icon.iconset"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

# Center the existing transparent logo on a square canvas before exporting the
# iconset sizes iconutil expects for a macOS .icns bundle.
sips -Z 860 "$SOURCE_PNG" --out "$resized_png" >/dev/null
sips -p 1024 1024 "$resized_png" --out "$square_png" >/dev/null

mkdir -p "$iconset_dir"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$square_png" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  sips -z "$retina_size" "$retina_size" "$square_png" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$iconset_dir" -o "$OUTPUT_ICNS"
echo "Generated $OUTPUT_ICNS"
