
# ---------------------------------------------------------------------------
# Adobe MCP additions — appended to ai-mcp.py at build time by build.sh.
#
# Why this exists: upstream Illustrator exposes five tools, only one of which
# can change artwork (execute_extend_script). So every action — "draw a square",
# "recolour this" — made the model author an ExtendScript program. Generated
# code is the most expensive kind of token there is, a wrong script costs a
# retry at full price, and it is why a simple request showed up as hundreds of
# "lines of code" in the usage dashboard.
#
# The tools below take a few small arguments and build the ExtendScript here,
# on the Python side, for free. The panel needs no changes: they all dispatch
# through the existing executeExtendScript command.
#
# Coordinates are deliberately NOT Illustrator's. Callers use pixels from the
# TOP-LEFT of an artboard with y increasing downward, which is how designers
# and models both think. The conversion to Illustrator's y-up document space
# happens in the JSX prelude.
# ---------------------------------------------------------------------------

import json as _json

# Shared ExtendScript helpers, prepended to every script we generate.
_PRELUDE = r"""
function _doc(){ if(app.documents.length===0){throw new Error("No document is open in Illustrator.");} return app.activeDocument; }
function _ab(doc, idx){
    var i = (idx===null||idx===undefined||idx<0) ? doc.artboards.getActiveArtboardIndex() : idx;
    if(i>=doc.artboards.length){throw new Error("Artboard "+i+" doesn't exist (document has "+doc.artboards.length+").");}
    return doc.artboards[i];
}
/* artboardRect is [left, top, right, bottom] in document space, y up. */
function _r(doc, idx){ return _ab(doc, idx).artboardRect; }
function _hex(h){
    h = String(h).replace("#","");
    if(h.length===3){ h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2); }
    return [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)];
}
function _color(doc, hexStr){
    var c = _hex(hexStr);
    if(doc.documentColorSpace === DocumentColorSpace.CMYK){
        var k = new CMYKColor();
        var r=c[0]/255, g=c[1]/255, b=c[2]/255;
        var kk = 1 - Math.max(r, Math.max(g,b));
        if(kk >= 1){ k.cyan=0; k.magenta=0; k.yellow=0; k.black=100; return k; }
        k.cyan    = ((1-r-kk)/(1-kk))*100;
        k.magenta = ((1-g-kk)/(1-kk))*100;
        k.yellow  = ((1-b-kk)/(1-kk))*100;
        k.black   = kk*100;
        return k;
    }
    var rgb = new RGBColor();
    rgb.red=c[0]; rgb.green=c[1]; rgb.blue=c[2];
    return rgb;
}
/* Artboard-relative, y-down -> Illustrator document space, y-up. */
function _pos(doc, idx, x, y, w, h, center){
    var r = _r(doc, idx);
    if(center){ return [ (r[0]+r[2])/2 - w/2, (r[1]+r[3])/2 + h/2 ]; }
    return [ r[0] + x, r[1] - y ];
}
function _style(doc, item, fill, stroke, strokeWidth){
    if(fill===null||fill===undefined||fill===""){ item.filled=false; }
    else { item.filled=true; item.fillColor=_color(doc, fill); }
    if(stroke===null||stroke===undefined||stroke===""){ item.stroked=false; }
    else { item.stroked=true; item.strokeColor=_color(doc, stroke); item.strokeWidth=strokeWidth; }
}
function _find(doc, name){
    for(var i=0;i<doc.pageItems.length;i++){ if(doc.pageItems[i].name===name){ return doc.pageItems[i]; } }
    throw new Error("No item named '"+name+"'. Use list_items to see what is there.");
}
function _brief(item){
    return { name:item.name, type:item.typename,
             x:Math.round(item.position[0]), y:Math.round(item.position[1]),
             width:Math.round(item.width), height:Math.round(item.height) };
}
"""


def _run(body: str):
    """
    Run generated ExtendScript and turn an in-band error into a real failure.

    The CEP panel catches a thrown script and returns {error, line} as a
    perfectly normal SUCCESS result, so a broken script used to look like a
    working one and the model had to notice an "error" key to spot it.
    """
    command = createCommand("executeExtendScript", {"scriptString": _PRELUDE + body})
    result = sendCommand(command)

    text = None
    try:
        text = result["response"]["content"][0]["text"]
    except Exception:
        return result

    try:
        parsed = _json.loads(text) if isinstance(text, str) else text
        if isinstance(parsed, str):
            parsed = _json.loads(parsed)
    except Exception:
        return result

    if isinstance(parsed, dict) and "error" in parsed:
        where = f" (line {parsed.get('line')})" if parsed.get("line") else ""
        raise RuntimeError(f"Illustrator rejected that: {parsed['error']}{where}")
    return parsed


@mcp.tool()
def get_instructions() -> str:
    """Read this first. How to work with Illustrator through these tools."""
    return """
You are driving Adobe Illustrator through a live panel. The user's document is
already open — work on it, don't create a new one unless asked.

COORDINATES
  x, y are in points from the TOP-LEFT of the artboard, y increasing DOWNWARD.
  (1 point = 1 pixel at 72dpi, which is what Illustrator's px sizes mean.)
  Pass center=true to centre something on the artboard and skip the maths.
  Colours are hex strings: "#ff0000". CMYK documents are converted for you.

HOW TO WORK
  1. list_artboards and list_items tell you what is there. Prefer them over
     get_active_document_info, which returns much more than you usually need.
  2. Use the specific tools below for anything they cover. They are cheaper,
     faster and far less error-prone than writing a script.
  3. Name things you create (the name argument). Every other tool addresses
     items by name, so unnamed items are awkward to modify afterwards.
  4. Only fall back to execute_extend_script for things no tool covers —
     gradients, pathfinder operations, symbols, complex path geometry. It runs
     raw ExtendScript against the document; use `return` to send data back.

WHAT YOU HAVE
  create_rectangle, create_ellipse, create_text, create_artboard,
  set_fill, move_item, resize_item, align_item, duplicate_item, delete_item,
  list_items, list_artboards, export_png, execute_extend_script.

CARE
  You are editing someone's real, possibly unsaved document. Prefer additive
  changes. Don't delete or restyle work you did not create unless asked to.
"""


@mcp.tool()
def list_artboards():
    """
    Lists the artboards: index, name and size. Cheap — prefer this over
    get_active_document_info when you only need to know where to place things.
    """
    return _run("""
        var doc=_doc(), out=[];
        for(var i=0;i<doc.artboards.length;i++){
            var r=doc.artboards[i].artboardRect;
            out.push({ index:i, name:doc.artboards[i].name,
                       width:Math.round(r[2]-r[0]), height:Math.round(r[1]-r[3]),
                       active:(i===doc.artboards.getActiveArtboardIndex()) });
        }
        return JSON.stringify(out);
    """)


@mcp.tool()
def list_items(artboard: int = -1):
    """
    Lists the items on an artboard with their names, positions and sizes.

    Args:
        artboard: artboard index, or -1 for the active one.
    """
    return _run(f"""
        var doc=_doc(), r=_r(doc, {artboard}), out=[];
        for(var i=0;i<doc.pageItems.length;i++){{
            var it=doc.pageItems[i], p=it.position;
            if(p[0] >= r[0]-1 && p[0] <= r[2]+1 && p[1] <= r[1]+1 && p[1] >= r[3]-1){{
                out.push(_brief(it));
            }}
        }}
        return JSON.stringify(out);
    """)


@mcp.tool()
def create_rectangle(
    width: float,
    height: float,
    x: float = 0,
    y: float = 0,
    fill: str = "#000000",
    stroke: str = None,
    stroke_width: float = 1,
    name: str = None,
    artboard: int = -1,
    center: bool = False,
):
    """
    Draws a rectangle.

    Args:
        width, height: size in points.
        x, y: from the artboard's top-left, y downward. Ignored if center.
        fill: hex colour, or empty string for no fill.
        stroke: hex colour, or omit for no stroke.
        stroke_width: stroke weight in points.
        name: name it so other tools can address it later.
        artboard: index, or -1 for the active artboard.
        center: centre it on the artboard and ignore x/y.
    """
    return _run(f"""
        var doc=_doc();
        var p=_pos(doc, {artboard}, {x}, {y}, {width}, {height}, {str(center).lower()});
        var it=doc.pathItems.rectangle(p[1], p[0], {width}, {height});
        _style(doc, it, {_json.dumps(fill)}, {_json.dumps(stroke)}, {stroke_width});
        {f'it.name={_json.dumps(name)};' if name else ''}
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def create_ellipse(
    width: float,
    height: float,
    x: float = 0,
    y: float = 0,
    fill: str = "#000000",
    stroke: str = None,
    stroke_width: float = 1,
    name: str = None,
    artboard: int = -1,
    center: bool = False,
):
    """
    Draws an ellipse. Pass the same width and height for a circle.
    Arguments match create_rectangle.
    """
    return _run(f"""
        var doc=_doc();
        var p=_pos(doc, {artboard}, {x}, {y}, {width}, {height}, {str(center).lower()});
        var it=doc.pathItems.ellipse(p[1], p[0], {width}, {height});
        _style(doc, it, {_json.dumps(fill)}, {_json.dumps(stroke)}, {stroke_width});
        {f'it.name={_json.dumps(name)};' if name else ''}
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def create_text(
    text: str,
    x: float = 0,
    y: float = 0,
    size: float = 24,
    color: str = "#000000",
    font: str = None,
    name: str = None,
    artboard: int = -1,
    center: bool = False,
):
    """
    Adds a point-text frame.

    Args:
        text: the string. Use \\n for line breaks.
        x, y: from the artboard's top-left, y downward — this is the text's
              top-left, not Illustrator's baseline origin, which is corrected
              for you.
        size: font size in points.
        color: hex.
        font: PostScript font name (e.g. "Helvetica-Bold"). Omit for the
              document default; a name Illustrator doesn't have raises an error.
        center: centre the frame on the artboard once its size is known.
    """
    return _run(f"""
        var doc=_doc();
        var r=_r(doc, {artboard});
        var t=doc.textFrames.add();
        t.contents={_json.dumps(text)};
        t.textRange.characterAttributes.size={size};
        t.textRange.characterAttributes.fillColor=_color(doc, {_json.dumps(color)});
        {f'''try{{ t.textRange.characterAttributes.textFont=app.textFonts.getByName({_json.dumps(font)}); }}
             catch(e){{ throw new Error("Font not available: {font}"); }}''' if font else ''}
        if({str(center).lower()}){{
            t.position=[ (r[0]+r[2])/2 - t.width/2, (r[1]+r[3])/2 + t.height/2 ];
        }} else {{
            t.position=[ r[0] + {x}, r[1] - {y} ];
        }}
        {f't.name={_json.dumps(name)};' if name else ''}
        return JSON.stringify(_brief(t));
    """)


@mcp.tool()
def create_artboard(width: float, height: float, name: str = None):
    """
    Adds an artboard to the right of the existing ones.

    Args:
        width, height: size in points.
        name: optional artboard name.
    """
    return _run(f"""
        var doc=_doc(), right=-1e9, top=0;
        for(var i=0;i<doc.artboards.length;i++){{
            var r=doc.artboards[i].artboardRect;
            if(r[2]>right){{ right=r[2]; top=r[1]; }}
        }}
        var gap=40;
        var ab=doc.artboards.add([right+gap, top, right+gap+{width}, top-{height}]);
        {f'ab.name={_json.dumps(name)};' if name else ''}
        return JSON.stringify({{ index:doc.artboards.length-1, name:ab.name }});
    """)


@mcp.tool()
def set_fill(name: str, fill: str = None, stroke: str = None, stroke_width: float = 1):
    """
    Recolours an existing item by name.

    Args:
        name: the item's name (see list_items).
        fill: hex colour, or empty string to remove the fill.
        stroke: hex colour, or empty string to remove the stroke.
        stroke_width: stroke weight in points.
    """
    fill_js = "null" if fill is None else _json.dumps(fill)
    stroke_js = "null" if stroke is None else _json.dumps(stroke)
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)});
        var f={fill_js}, s={stroke_js};
        if(f!==null){{ if(f===""){{ it.filled=false; }} else {{ it.filled=true; it.fillColor=_color(doc,f); }} }}
        if(s!==null){{ if(s===""){{ it.stroked=false; }} else {{ it.stroked=true; it.strokeColor=_color(doc,s); it.strokeWidth={stroke_width}; }} }}
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def move_item(name: str, x: float, y: float, artboard: int = -1):
    """Moves an item so its top-left sits at x, y from the artboard's top-left."""
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)}), r=_r(doc, {artboard});
        it.position=[ r[0] + {x}, r[1] - {y} ];
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def resize_item(name: str, width: float = None, height: float = None):
    """
    Resizes an item. Give only one of width/height to scale proportionally.
    """
    w = "null" if width is None else width
    h = "null" if height is None else height
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)});
        var w={w}, h={h};
        var sx = (w===null) ? null : (w/it.width)*100;
        var sy = (h===null) ? null : (h/it.height)*100;
        if(sx===null) sx=sy;
        if(sy===null) sy=sx;
        it.resize(sx, sy);
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def align_item(name: str, horizontal: str = "center", vertical: str = "center", artboard: int = -1):
    """
    Aligns an item to its artboard.

    Args:
        horizontal: left, center, right, or none.
        vertical: top, center, bottom, or none.
    """
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)}), r=_r(doc, {artboard});
        var p=it.position, x=p[0], y=p[1];
        var H={_json.dumps(horizontal)}, V={_json.dumps(vertical)};
        if(H==="left"){{ x=r[0]; }} else if(H==="right"){{ x=r[2]-it.width; }}
        else if(H==="center"){{ x=(r[0]+r[2])/2 - it.width/2; }}
        if(V==="top"){{ y=r[1]; }} else if(V==="bottom"){{ y=r[3]+it.height; }}
        else if(V==="center"){{ y=(r[1]+r[3])/2 + it.height/2; }}
        it.position=[x,y];
        return JSON.stringify(_brief(it));
    """)


@mcp.tool()
def duplicate_item(name: str, new_name: str = None, x: float = None, y: float = None, artboard: int = -1):
    """
    Duplicates an item, optionally onto another artboard at a given position.

    Args:
        name: item to copy.
        new_name: name for the copy.
        x, y: where to put the copy, from the target artboard's top-left.
        artboard: which artboard x/y refer to. -1 for the active one.
    """
    move = ""
    if x is not None and y is not None:
        move = f"var r=_r(doc, {artboard}); c.position=[ r[0] + {x}, r[1] - {y} ];"
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)});
        var c=it.duplicate();
        {f'c.name={_json.dumps(new_name)};' if new_name else ''}
        {move}
        return JSON.stringify(_brief(c));
    """)


@mcp.tool()
def delete_item(name: str):
    """Deletes the item with this name. Only remove work the user asked you to."""
    return _run(f"""
        var doc=_doc(), it=_find(doc, {_json.dumps(name)});
        var n=it.name; it.remove();
        return JSON.stringify({{ deleted:n }});
    """)
