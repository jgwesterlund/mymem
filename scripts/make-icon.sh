#!/bin/bash
# App icon pipeline (v1.1) — Apple-stock toolchain only, no Xcode and no npm deps:
#   Swift JIT (make-icon.swift) → 1024² resources/icon.png (master, kept)
#   sips → iconset → iconutil → resources/icon.icns
# electron-builder picks resources/icon.icns up automatically (buildResources).
# Run: npm run icon   (or: bash scripts/make-icon.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

swift scripts/make-icon.swift resources/icon.png

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
iconset="$tmp/icon.iconset"
mkdir -p "$iconset"

# The EXACT 10 names iconutil accepts — note there is NO icon_64x64.png:
# the 64 px rep ships as icon_32x32@2x.png.
sips -z 16 16    resources/icon.png --out "$iconset/icon_16x16.png"      >/dev/null
sips -z 32 32    resources/icon.png --out "$iconset/icon_16x16@2x.png"   >/dev/null
sips -z 32 32    resources/icon.png --out "$iconset/icon_32x32.png"      >/dev/null
sips -z 64 64    resources/icon.png --out "$iconset/icon_32x32@2x.png"   >/dev/null
sips -z 128 128  resources/icon.png --out "$iconset/icon_128x128.png"    >/dev/null
sips -z 256 256  resources/icon.png --out "$iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256  resources/icon.png --out "$iconset/icon_256x256.png"    >/dev/null
sips -z 512 512  resources/icon.png --out "$iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512  resources/icon.png --out "$iconset/icon_512x512.png"    >/dev/null
cp resources/icon.png "$iconset/icon_512x512@2x.png"

iconutil -c icns "$iconset" -o resources/icon.icns
echo "wrote resources/icon.icns ($(du -h resources/icon.icns | cut -f1 | tr -d '[:space:]'))"
