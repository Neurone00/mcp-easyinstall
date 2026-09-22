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
ARCH="$(uname -m)"   # arm64 | x86_64
NODE_ARCH=$([ "$ARCH" = "arm64" ] && echo arm64 || echo x64)
UV_ARCH=$([ "$ARCH" = "arm64" ] && echo aarch64 || echo x86_64)
APP="$HERE/dist/Adobe MCP.app"
RES="$APP/Contents/Resources"

say() { printf '\033[1m→\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- runtimes --
mkdir -p "$HERE/runtime"
if [ ! -x "$HERE/runtime/node" ]; then
  say "Downloading Node $NODE_VERSION ($NODE_ARCH)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz" \
    | tar -xz -C "$HERE/runtime" --strip-components=2 "node-v$NODE_VERSION-darwin-$NODE_ARCH/bin/node"
fi
if [ ! -x "$HERE/runtime/uv" ]; then
  say "Downloading uv ($UV_ARCH)"
  curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$UV_ARCH-apple-darwin.tar.gz" \
    | tar -xz -C "$HERE/runtime" --strip-components=1
  rm -f "$HERE/runtime/uvx"
fi
chmod +x "$HERE/runtime/node" "$HERE/runtime/uv"

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
cp "$HERE/hub.js" "$HERE/index.html" "$RES/"
# A stray .venv from running the engine locally would double the app's size.
rm -rf "$HERE/engine/mcp/.venv" "$HERE/engine/mcp/__pycache__"
cp -R "$HERE/node_modules" "$HERE/runtime" "$HERE/engine" "$RES/"

cat > "$APP/Contents/MacOS/AdobeMCP" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec "$RES/runtime/node" "$RES/hub.js" >> "$HOME/Library/Logs/AdobeMCP.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/AdobeMCP"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Adobe MCP</string>
  <key>CFBundleDisplayName</key><string>Adobe MCP</string>
  <key>CFBundleIdentifier</key><string>com.moskitodesign.adobemcp</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
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

say "Built: $APP ($(du -sh "$APP" | cut -f1))"

if [ "${1:-}" = "--zip" ]; then
  rm -f "$HERE/dist/Adobe-MCP-macOS-$ARCH.zip"
  ( cd "$HERE/dist" && ditto -c -k --sequesterRsrc --keepParent "Adobe MCP.app" "Adobe-MCP-macOS-$ARCH.zip" )
  say "Zipped: $HERE/dist/Adobe-MCP-macOS-$ARCH.zip ($(du -sh "$HERE/dist/Adobe-MCP-macOS-$ARCH.zip" | cut -f1))"
fi
