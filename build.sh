#!/bin/bash
# Builds "Adobe MCP.app" — a self-contained, double-clickable control panel that
# lets Claude and ChatGPT drive Adobe apps. Everything it needs (Node, uv, the
# adb-mcp engine) is downloaded once and packed inside, so the person who
# receives the app installs nothing.
#
#   ./build.sh
set -euo pipefail

NODE_VERSION="22.14.0"
ADB_MCP="https://github.com/mikechambers/adb-mcp/archive/refs/heads/main.zip"

HERE="$(cd "$(dirname "$0")" && pwd)"
# Universal, always. Building thin for whatever Mac happened to run this script
# meant an Intel colleague downloaded an app that could not launch at all.
ARCH="universal"
VER="$(/usr/bin/sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)"
APP="$HERE/dist/Adobe MCP.app"
RES="$APP/Contents/Resources"

say() { printf '\033[1m→\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- runtimes --
# Both slices are fetched and lipo'd together, so one download serves every Mac.
mkdir -p "$HERE/runtime"

if [ ! -x "$HERE/runtime/node" ]; then
  for slice in arm64 x64; do
    say "Downloading Node $NODE_VERSION ($slice)"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$slice.tar.gz" \
      | tar -xz -C "$HERE/runtime" --strip-components=2 "node-v$NODE_VERSION-darwin-$slice/bin/node"
    mv "$HERE/runtime/node" "$HERE/runtime/node-$slice"
  done
  lipo -create "$HERE/runtime/node-arm64" "$HERE/runtime/node-x64" -output "$HERE/runtime/node"
  rm -f "$HERE/runtime/node-arm64" "$HERE/runtime/node-x64"
fi

if [ ! -x "$HERE/runtime/uv" ]; then
  for slice in aarch64 x86_64; do
    say "Downloading uv ($slice)"
    curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$slice-apple-darwin.tar.gz" \
      | tar -xz -C "$HERE/runtime" --strip-components=1
    rm -f "$HERE/runtime/uvx"
    mv "$HERE/runtime/uv" "$HERE/runtime/uv-$slice"
  done
  lipo -create "$HERE/runtime/uv-aarch64" "$HERE/runtime/uv-x86_64" -output "$HERE/runtime/uv"
  rm -f "$HERE/runtime/uv-aarch64" "$HERE/runtime/uv-x86_64"
fi
chmod +x "$HERE/runtime/node" "$HERE/runtime/uv"

# A thin binary here would silently ship a broken app to half the audience.
for bin in node uv; do
  slices="$(lipo -archs "$HERE/runtime/$bin")"
  case "$slices" in
    *arm64*x86_64*|*x86_64*arm64*) ;;
    *) echo "runtime/$bin is not universal (got: $slices). Delete it and re-run."; exit 1 ;;
  esac
done

# ------------------------------------------------------------------ engine --
# adb-mcp by Mike Chambers (MIT) does the actual talking to the Adobe apps.
if [ ! -f "$HERE/engine/mcp/core.py" ]; then
  say "Downloading the adb-mcp engine"
  tmp="$(mktemp -d)"
  curl -fsSL "$ADB_MCP" -o "$tmp/adb.zip"
  unzip -q "$tmp/adb.zip" -d "$tmp"
  mkdir -p "$HERE/engine"
  for d in mcp cep uxp; do cp -R "$tmp/adb-mcp-main/$d" "$HERE/engine/"; done
  cp "$tmp/adb-mcp-main/LICENSE.md" "$HERE/engine/LICENSE.md"
  rm -rf "$tmp" "$HERE/engine/mcp/__pycache__"
fi

# ------------------------------------------------------- panel Ask buttons --
# Inject our "Ask Claude / ChatGPT" row into the CEP panels. Done by appending a
# script tag rather than editing their markup, so an engine update can't break it.
say "Adding the Ask buttons to the panels"
for panel in "$HERE"/engine/cep/*/; do
  cp "$HERE/panel-addon.js" "$panel/panel-addon.js"
  if ! grep -q "panel-addon.js" "$panel/index.html"; then
    /usr/bin/sed -i '' 's|</body>|    <script src="panel-addon.js"></script>\
</body>|' "$panel/index.html"
  fi
done

[ -d "$HERE/node_modules" ] || { say "Installing hub dependencies"; npm install --silent; }

# ----------------------------------------------------------------- bundle ---
say "Assembling the app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$RES"
cp "$HERE/hub.js" "$HERE/index.html" "$HERE/package.json" "$RES/"
# A stray .venv from running the engine locally would double the app's size.
rm -rf "$HERE/engine/mcp/.venv" "$HERE/engine/mcp/__pycache__"
cp -R "$HERE/node_modules" "$HERE/runtime" "$HERE/engine" "$RES/"

# A menu bar icon is the only way to reach a background app once its browser tab
# is closed. Needs Xcode Command Line Tools; without them fall back to a plain
# launcher (works, but invisible once the tab is shut).
if command -v swiftc >/dev/null 2>&1; then
  say "Compiling the menu bar app"
  # swiftc emits one architecture per invocation, so build both and lipo them.
  swiftc -O -target arm64-apple-macos12  -o "$HERE/dist/.mb-arm64" "$HERE/menubar.swift"
  swiftc -O -target x86_64-apple-macos12 -o "$HERE/dist/.mb-x64"   "$HERE/menubar.swift"
  lipo -create "$HERE/dist/.mb-arm64" "$HERE/dist/.mb-x64" -output "$APP/Contents/MacOS/AdobeMCP"
  rm -f "$HERE/dist/.mb-arm64" "$HERE/dist/.mb-x64"
else
  say "No swiftc — building without the menu bar icon"
  cat > "$APP/Contents/MacOS/AdobeMCP" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec "$RES/runtime/node" "$RES/hub.js" >> "$HOME/Library/Logs/AdobeMCP.log" 2>&1
LAUNCH
fi
chmod +x "$APP/Contents/MacOS/AdobeMCP"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Adobe MCP</string>
  <key>CFBundleDisplayName</key><string>Adobe MCP</string>
  <key>CFBundleIdentifier</key><string>com.moskitodesign.adobemcp</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AdobeMCP</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

[ -f "$HERE/app.icns" ] && cp "$HERE/app.icns" "$RES/app.icns"

# Ad-hoc signature. Not notarized, so first launch needs right-click → Open.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true

say "Built: $APP  v$VER  ($(du -sh "$APP" | cut -f1))"

if [ "${1:-}" = "--zip" ] || [ "${1:-}" = "--release" ]; then
  rm -f "$HERE/dist/Adobe-MCP-macOS-$ARCH.zip"
  ( cd "$HERE/dist" && ditto -c -k --sequesterRsrc --keepParent "Adobe MCP.app" "Adobe-MCP-macOS-$ARCH.zip" )
  say "Zipped: $HERE/dist/Adobe-MCP-macOS-$ARCH.zip ($(du -sh "$HERE/dist/Adobe-MCP-macOS-$ARCH.zip" | cut -f1))"
fi

# --------------------------------------------------------------- release ----
# Tag and publish, so the update check in hub.js has something to find.
if [ "${1:-}" = "--release" ]; then
  ZIP="$HERE/dist/Adobe-MCP-macOS-$ARCH.zip"
  if gh release view "v$VER" >/dev/null 2>&1; then
    say "Updating release v$VER"
    gh release upload "v$VER" "$ZIP" --clobber
  else
    say "Publishing release v$VER"
    git tag -f "v$VER" && git push -q --force origin "v$VER"
    gh release create "v$VER" "$ZIP" --title "Adobe MCP $VER" --generate-notes
  fi
  say "Released v$VER"
fi
