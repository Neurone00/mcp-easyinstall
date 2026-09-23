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
