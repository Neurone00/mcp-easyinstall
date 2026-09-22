# Adobe MCP — easy install

Let **Claude** and **ChatGPT** drive Adobe Illustrator, After Effects, Premiere Pro,
Photoshop and InDesign.

One app. Nothing else to install — no Node, no Python, no Homebrew, no terminal.

<br>

## Install

1. **[Download Adobe MCP](../../releases/latest)** and drag it to your Applications folder.
2. Right-click it → **Open** → **Open**. *(Only the first time. macOS asks this for
   any app not bought from the App Store.)*
3. A window opens. Press **Set everything up**.

That's it. The window tells you what's connected and what isn't.

<br>

## What it does

| | |
|---|---|
| **Illustrator, After Effects** | Fully automatic. Installs the panel, opens it, done. |
| **Photoshop, Premiere, InDesign** | One extra click — see below. |
| **Claude Desktop, Claude Code** | Connected for you. |
| **ChatGPT desktop, Codex CLI, IDE extension** | Connected for you. |

Adobe MCP lives in your **menu bar** (the ✨ icon). Click it → **Open Control Panel**
to get back to the settings window any time, or **Quit Adobe MCP** to stop it. There's
also a **⚙** button in the MCP panel inside each Adobe app.

Keep it running while you work.

### Updates

The app checks for a new version on launch and offers a one-click update. The Adobe
panels refresh themselves from the app every time it starts, so they can never drift
out of step with it.

### The extra click

Adobe only auto-installs plugins that Adobe itself has signed. Photoshop, Premiere
and InDesign use that newer plugin system, so their panel loads through Adobe's free
**UXP Developer Tool** (available in Creative Cloud).

Adobe MCP adds the plugin to that tool for you — you press **Load** next to it once.
Illustrator and After Effects use the older system, which has no such restriction,
so those are fully automatic.

<br>

## Using it

Open the MCP panel inside the Adobe app and leave it open:

- Illustrator / After Effects → **Window → Extensions → MCP Agent**
- Photoshop / InDesign → **Plugins → MCP Agent**
- Premiere Pro → **Window → MCP Agent**

Then just ask:

> *"Make me a 1080×1080 Instagram post with a bold headline and our brand colours."*
> *"Rename every layer in this file to a consistent format."*
> *"Build a rough cut from these clips with cross dissolves between them."*

<br>

## About ChatGPT

The **ChatGPT desktop app**, **Codex CLI** and the **Codex IDE extension** all run
local MCP servers and share one config file, so Adobe MCP connects all three at once.
In the desktop app they appear under Settings → MCP servers; type `/mcp` in the
composer to list what it can currently see. Restart the app if the list looks empty —
it reads the config at launch.

**ChatGPT in a browser tab cannot** — its connectors only reach servers on the public
internet, so they can't see an app on your Mac. Use the desktop app.

<br>

## Build it yourself

```bash
git clone https://github.com/Neurone00/mcp-easyinstall.git
cd mcp-easyinstall
./build.sh --zip
```

`build.sh` downloads Node, uv and the adb-mcp engine, then packs them into
`dist/Adobe MCP.app`. Apple Silicon and Intel Macs both work; the app you build
runs on the architecture you built it on.

### How it fits together

```
Claude / Codex  ──MCP──▶  Adobe MCP  ──socket.io──▶  panel inside the Adobe app
                          (hub.js, port 3001)
```

`hub.js` is both the control panel you see and the command proxy the Adobe panels
connect to. The MCP servers themselves are Python, run through a bundled `uv`.

<br>

## Credits

The engine that actually talks to the Adobe apps is
[**adb-mcp** by Mike Chambers](https://github.com/mikechambers/adb-mcp) (MIT) —
downloaded at build time, not vendored here. This project adds the one-click
installer, the control panel, and the connection to Claude and ChatGPT.

Neither project is endorsed by or supported by Adobe.

MIT licensed.
