
# ---------------------------------------------------------------------------
# Adobe MCP additions — appended to ae-mcp.py at build time by build.sh.
#
# After Effects upstream exposes exactly one tool, execute_extend_script, and
# nothing anywhere tells a model that raw scripting is therefore its only way
# to do anything. The instruction text is four generic lines, and it ships as
# an MCP *resource*, which clients rarely fetch — so in practice it is never
# read. Re-registering it as a tool is what makes it visible.
# ---------------------------------------------------------------------------


@mcp.tool()
def get_instructions() -> str:
    """Read this first. How to work with After Effects through this server."""
    return """
You are driving Adobe After Effects through a live panel.

IMPORTANT: this server has exactly one tool — execute_extend_script. There are
no per-action tools. Everything you do, you do by writing ExtendScript against
the After Effects DOM and sending it to that tool.

HOW TO WORK
  1. Look before you act. Send a small read-only script first:
        var p = app.project;
        var out = [];
        for (var i = 1; i <= p.numItems; i++) {
            out.push({ index: i, name: p.item(i).name, type: p.item(i).typeName });
        }
        return JSON.stringify(out);
  2. Use `return` to send data back, and return JSON.stringify(...) for
     anything structured — a bare object comes back as "[object Object]".
  3. Wrap edits in an undo group so the user can undo your work in one step:
        app.beginUndoGroup("Claude: add title");
        ... your changes ...
        app.endUndoGroup();
  4. Keep each script to one coherent step and check the result before the
     next one. A long speculative script that fails halfway is expensive and
     leaves the project half-changed.

ORIENTATION
  app.project.activeItem is the open composition (may be null).
  comp.layers.addText("..."), comp.layers.addSolid(...), layer.property("Position"),
  property.setValueAtTime(t, v) are the usual entry points.
  Times are seconds; sizes are pixels.

CARE
  You are editing someone's real project. Prefer additive changes, always use
  an undo group, and do not delete or restyle work you did not create unless
  you were asked to.
"""
