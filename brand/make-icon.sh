#!/bin/bash
# Renders brand/icon-src.svg into app.icns. Run after changing the mark.
# Chrome headless is used only because macOS ships no SVG rasteriser; the
# result is a plain PNG set handed to iconutil.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome not found — skipping icon build"; exit 0; }

SET="$HERE/AppIcon.iconset"
rm -rf "$SET"; mkdir -p "$SET"

# Rendered through an HTML wrapper, not by pointing Chrome at the .svg.
# Chrome draws a standalone SVG at its intrinsic size and the window simply
# crops it, so every size was being built from the top-left corner of the
# artwork. Sizing it to the viewport here makes each screenshot the whole mark.
# Chrome draws an SVG at its INTRINSIC size and the window merely crops it —
# wrapping it in HTML did not change that. So each size gets its own copy of
# the SVG with width/height set to that size, and the window matches exactly.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  set -- $spec
  /usr/bin/sed "s|width=\"1024\" height=\"1024\"|width=\"$1\" height=\"$1\"|" \
    "$HERE/icon-src.svg" > "$TMP/i.svg"
  "$CHROME" --headless --disable-gpu --screenshot="$SET/$2.png" \
    --window-size=$1,$1 --force-device-scale-factor=1 \
    --default-background-color=00000000 \
    "file://$TMP/i.svg" >/dev/null 2>&1
done

iconutil -c icns "$SET" -o "$HERE/../app.icns"
rm -rf "$SET"
echo "app.icns written ($(du -h "$HERE/../app.icns" | cut -f1))"
