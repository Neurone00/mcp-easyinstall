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
APP="$HERE/dist/Moskito Easy MCP.app"
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
  # Shrink the state blob attached to every response (see panel-addon.js).
  /usr/bin/sed -i '' \
    's|out\.document = await getActiveDocumentInfo();|out.document = await mcpCompactDocument(getActiveDocumentInfo);|' \
    "$panel/main.js"
  /usr/bin/sed -i '' \
    's|out\.projectInfo = await getProjectInfo();|out.projectInfo = await mcpCompactDocument(getProjectInfo);|' \
    "$panel/main.js"
  if ! grep -q "panel-addon.js" "$panel/index.html"; then
    /usr/bin/sed -i '' 's|</body>|    <script src="panel-addon.js"></script>\
</body>|' "$panel/index.html"
  fi
done

# ------------------------------------------------- engine tools + guidance --
# Append our extra MCP tools and real instructions to the vendored servers.
# Additive and marker-guarded, like the panel injection above, so re-running the
# build or updating the engine cannot duplicate or clobber them.
say "Adding Illustrator tools and instructions to the engine"
add_engine() {   # $1 = server file, $2 = addon file
  local target="$HERE/engine/mcp/$1"
  [ -f "$target" ] || { echo "Missing engine server: $1"; exit 1; }
  if ! grep -q "Adobe MCP additions" "$target"; then
    printf '\n' >> "$target"
    cat "$HERE/$2" >> "$target"
  fi
}
# Illustrator's .debug names the AFTER EFFECTS extension id — a copy-paste in
# the upstream engine. CEP therefore never enables remote debugging for the
# Illustrator panel, and the control panel's Connect button depends on it.
# Point each .debug at its own manifest's bundle id.
say "Fixing the CEP debug descriptors"
for panel in "$HERE"/engine/cep/*/; do
  [ -f "$panel/.debug" ] || continue
  id="$(/usr/bin/sed -n 's/.*ExtensionBundleId="\([^"]*\)".*/\1/p' "$panel/CSXS/manifest.xml" | head -1)"
  [ -n "$id" ] || continue
  /usr/bin/sed -i '' "s|<Extension Id=\"[^\"]*\">|<Extension Id=\"$id\">|" "$panel/.debug"
done

add_engine ai-mcp.py engine-addon-ai.py
add_engine ae-mcp.py engine-addon-ae.py

# Route the raw-script tool's result through our error check too, so a thrown
# script fails instead of returning a SUCCESS with an error object inside.
for f in "$HERE"/engine/mcp/ai-mcp.py "$HERE"/engine/mcp/ae-mcp.py; do
  "$HERE/runtime/node" -e '
    const fs = require("fs"); const file = process.argv[1];
    let s = fs.readFileSync(file, "utf8");
    const needle = "\"scriptString\": script_string\n    })\n    return sendCommand(command)";
    const fixed  = "\"scriptString\": script_string\n    })\n    return _raise_on_script_error(sendCommand(command))";
    if (s.includes(needle)) { fs.writeFileSync(file, s.replace(needle, fixed)); }
    else if (!s.includes("_raise_on_script_error(sendCommand")) {
      console.error("WARNING: could not wrap execute_extend_script in " + file);
    }
  ' "$f"
done

# Upstream crashes with a raw TypeError if the panel drops mid-command:
# send_message_blocking legitimately returns None, and core.py dereferences it.
# Done with node, not sed — sed collapsed the replacement onto one line and
# produced a core.py that would not parse.
"$HERE/runtime/node" -e '
  const fs = require("fs");
  const f = process.argv[1];
  let s = fs.readFileSync(f, "utf8");
  const needle = "    logger.log(f\"Final response: {response[\x27status\x27]}\")";
  if (!s.includes("Lost the connection to the Adobe app")) {
    if (!s.includes(needle)) { console.error("core.py: anchor not found"); process.exit(1); }
    s = s.replace(needle,
      "    if response is None:\n" +
      "        raise RuntimeError(\"Lost the connection to the Adobe app. Is the MCP Agent panel still open?\")\n" +
      needle);
    fs.writeFileSync(f, s);
  }
' "$HERE/engine/mcp/core.py"

# 20s covers connect AND execution, which is not enough for exports or renders.
/usr/bin/sed -i '' 's|^PROXY_TIMEOUT = 20$|PROXY_TIMEOUT = int(os.environ.get("ADOBE_MCP_TIMEOUT", "120"))|' \
  "$HERE"/engine/mcp/*-mcp.py
for f in "$HERE"/engine/mcp/*-mcp.py; do
  grep -q "^import os$" "$f" || /usr/bin/sed -i '' '1i\
import os
' "$f"
done

[ -d "$HERE/node_modules" ] || { say "Installing hub dependencies"; npm install --silent; }

# ----------------------------------------------------------------- bundle ---
say "Assembling the app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$RES"
cp "$HERE/hub.js" "$HERE/index.html" "$HERE/package.json" "$RES/"
mkdir -p "$RES/brand" && cp "$HERE/brand/mark.svg" "$HERE/brand/mark-animated.svg" "$RES/brand/"
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
  <key>CFBundleName</key><string>Moskito Easy MCP</string>
  <key>CFBundleDisplayName</key><string>Moskito Easy MCP</string>
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
  rm -f "$HERE/dist/Moskito-Easy-MCP-macOS-$ARCH.zip"
  ( cd "$HERE/dist" && ditto -c -k --sequesterRsrc --keepParent "Moskito Easy MCP.app" "Moskito-Easy-MCP-macOS-$ARCH.zip" )
  say "Zipped: $HERE/dist/Moskito-Easy-MCP-macOS-$ARCH.zip ($(du -sh "$HERE/dist/Moskito-Easy-MCP-macOS-$ARCH.zip" | cut -f1))"
fi

# --------------------------------------------------------------- release ----
# Tag and publish, so the update check in hub.js has something to find.
if [ "${1:-}" = "--release" ]; then
  ZIP="$HERE/dist/Moskito-Easy-MCP-macOS-$ARCH.zip"
  if gh release view "v$VER" >/dev/null 2>&1; then
    say "Updating release v$VER"
    gh release upload "v$VER" "$ZIP" --clobber
  else
    say "Publishing release v$VER"
    git tag -f "v$VER" && git push -q --force origin "v$VER"
    gh release create "v$VER" "$ZIP" --title "Moskito Easy MCP $VER" --generate-notes
  fi
  say "Released v$VER"
fi
