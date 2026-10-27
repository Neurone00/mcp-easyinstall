


# ===========================================================================
# Moskito Easy MCP — InDesign: a general-purpose tool
# ===========================================================================
#
# Appended to id-mcp.py by build.sh. Upstream's only tool is create_document;
# this is the route for everything else, as execute_script is for Premiere.


@mcp.tool()
def execute_script(script: str):
    """Runs JavaScript inside InDesign against its UXP DOM and returns the result.

    The script is the body of an async function with `app` (InDesign's app
    object) and `indesign` (require("indesign"), for enums and classes) in
    scope; `return` plain JSON. Use it for anything: text frames, styles,
    pages, images, tables, export.

    Args:
        script: The JavaScript function body. Must use `return` to send data back.
    """
    command = createCommand("executeScript", {"script": script})
    result = sendCommand(command)
    resp = result.get("response") if isinstance(result, dict) else None
    if isinstance(resp, dict) and "error" in resp:
        raise RuntimeError(f"The script failed: {resp['error']}")
    return resp
