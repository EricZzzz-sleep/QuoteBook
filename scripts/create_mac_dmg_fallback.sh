#!/usr/bin/env bash
set -euo pipefail

arch="${MAC_ARCH:-$(uname -m)}"
if [[ "$arch" == "x86_64" ]]; then
  arch="x64"
fi

dmg_path="dist/QuoteBook-mac-${arch}.dmg"

if [[ -f "$dmg_path" ]]; then
  echo "$dmg_path already exists."
  exit 0
fi

app_path="$(find dist -maxdepth 3 -type d -name 'QuoteBook.app' | head -n 1)"
if [[ -z "$app_path" ]]; then
  echo "Could not find QuoteBook.app under dist/."
  find dist -maxdepth 3 -print || true
  exit 1
fi

echo "Creating fallback DMG from $app_path"
rm -f "$dmg_path"
hdiutil create \
  -volname "QuoteBook" \
  -srcfolder "$app_path" \
  -ov \
  -format UDZO \
  "$dmg_path"
