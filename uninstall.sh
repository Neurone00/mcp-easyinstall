#!/bin/bash
# Removes Moskito Easy MCP and everything it put on this Mac.
# Run by the menu bar's "Uninstall…" item, or by hand: bash uninstall.sh
# Left alone, because other things use them: Adobe's UXP Developer Tool, the
# CEP debug-mode setting, and ChatGPT's network_access if you allowed it.
APP="${1:-/Applications/Moskito Easy MCP.app}"
SUPPORT="$HOME/Library/Application Support/AdobeMCP"
R="$APP/Contents/Resources"

# Stop the app first: while it runs it re-adds itself to the assistants.
pkill -f "Moskito Easy MCP\.app/Contents/(MacOS|Resources/runtime)/"
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

rm -rf "$SUPPORT" "$APP"
tccutil reset All com.moskitodesign.adobemcp >/dev/null 2>&1
[ -n "$claude" ] && open -a Claude
echo "Moskito Easy MCP is uninstalled."
