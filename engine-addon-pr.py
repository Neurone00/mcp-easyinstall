

# ===========================================================================
# Moskito Easy MCP — Premiere Pro: a general-purpose tool
# ===========================================================================
#
# Appended to pr-mcp.py by build.sh. The 26 upstream tools stay: they are the
# typed fast paths. This is for everything they can't do, which used to leave
# the model with no route but computer use.


@mcp.tool()
def execute_script(script: str):
    """Runs JavaScript inside Premiere Pro against its UXP API and returns the result.

    The script is the body of an async function with `ppro` (Premiere's API,
    require("premierepro")) in scope; `return` plain JSON. For edits follow the
    server instructions' pattern: await getters first, then no await inside
    project.lockedAccess.
    Use it for anything the other tools can't do: trimming or moving clips,
    any effect or Lumetri colour, keyframes, transitions, audio, titles.

    Args:
        script: The JavaScript function body. Must use `return` to send data back.
    """
    command = createCommand("executeScript", {"script": script})
    result = sendCommand(command)
    resp = result.get("response") if isinstance(result, dict) else None
    # The panel returns a thrown script as {error}, not as a failure. Raise it,
    # so the model sees a failed call — as After Effects' scripting tool does.
    if isinstance(resp, dict) and "error" in resp:
        raise RuntimeError(f"The script failed: {resp['error']}")
    # Just the result. Every Premiere reply also carries the whole project and
    # every sequence, which for a script call is context the model can ask for.
    return resp
