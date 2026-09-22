# Adobe MCP — easy install

Let **Claude** and **ChatGPT** drive Adobe Illustrator, After Effects, Premiere Pro,
Photoshop and InDesign.

One app. Nothing else to install — no Node, no Python, no Homebrew, no terminal.

<br>

## Install

1. **[Download Adobe MCP](../../releases/latest)** and drag it to your Applications folder.
2. Double-click it. **macOS will refuse the first time — that's expected.** Then open
   **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**
   next to Adobe MCP. Only needed once.

   *(Right-click → Open no longer works — Apple removed that shortcut in macOS 15.
   The app isn't signed by Apple, which costs €99/year.)*
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
These tools live in the **Codex** surface, not a plain ChatGPT chat — asking a normal
chat window about them will get you "no Adobe Illustrator MCP server appears".

**One extra step for ChatGPT and Codex.** They run MCP servers in a sandbox with
networking switched off, so the Adobe servers can't reach the app on `localhost` and
every request fails as "cancelled". Press **Allow** on the ChatGPT row in Adobe MCP.
That sets `network_access = true` under `[sandbox_workspace_write]` in
`~/.codex/config.toml` — which also lets other Codex tools reach the network, so it's
your call. Claude Desktop doesn't sandbox its MCP servers and needs nothing.

**ChatGPT in a browser tab cannot** — its connectors only reach servers on the public
internet, so they can't see an app on your Mac. Use the desktop app.

<br>

## Build it yourself

```bash
git clone https://github.com/Neurone00/mcp-easyinstall.git
cd mcp-easyinstall
./build.sh --zip
```

`build.sh` downloads Node, uv and the adb-mcp engine, lipos both architectures
together and packs them into `dist/Adobe MCP.app`. The result is universal: the
same build runs on Apple Silicon and Intel, whichever Mac you build it on. The
build refuses to continue if any bundled binary is not universal.

### How it fits together

```
Claude / Codex  ──MCP──▶  Adobe MCP  ──socket.io──▶  panel inside the Adobe app
                          (hub.js, port 3001)
```

`hub.js` is both the control panel you see and the command proxy the Adobe panels
connect to. The MCP servers themselves are Python, run through a bundled `uv`.

<br>

## Illustrator tools

Upstream exposes five tools, only one of which can change artwork, so every
action made the model write an ExtendScript program — expensive, error-prone,
and the reason simple requests showed up as hundreds of "lines of code" in
usage dashboards.

Adobe MCP adds thirteen more, built at build time and dispatched through the
existing script bridge (the panel needs no changes):

`get_instructions`, `list_artboards`, `list_items`, `create_rectangle`,
`create_ellipse`, `create_text`, `create_artboard`, `set_fill`, `move_item`,
`resize_item`, `align_item`, `duplicate_item`, `delete_item`.

Coordinates are pixels from the **top-left of an artboard, y downward** — not
Illustrator's y-up document space — with `center=true` to skip the maths.
Colours are hex; CMYK documents are converted automatically. `execute_extend_script`
remains for anything the tools don't cover.

After Effects still has only `execute_extend_script`, but now ships real
guidance telling the model so, with orientation and undo-group advice.

## Credits

The engine that actually talks to the Adobe apps is
[**adb-mcp** by Mike Chambers](https://github.com/mikechambers/adb-mcp) (MIT) —
downloaded at build time, not vendored here. This project adds the one-click
installer, the control panel, and the connection to Claude and ChatGPT.

Neither project is endorsed by or supported by Adobe.

MIT licensed.


## Known limitation

`codex exec` — the **non-interactive** Codex CLI — cannot run these tools. It reports
`user cancelled MCP tool call` because it runs with approvals disabled and has no way
to grant one. The same request works from any interactive client: the ChatGPT desktop
app, the Codex TUI, Claude Desktop, or Claude Code. Only scripted `codex exec` runs
are affected.
