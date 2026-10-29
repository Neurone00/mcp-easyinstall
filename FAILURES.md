# Failures

Kept up to date by the "Moskito Easy MCP: failures watch" scheduled task (weekdays 09:00).

## Last checked

29 Oct 2026, last 30 days. The detailed log only exists from 2.55.0, so older failures are counts without messages.

| App | Commands | Failed | Rate |
|---|---|---|---|
| Photoshop | 66 | 14 | 21% |
| Premiere | 97 | 7 | 7% |
| Illustrator | 143 | 6 | 4% |
| After Effects | 434 | 16 | 4% |
| InDesign | 5 | 1 | — |

## Open

- **Photoshop/Premiere: "Requires an open document/project"** (USER STATE). Seen on 9ca3d8 (2.55.0, Claude Code). Claude asked before anything was open. Fix: make the error say what to do ("Open or create a document in Photoshop, then ask again") in the tool reply, so the model tells the user instead of retrying.
- **Older failures without messages** (After Effects 16, Photoshop 11, Premiere 7). Nothing to act on until 2.55.0+ reports them in detail.

## Fixed, awaiting release

- **Photoshop `create_document` fails on Italian Photoshop** (BUG). Seen twice on MSKMAC14 (2.55.0, Claude chat). It looked for the layer "Background", which Italian Photoshop calls "Sfondo", so it threw after making the document and Claude retried into a second one. It also ignored the document name. Fixed with a build.sh patch (uses the document's own background layer and passes the name). Not yet tested in a live Photoshop.

## Closed
