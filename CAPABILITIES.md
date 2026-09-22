# What Moskito Easy MCP can do

Every tool below is live and tested against a real document. Ask in plain words —
you never name a tool yourself.

Coordinates in Illustrator are **pixels from the top-left of the artboard, y
downward**, not Illustrator's own y-up space. Colours are hex (`#ff0000`); CMYK
documents are converted for you. Times in After Effects are **seconds**.

---

## Illustrator — 41 tools

### Looking at the document
| Tool | What it does |
|---|---|
| `list_artboards` | Index, name, size, which is active |
| `list_items` | Everything on an artboard, with **ids** |
| `find_items` | Search by name, text content, type, or layer |
| `get_selection` | What you have selected — makes "make *this* bigger" work |
| `list_layers` | Names, visibility, lock state, item counts |
| `list_swatches` | Document swatches with hex values |
| `list_fonts` | Installed fonts by PostScript name |
| `get_documents`, `get_active_document_info` | Full document dumps (verbose — the lists above are usually better) |

### Drawing
`create_rectangle` (with optional corner radius) · `create_ellipse` · `create_line` ·
`create_text` (point text, or a wrapping box if you give it a width) ·
`place_image` (linked or embedded) · `create_artboard` · `create_layer`

All of these take `center=true` to centre on the artboard, and return an **id**.

### Changing things
`set_fill` · `recolor_items` (several at once, one round trip) · `apply_swatch` ·
`move_item` · `resize_item` · `rotate_item` · `set_opacity` · `align_item` ·
`distribute_items` · `duplicate_item` · `group_items` · `delete_item` ·
`set_text_content` · `set_font` (size, colour, tracking, leading) ·
`move_to_layer` · `set_layer_state` · `rename_artboard` · `select_items`

### Getting work out
`export_artboard_png` (any scale — 200 for 2×) · `export_svg` · `export_png` · `save_as`

### Anything else
`execute_extend_script` runs raw ExtendScript. It is the fallback for gradients,
blends, complex path geometry — anything without its own tool.

---

## After Effects — 11 tools

After Effects has no per-action API the way Illustrator does, so this set is
built around **effects**, which is what it does have.

| Tool | What it does |
|---|---|
| `list_compositions` | Comps, sizes, durations, frame rates |
| `list_layers` | Layers, types, in/out points, effect counts |
| `list_effects` | **Every effect installed on your machine**, with match names |
| `list_layer_effects` | What is already on a layer, in order |
| `describe_effect` | An applied effect's parameters and current values |
| `apply_effect` | Add an effect by match name |
| `set_effect_parameter` | Set one parameter |
| `animate_property` | Keyframe an effect parameter *or* a transform, with easing |
| `apply_preset` | Apply an `.ffx` animation preset |
| `execute_extend_script` | Everything else |

**Third-party plugins work identically.** Video Copilot, Red Giant/Maxon and
Boris FX effects are just match names with a vendor prefix. `list_effects` reads
them from After Effects itself rather than a bundled table, so it always reflects
what you actually have installed — 455 effects on this machine.

Every tool that changes something wraps itself in an **undo group**, so you can
undo the AI's work in one step.

---

## What it cannot do

Not limitations of this app — these have no scripting API in Adobe's own software,
so nothing built on scripting can reach them. Both servers tell the model this, so
it should say so rather than producing something that merely looks right.

**Illustrator**
- **Pathfinder** (unite, minus front, intersect…) — no API at all
- **Offset Path**, **Simplify**, **Outline Stroke**
- **The entire Effect menu** — drop shadows, warps, blurs applied as live effects
- **The Appearance panel** — multiple fills and strokes on one object, stroke alignment
- Image Trace *is* scriptable, unlike the rest of this list

**After Effects**
- **Roto Brush**, **Content-Aware Fill**, **mask tracking**
- Reading rendered pixel data
- Third-party render engines

**Both**: scripts cannot run while a render is in progress.

---

## Keeping it up to date

You don't do anything. The app checks for a new version when it launches and every
six hours after, and shows a banner with an **Update now** button when there is
one. One click downloads it, checks the build matches your Mac, swaps the app and
reopens it — keeping the old copy until the new one is safely in place.

The Adobe panels are refreshed from the app every time it starts, so they can
never drift out of step with it, and the Claude/ChatGPT config files are repaired
automatically if the app moves.

To check manually: the version is in the app's footer and in its menu bar item.
Releases are at
[github.com/Neurone00/mcp-easyinstall/releases](https://github.com/Neurone00/mcp-easyinstall/releases).
