# ===========================================================================
# Adobe MCP shared additions — which app am I driving?
# ===========================================================================
#
# Appended to every server by build.sh. Several Adobe apps can be connected at
# once, each as its own MCP server, so the model chooses the application by
# choosing a tool — usually without noticing it made a choice at all.
#
# This goes in the server's `instructions`, not in a tool and not in a client
# skill. Instructions are part of the initialize response, so both Claude and
# ChatGPT receive them on every connection with nothing to call and nothing to
# install. A skill would only have worked in Claude.
#
# `instructions` is a read-only property on FastMCP, but the low-level Server
# holds the real attribute and reads it per connection, so setting it here —
# after the server was constructed in the file above — still takes effect.

_WHICH_APP = """
You may be connected to several Adobe applications at once — Illustrator,
After Effects, Photoshop, Premiere Pro — each with its own set of tools. This
server drives {app} and nothing else.

Before the first action of a request, make sure {app} is the application the
user means. Ask a short question instead of acting when either of these is true:

  - The request does not say which application it is for, and more than one of
    the connected applications could carry it out. "Export a PNG", "what am I
    working on", "undo that" are all ambiguous when several apps are open.

  - You have been working in one application and this request reads as though
    it belongs to a different one. Compositions, keyframes, effects and time
    point at After Effects; artboards, paths and swatches at Illustrator;
    sequences, clips and transitions at Premiere Pro; pixel layers, masks and
    selections at Photoshop. A shift like that is worth one question, even
    though it interrupts.

Do not ask when the request names the application, when only one connected
application has a tool that could do it, or when the user is plainly continuing
the work you were just doing. Asking every time is worse than the occasional
wrong guess.

When you do ask, name the options and say nothing else: "Illustrator or After
Effects?" is enough.
""".strip()

try:
    _existing = mcp._mcp_server.instructions or ""
    _app_label = {
        "illustrator": "Adobe Illustrator",
        "aftereffects": "Adobe After Effects",
        "photoshop": "Adobe Photoshop",
        "premiere": "Adobe Premiere Pro",
    }.get(APPLICATION, APPLICATION)
    _text = _WHICH_APP.format(app=_app_label)
    mcp._mcp_server.instructions = (_existing + "\n\n" + _text).strip()
except Exception:
    # Never let orientation text stop the server from starting: without it the
    # model guesses the application, which is how it behaved before.
    pass


# ===========================================================================
# Adobe MCP shared additions — trimming what the model is sent
# ===========================================================================
#
# Every tool definition rides along on every request. Measured across the four
# servers: ~27,000 tokens before the user has typed anything. Two parts of that
# are pure restatement and can go without losing meaning:
#
#   "title" on every schema property. The key is already `anti_aliasing`; a
#   sibling "title": "Anti Aliasing" tells the model nothing it cannot read.
#
#   "Returns:" and "Raises:" blocks, and the "(str, optional)" and "Defaults to
#   X." fragments inside "Args:". Types and defaults are in the schema, and the
#   model sees the actual return value when it calls the tool.
#
# What is NOT touched: the summary, and the prose in Args:. Those carry things
# a schema cannot say — ranges like (1-1000), the shape of a dict, coordinate
# conventions — and dropping them would buy tokens with wrong calls.

import re as _re

_TAIL = _re.compile(r"\n\s*(Returns|Raises|Yields)\s*:.*", _re.S | _re.I)
_TYPES = _re.compile(
    r"\s*\((?:str|int|float|bool|dict|list|any|object|number|string|boolean|integer)[^)]*\)\s*:",
    _re.I)
_DEFAULTS = _re.compile(r"\s*Defaults? to [^.\n]+\.", _re.I)
_BLANKS = _re.compile(r"\n{3,}")


def _drop_titles(node):
    if isinstance(node, dict):
        node.pop("title", None)
        for value in node.values():
            _drop_titles(value)
    elif isinstance(node, list):
        for value in node:
            _drop_titles(value)


def _slim(text):
    if not text:
        return text
    out = _TAIL.sub("", text)
    out = _TYPES.sub(":", out)
    out = _DEFAULTS.sub("", out)
    return _BLANKS.sub("\n\n", out).strip()


try:
    for _tool in mcp._tool_manager._tools.values():
        _drop_titles(_tool.parameters)
        _tool.description = _slim(_tool.description)
except Exception:
    # Never let a saving stop the server from starting.
    pass


# ===========================================================================
# Adobe MCP shared additions — the facts that cause wrong calls
# ===========================================================================
#
# Found by auditing each server's readers against its writers. These are the
# places where a reasonable reading of the tool list produces a wrong call, and
# nothing errors — the work just lands somewhere unintended. Short on purpose:
# instructions are paid for on every request.

_APP_NOTES = {
    "premiere": """
TIME COMES IN TWO UNITS
  add_marker_to_sequence, add_media_to_sequence and set_clip_start_end_times
  take TICKS. export_frame and get_sequence_frame_image take SECONDS.
  1 second = 2,940,000 ticks. So 5 seconds is 14,700,000 ticks.
  Check which one the tool you are about to call asks for.
""",
    "photoshop": """
READING A POSITION AND SETTING ONE ARE NOT THE SAME
  get_layer_bounds returns ABSOLUTE pixels from the document's top-left.
  translate_layer takes a RELATIVE offset in pixels. To move a layer so its
  left edge sits at x, pass x - bounds.left, not x.
  scale_layer takes PERCENTAGES, not pixels.
""",
    "illustrator": """
POSITIONS ROUND-TRIP
  Everything that reports a position — list_items, find_items, get_selection,
  and the value returned by create_* and move_item — uses the same space the
  setters take: pixels from the artboard's top-left, y downward. A position you
  read can be passed straight back without conversion.
""",
}

try:
    _note = _APP_NOTES.get(APPLICATION)
    if _note:
        mcp._mcp_server.instructions = (
            (mcp._mcp_server.instructions or "") + "\n" + _note.strip()).strip()
except Exception:
    pass
