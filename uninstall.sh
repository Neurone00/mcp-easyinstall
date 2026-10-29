#!/bin/bash
# Removes Moskito Easy MCP and everything it put on this Mac.
# Run by the menu bar's "Uninstall…" item, or by hand: bash uninstall.sh
# Left alone, because other things use them: Adobe's UXP Developer Tool, the
# CEP debug-mode setting, and ChatGPT's network_access if you allowed it.
# Also kept: analytics.json, the Mac's anonymous id, so a reinstall shows on the
# usage page as the same Mac rather than a new one.
APP="${1:-/Applications/Moskito Easy MCP.app}"
SUPPORT="$HOME/Library/Application Support/AdobeMCP"
R="$APP/Contents/Resources"

# Stop the app first: while it runs it re-adds itself to the assistants.
# -a: by default pkill skips its own ancestors, and the menu bar app that
# started this script is one; left running, it restarted the background
# service and recreated the data folder.
pkill -a -f "Moskito Easy MCP\.app/Contents/(MacOS|Resources/runtime)/"
for _ in $(seq 20); do pgrep -a -f "Moskito Easy MCP\.app/Contents/(MacOS|Resources/runtime)/" >/dev/null || break; sleep 0.5; done
# Claude Desktop writes its config back when it quits, undoing the edit, and
# the Developer Tool does the same with its plugin list. Close both first.
claude=; pgrep -f "/Applications/Claude.app/Contents/MacOS/" >/dev/null && claude=1
pkill -TERM -f "/Applications/Claude.app/Contents/MacOS/"
pkill -TERM -f "Adobe UXP Developer Tools.app/Contents/MacOS/"
for _ in $(seq 20); do
  pgrep -f "/Applications/Claude.app/Contents/MacOS/|Adobe UXP Developer Tools.app/Contents/MacOS/" >/dev/null || break
  sleep 0.5
done

[ -x "$R/runtime/node" ] && "$R/runtime/node" "$R/hub.js" --uninstall

find "$SUPPORT" -mindepth 1 -maxdepth 1 ! -name analytics.json -exec rm -rf {} + 2>/dev/null
rm -rf "$APP"
tccutil reset All com.moskitodesign.adobemcp >/dev/null 2>&1
[ -n "$claude" ] && open -a Claude
echo "Moskito Easy MCP is uninstalled."
