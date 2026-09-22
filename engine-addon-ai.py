
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
# Two conventions worth knowing before reading further:
#
# HANDLES. Items are addressed by a stable id, not by name. Names are not
# unique — a document with two "Rectangle 1"s made name-addressing ambiguous,
# and silently operating on the wrong one is the worst kind of bug in someone's
# artwork. Every tool still accepts a name for convenience, but refuses when it
# matches more than one item and tells you to use the id instead.
#
# COORDINATES. Callers use pixels from the TOP-LEFT of an artboard with y
# increasing downward, which is how designers and models both think.
# Illustrator's own space is y-up with a document-wide origin; the conversion
# happens in the JSX prelude, not in the caller's head.
# ---------------------------------------------------------------------------

import json as _json


def _js(template: str, **values) -> str:
    """
    Substitute $NAME placeholders with JSON-encoded values.

    Deliberately not an f-string: these scripts are full of JavaScript braces,
    and escaping every one of them is a reliable way to ship a broken script.
    json.dumps also gets JS literals right for free — True -> true, None ->
    null, and strings are quoted and escaped properly.
    """
    for key, value in values.items():
        template = template.replace("$" + key, _json.dumps(value))
    return template


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

/* --- handles -----------------------------------------------------------
   Illustrator exposes a read-only uuid on page items in most versions. Where
   it is missing we fall back to a tag kept in the item's note, appended so an
   existing note the user wrote is preserved. */
function _uuid(it){ try { return it.uuid || null; } catch(e){ return null; } }
function _tagOf(it){
    try { var m = String(it.note||"").match(/\[amcp:([a-z0-9]+)\]/); return m ? m[1] : null; } catch(e){ return null; }
}
function _handle(it){
    var u = _uuid(it); if(u) return u;
    var t = _tagOf(it); if(t) return t;
    try {
        var id = "i" + (new Date().getTime()).toString(36) + Math.floor(Math.random()*1679616).toString(36);
        it.note = String(it.note||"") + "[amcp:" + id + "]";
        return id;
    } catch(e){ return null; }
}
/* Accepts a handle or a name. Refuses an ambiguous name rather than guessing. */
function _find(doc, ref){
    var i, it;
    for(i=0;i<doc.pageItems.length;i++){
        it = doc.pageItems[i];
        if(_uuid(it) === ref || _tagOf(it) === ref) return it;
    }
    var hits = [];
    for(i=0;i<doc.pageItems.length;i++){ if(doc.pageItems[i].name === ref) hits.push(doc.pageItems[i]); }
    if(hits.length === 1) return hits[0];
    if(hits.length > 1){
        throw new Error("There are " + hits.length + " items named '" + ref + "'. Use the id from list_items, which is unique.");
    }
    throw new Error("Nothing matches '" + ref + "'. Use list_items to see what is in the document.");
}
function _brief(it){
    return { id:_handle(it), name:it.name, type:it.typename,
             x:Math.round(it.position[0]), y:Math.round(it.position[1]),
             width:Math.round(it.width), height:Math.round(it.height) };
}

/* --- colour ------------------------------------------------------------ */
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
        k.cyan=((1-r-kk)/(1-kk))*100; k.magenta=((1-g-kk)/(1-kk))*100;
        k.yellow=((1-b-kk)/(1-kk))*100; k.black=kk*100;
        return k;
    }
    var rgb = new RGBColor(); rgb.red=c[0]; rgb.green=c[1]; rgb.blue=c[2]; return rgb;
}

/* --- placement --------------------------------------------------------- */
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
function _layerByName(doc, name){
    for(var i=0;i<doc.layers.length;i++){ if(doc.layers[i].name===name) return doc.layers[i]; }
    throw new Error("No layer named '"+name+"'. Use list_layers.");
}
function _file(p){ var f = new File(p); var d = f.parent; if(!d.exists){ d.create(); } return f; }
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



def _raise_on_script_error(result):
    """
    Upstream's execute_extend_script returns a thrown script as a normal
    SUCCESS carrying {error, line}, so a broken script looked like a working
    one and only a careful model would notice. build.sh routes that tool's
    return value through here.
    """
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
        raise RuntimeError(f"The script failed: {parsed['error']}{where}")
    return result

# ===========================================================================
# Orientation
# ===========================================================================

@mcp.tool()
def get_instructions() -> str:
    """Read this first. How to work with Illustrator through these tools."""
    return """
You are driving Adobe Illustrator through a live panel. The user's document is
already open — work on it. Don't create a new document unless asked.

ADDRESSING
  Every tool that touches an existing item takes `item`, which is the `id`
  returned by list_items / find_items / any create_* tool. Names also work, but
  only when unique — a name matching two items is refused rather than guessed
  at, because silently editing the wrong object is worse than an error.

COORDINATES
  x, y are pixels from the TOP-LEFT of the artboard, y increasing DOWNWARD.
  Pass center=true to centre something and skip the arithmetic.
  Colours are hex strings ("#ff0000"). CMYK documents are converted for you.

HOW TO WORK
  1. Orient with list_artboards, list_items or find_items. Prefer these over
     get_active_document_info, which returns far more than you usually need.
  2. Use the specific tools for anything they cover — cheaper, faster and much
     less error-prone than writing a script.
  3. Fall back to execute_extend_script only for what no tool covers:
     gradients, blends, complex path geometry, Pathfinder.

KNOWN LIMITS — don't promise these
  Pathfinder, Offset Path and the whole Effect menu (drop shadows, warps) have
  no scripting API in Illustrator. They can sometimes be reached via menu
  commands, but not reliably. Say so rather than producing something that
  silently isn't what was asked for. Image Trace does have a real API.

CARE
  You are editing someone's real, possibly unsaved document. Prefer additive
  changes. Don't delete or restyle work you did not create unless asked.
"""


# ===========================================================================
# Orientation — reading the document
# ===========================================================================

@mcp.tool()
def list_artboards():
    """Lists artboards: index, name, size, and which one is active."""
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
def list_items(artboard: int = -1, limit: int = 200):
    """
    Lists items on an artboard with their ids, names, positions and sizes.

    Args:
        artboard: artboard index, or -1 for the active one.
        limit: stop after this many (documents can hold thousands).
    """
    return _run(_js("""
        var doc=_doc(), r=_r(doc, $AB), out=[];
        for(var i=0;i<doc.pageItems.length && out.length<$LIMIT;i++){
            var it=doc.pageItems[i], p=it.position;
            if(p[0] >= r[0]-1 && p[0] <= r[2]+1 && p[1] <= r[1]+1 && p[1] >= r[3]-1){
                out.push(_brief(it));
            }
        }
        return JSON.stringify({ items:out, truncated:(out.length>=$LIMIT) });
    """, AB=artboard, LIMIT=limit))


@mcp.tool()
def find_items(text: str = None, kind: str = None, layer: str = None, limit: int = 100):
    """
    Finds items anywhere in the document.

    Args:
        text: match against the item name, or the contents of a text frame.
        kind: filter by type — TextFrame, PathItem, GroupItem, PlacedItem,
              RasterItem, CompoundPathItem, SymbolItem.
        layer: restrict to a layer name.
        limit: maximum results.
    """
    return _run(_js("""
        var doc=_doc(), out=[], q=$TEXT, kind=$KIND, lay=$LAYER;
        var qq = q ? String(q).toLowerCase() : null;
        for(var i=0;i<doc.pageItems.length && out.length<$LIMIT;i++){
            var it=doc.pageItems[i];
            if(kind && it.typename !== kind) continue;
            if(lay){ try { if(it.layer.name !== lay) continue; } catch(e){ continue; } }
            if(qq){
                var hay = String(it.name||"").toLowerCase();
                if(it.typename==="TextFrame"){ try { hay += " " + String(it.contents||"").toLowerCase(); } catch(e){} }
                if(hay.indexOf(qq) === -1) continue;
            }
            var b=_brief(it);
            if(it.typename==="TextFrame"){ try { b.text=String(it.contents).substr(0,120); } catch(e){} }
            try { b.layer = it.layer.name; } catch(e){}
            out.push(b);
        }
        return JSON.stringify(out);
    """, TEXT=text, KIND=kind, LAYER=layer, LIMIT=limit))


@mcp.tool()
def get_selection():
    """Returns what the user currently has selected — useful for 'this' or 'the selected one'."""
    return _run("""
        var doc=_doc(), sel=doc.selection, out=[];
        for(var i=0;i<sel.length;i++){ try { out.push(_brief(sel[i])); } catch(e){} }
        return JSON.stringify(out);
    """)


@mcp.tool()
def select_items(items: list):
    """
    Selects items on the canvas, so the user can see what you mean.

    Args:
        items: list of ids or unique names. Empty list clears the selection.
    """
    return _run(_js("""
        var doc=_doc(), refs=$ITEMS;
        doc.selection = null;
        var picked=[];
        for(var i=0;i<refs.length;i++){ var it=_find(doc, refs[i]); it.selected=true; picked.push(_brief(it)); }
        return JSON.stringify(picked);
    """, ITEMS=items or []))


# ===========================================================================
# Creating
# ===========================================================================

@mcp.tool()
def create_rectangle(width: float, height: float, x: float = 0, y: float = 0,
                     fill: str = "#000000", stroke: str = None, stroke_width: float = 1,
                     name: str = None, artboard: int = -1, center: bool = False,
                     corner_radius: float = 0):
    """
    Draws a rectangle. Returns its id.

    Args:
        width, height: size in points.
        x, y: from the artboard's top-left, y downward. Ignored if center.
        fill: hex colour, or empty string for no fill.
        stroke: hex colour, or omit for no stroke.
        stroke_width: stroke weight in points.
        name: a label; the returned id is what other tools should use.
        artboard: index, or -1 for the active artboard.
        center: centre on the artboard and ignore x/y.
        corner_radius: rounded corners, in points. 0 for square corners.
    """
    return _run(_js("""
        var doc=_doc();
        var p=_pos(doc, $AB, $X, $Y, $W, $H, $CENTER);
        var it = ($RADIUS > 0)
            ? doc.pathItems.roundedRectangle(p[1], p[0], $W, $H, $RADIUS, $RADIUS)
            : doc.pathItems.rectangle(p[1], p[0], $W, $H);
        _style(doc, it, $FILL, $STROKE, $SW);
        if($NAME) it.name=$NAME;
        return JSON.stringify(_brief(it));
    """, AB=artboard, X=x, Y=y, W=width, H=height, CENTER=center,
         RADIUS=corner_radius, FILL=fill, STROKE=stroke, SW=stroke_width, NAME=name))


@mcp.tool()
def create_ellipse(width: float, height: float, x: float = 0, y: float = 0,
                   fill: str = "#000000", stroke: str = None, stroke_width: float = 1,
                   name: str = None, artboard: int = -1, center: bool = False):
    """Draws an ellipse. Equal width and height gives a circle. Returns its id."""
    return _run(_js("""
        var doc=_doc();
        var p=_pos(doc, $AB, $X, $Y, $W, $H, $CENTER);
        var it=doc.pathItems.ellipse(p[1], p[0], $W, $H);
        _style(doc, it, $FILL, $STROKE, $SW);
        if($NAME) it.name=$NAME;
        return JSON.stringify(_brief(it));
    """, AB=artboard, X=x, Y=y, W=width, H=height, CENTER=center,
         FILL=fill, STROKE=stroke, SW=stroke_width, NAME=name))


@mcp.tool()
def create_line(x1: float, y1: float, x2: float, y2: float,
                stroke: str = "#000000", stroke_width: float = 1,
                name: str = None, artboard: int = -1):
    """Draws a straight line between two artboard-relative points."""
    return _run(_js("""
        var doc=_doc(), r=_r(doc, $AB);
        var it=doc.pathItems.add();
        it.setEntirePath([[r[0]+$X1, r[1]-$Y1],[r[0]+$X2, r[1]-$Y2]]);
        it.filled=false; it.stroked=true;
        it.strokeColor=_color(doc,$STROKE); it.strokeWidth=$SW;
        if($NAME) it.name=$NAME;
        return JSON.stringify(_brief(it));
    """, AB=artboard, X1=x1, Y1=y1, X2=x2, Y2=y2, STROKE=stroke, SW=stroke_width, NAME=name))


@mcp.tool()
def create_text(text: str, x: float = 0, y: float = 0, size: float = 24,
                color: str = "#000000", font: str = None, name: str = None,
                artboard: int = -1, center: bool = False, width: float = None):
    """
    Adds text. Returns its id.

    Args:
        text: the string. Use \\n for line breaks.
        x, y: the text's top-left, from the artboard's top-left.
        size: font size in points.
        color: hex.
        font: PostScript name (e.g. "Helvetica-Bold"). Omit for the document
              default. Use list_fonts to find valid names — a name Illustrator
              does not have raises an error.
        center: centre the frame on the artboard.
        width: give a width to create a wrapping area-text box instead of a
               single-line point text.
    """
    return _run(_js("""
        var doc=_doc(), r=_r(doc, $AB), t;
        if($WIDTH){
            var box=doc.pathItems.rectangle(r[1]-$Y, r[0]+$X, $WIDTH, Math.max($SIZE*3, 40));
            t=doc.textFrames.areaText(box);
        } else {
            t=doc.textFrames.add();
        }
        t.contents=$TEXT;
        t.textRange.characterAttributes.size=$SIZE;
        t.textRange.characterAttributes.fillColor=_color(doc, $COLOR);
        if($FONT){
            try { t.textRange.characterAttributes.textFont=app.textFonts.getByName($FONT); }
            catch(e){ throw new Error("Font not available: " + $FONT + ". Use list_fonts."); }
        }
        if($CENTER){ t.position=[ (r[0]+r[2])/2 - t.width/2, (r[1]+r[3])/2 + t.height/2 ]; }
        else if(!$WIDTH){ t.position=[ r[0] + $X, r[1] - $Y ]; }
        if($NAME) t.name=$NAME;
        return JSON.stringify(_brief(t));
    """, AB=artboard, X=x, Y=y, SIZE=size, COLOR=color, FONT=font,
         TEXT=text, CENTER=center, NAME=name, WIDTH=width))


@mcp.tool()
def place_image(path: str, x: float = 0, y: float = 0, width: float = None,
                name: str = None, artboard: int = -1, embed: bool = False):
    """
    Places an image file into the document.

    Args:
        path: absolute path to the image.
        x, y: top-left, from the artboard's top-left.
        width: scale proportionally to this width. Omit for native size.
        embed: embed the image rather than linking it.
    """
    return _run(_js("""
        var doc=_doc(), r=_r(doc, $AB);
        var f=new File($PATH);
        if(!f.exists) throw new Error("No file at " + $PATH);
        var it=doc.placedItems.add();
        it.file=f;
        if($WIDTH){ var s=($WIDTH/it.width)*100; it.resize(s,s); }
        it.position=[ r[0]+$X, r[1]-$Y ];
        if($NAME) it.name=$NAME;
        if($EMBED){ it.embed(); }
        var out=_brief(doc.pageItems[0]);
        return JSON.stringify(out);
    """, AB=artboard, PATH=path, X=x, Y=y, WIDTH=width, NAME=name, EMBED=embed))


@mcp.tool()
def create_artboard(width: float, height: float, name: str = None):
    """Adds an artboard to the right of the existing ones."""
    return _run(_js("""
        var doc=_doc(), right=-1e9, top=0;
        for(var i=0;i<doc.artboards.length;i++){
            var r=doc.artboards[i].artboardRect;
            if(r[2]>right){ right=r[2]; top=r[1]; }
        }
        var ab=doc.artboards.add([right+40, top, right+40+$W, top-$H]);
        if($NAME) ab.name=$NAME;
        return JSON.stringify({ index:doc.artboards.length-1, name:ab.name });
    """, W=width, H=height, NAME=name))


@mcp.tool()
def rename_artboard(artboard: int, name: str):
    """Renames an artboard by index."""
    return _run(_js("""
        var doc=_doc(), ab=_ab(doc, $AB);
        ab.name=$NAME;
        return JSON.stringify({ index:$AB, name:ab.name });
    """, AB=artboard, NAME=name))


# ===========================================================================
# Modifying
# ===========================================================================

@mcp.tool()
def set_fill(item: str, fill: str = None, stroke: str = None, stroke_width: float = 1):
    """
    Recolours an item.

    Args:
        item: id from list_items, or a unique name.
        fill: hex colour, or empty string to remove the fill.
        stroke: hex colour, or empty string to remove the stroke.
    """
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        var f=$FILL, s=$STROKE;
        if(f!==null){ if(f===""){ it.filled=false; } else { it.filled=true; it.fillColor=_color(doc,f); } }
        if(s!==null){ if(s===""){ it.stroked=false; } else { it.stroked=true; it.strokeColor=_color(doc,s); it.strokeWidth=$SW; } }
        return JSON.stringify(_brief(it));
    """, ITEM=item, FILL=fill, STROKE=stroke, SW=stroke_width))


@mcp.tool()
def recolor_items(items: list, fill: str = None, stroke: str = None):
    """
    Recolours several items at once — one round trip instead of many.

    Args:
        items: list of ids or unique names.
        fill, stroke: hex colours, or empty string to remove.
    """
    return _run(_js("""
        var doc=_doc(), refs=$ITEMS, f=$FILL, s=$STROKE, out=[];
        for(var i=0;i<refs.length;i++){
            var it=_find(doc, refs[i]);
            if(f!==null){ if(f===""){ it.filled=false; } else { it.filled=true; it.fillColor=_color(doc,f); } }
            if(s!==null){ if(s===""){ it.stroked=false; } else { it.stroked=true; it.strokeColor=_color(doc,s); } }
            out.push(_brief(it));
        }
        return JSON.stringify(out);
    """, ITEMS=items or [], FILL=fill, STROKE=stroke))


@mcp.tool()
def move_item(item: str, x: float, y: float, artboard: int = -1):
    """Moves an item so its top-left sits at x, y from the artboard's top-left."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM), r=_r(doc, $AB);
        it.position=[ r[0] + $X, r[1] - $Y ];
        return JSON.stringify(_brief(it));
    """, ITEM=item, AB=artboard, X=x, Y=y))


@mcp.tool()
def resize_item(item: str, width: float = None, height: float = None):
    """Resizes an item. Give only one dimension to scale proportionally."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        var w=$W, h=$H;
        var sx = (w===null) ? null : (w/it.width)*100;
        var sy = (h===null) ? null : (h/it.height)*100;
        if(sx===null) sx=sy;
        if(sy===null) sy=sx;
        it.resize(sx, sy);
        return JSON.stringify(_brief(it));
    """, ITEM=item, W=width, H=height))


@mcp.tool()
def rotate_item(item: str, degrees: float):
    """Rotates an item around its centre. Positive is anticlockwise."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        it.rotate($DEG);
        return JSON.stringify(_brief(it));
    """, ITEM=item, DEG=degrees))


@mcp.tool()
def set_opacity(item: str, opacity: float):
    """Sets an item's opacity, 0 to 100."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        it.opacity=$O;
        return JSON.stringify(_brief(it));
    """, ITEM=item, O=opacity))


@mcp.tool()
def align_item(item: str, horizontal: str = "center", vertical: str = "center", artboard: int = -1):
    """
    Aligns an item to its artboard.

    Args:
        horizontal: left, center, right, or none.
        vertical: top, center, bottom, or none.
    """
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM), r=_r(doc, $AB);
        var p=it.position, x=p[0], y=p[1], H=$H, V=$V;
        if(H==="left"){ x=r[0]; } else if(H==="right"){ x=r[2]-it.width; }
        else if(H==="center"){ x=(r[0]+r[2])/2 - it.width/2; }
        if(V==="top"){ y=r[1]; } else if(V==="bottom"){ y=r[3]+it.height; }
        else if(V==="center"){ y=(r[1]+r[3])/2 + it.height/2; }
        it.position=[x,y];
        return JSON.stringify(_brief(it));
    """, ITEM=item, AB=artboard, H=horizontal, V=vertical))


@mcp.tool()
def distribute_items(items: list, axis: str = "horizontal", spacing: float = None):
    """
    Spreads items evenly.

    Args:
        items: ids or unique names, at least three (or two with spacing).
        axis: horizontal or vertical.
        spacing: fixed gap in points. Omit to spread evenly between the
                 outermost two items.
    """
    return _run(_js("""
        var doc=_doc(), refs=$ITEMS, axis=$AXIS, gap=$GAP, list=[];
        for(var i=0;i<refs.length;i++){ list.push(_find(doc, refs[i])); }
        if(list.length<2) throw new Error("Need at least two items to distribute.");
        var horiz = (axis==="horizontal");
        list.sort(function(a,b){ return horiz ? a.position[0]-b.position[0] : b.position[1]-a.position[1]; });
        if(gap===null){
            var first=list[0], last=list[list.length-1];
            var startA = horiz ? first.position[0] : first.position[1];
            var endA   = horiz ? last.position[0]  : last.position[1];
            var step=(endA-startA)/(list.length-1);
            for(var j=1;j<list.length-1;j++){
                var p=list[j].position;
                if(horiz){ p[0]=startA+step*j; } else { p[1]=startA+step*j; }
                list[j].position=p;
            }
        } else {
            var cursor = horiz ? list[0].position[0] : list[0].position[1];
            for(var k=1;k<list.length;k++){
                var prev=list[k-1];
                cursor = horiz ? (cursor + prev.width + gap) : (cursor - prev.height - gap);
                var q=list[k].position;
                if(horiz){ q[0]=cursor; } else { q[1]=cursor; }
                list[k].position=q;
            }
        }
        var out=[]; for(var m=0;m<list.length;m++){ out.push(_brief(list[m])); }
        return JSON.stringify(out);
    """, ITEMS=items or [], AXIS=axis, GAP=spacing))


@mcp.tool()
def duplicate_item(item: str, new_name: str = None, x: float = None, y: float = None,
                   artboard: int = -1):
    """
    Duplicates an item, optionally placing the copy somewhere specific.

    Args:
        item: id or unique name.
        x, y: where to put the copy, from the target artboard's top-left.
        artboard: which artboard x/y refer to.
    """
    move = ""
    if x is not None and y is not None:
        move = _js("var r=_r(doc, $AB); c.position=[ r[0] + $X, r[1] - $Y ];", AB=artboard, X=x, Y=y)
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        var c=it.duplicate();
        try { c.note = String(c.note||"").replace(/\\[amcp:[a-z0-9]+\\]/, ""); } catch(e){}
        if($NEWNAME) c.name=$NEWNAME;
        $MOVE
        return JSON.stringify(_brief(c));
    """, ITEM=item, NEWNAME=new_name).replace("$MOVE", move))


@mcp.tool()
def delete_item(item: str):
    """Deletes an item. Only remove work the user asked you to remove."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        var n=it.name, id=_handle(it);
        it.remove();
        return JSON.stringify({ deleted:n, id:id });
    """, ITEM=item))


@mcp.tool()
def group_items(items: list, name: str = None):
    """Groups items together. Returns the group's id."""
    return _run(_js("""
        var doc=_doc(), refs=$ITEMS;
        if(refs.length<2) throw new Error("Need at least two items to group.");
        var first=_find(doc, refs[0]);
        var g=doc.groupItems.add();
        g.move(first, ElementPlacement.PLACEBEFORE);
        for(var i=0;i<refs.length;i++){ _find(doc, refs[i]).move(g, ElementPlacement.INSIDE); }
        if($NAME) g.name=$NAME;
        return JSON.stringify(_brief(g));
    """, ITEMS=items or [], NAME=name))


# ===========================================================================
# Text
# ===========================================================================

@mcp.tool()
def set_text_content(item: str, text: str):
    """Replaces the contents of a text frame."""
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        if(it.typename!=="TextFrame") throw new Error("'"+it.name+"' is a "+it.typename+", not text.");
        it.contents=$TEXT;
        return JSON.stringify(_brief(it));
    """, ITEM=item, TEXT=text))


@mcp.tool()
def set_font(item: str, font: str = None, size: float = None, color: str = None,
             tracking: float = None, leading: float = None):
    """
    Restyles a text frame.

    Args:
        item: id or unique name of a text frame.
        font: PostScript name — see list_fonts.
        size: points.
        color: hex.
        tracking: letter spacing, in thousandths of an em.
        leading: line spacing in points.
    """
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM);
        if(it.typename!=="TextFrame") throw new Error("'"+it.name+"' is a "+it.typename+", not text.");
        var a=it.textRange.characterAttributes;
        if($SIZE!==null) a.size=$SIZE;
        if($COLOR!==null) a.fillColor=_color(doc,$COLOR);
        if($TRACK!==null) a.tracking=$TRACK;
        if($LEAD!==null) a.leading=$LEAD;
        if($FONT!==null){
            try { a.textFont=app.textFonts.getByName($FONT); }
            catch(e){ throw new Error("Font not available: " + $FONT + ". Use list_fonts."); }
        }
        return JSON.stringify(_brief(it));
    """, ITEM=item, FONT=font, SIZE=size, COLOR=color, TRACK=tracking, LEAD=leading))


@mcp.tool()
def list_fonts(contains: str = None, limit: int = 60):
    """
    Lists installed fonts by PostScript name — the names set_font expects.

    Args:
        contains: filter, e.g. "Helvetica". Strongly recommended: there are
                  usually hundreds of fonts installed.
    """
    return _run(_js("""
        var out=[], q=$Q, qq=q?String(q).toLowerCase():null;
        for(var i=0;i<app.textFonts.length && out.length<$LIMIT;i++){
            var f=app.textFonts[i];
            if(qq && String(f.name).toLowerCase().indexOf(qq)===-1) continue;
            out.push({ postScriptName:f.name, family:f.family, style:f.style });
        }
        return JSON.stringify({ fonts:out, total:app.textFonts.length });
    """, Q=contains, LIMIT=limit))


# ===========================================================================
# Layers
# ===========================================================================

@mcp.tool()
def list_layers():
    """Lists layers with their visibility, lock state and item counts."""
    return _run("""
        var doc=_doc(), out=[];
        for(var i=0;i<doc.layers.length;i++){
            var l=doc.layers[i];
            out.push({ name:l.name, visible:l.visible, locked:l.locked,
                       items:l.pageItems.length, opacity:Math.round(l.opacity) });
        }
        return JSON.stringify(out);
    """)


@mcp.tool()
def create_layer(name: str):
    """Adds a layer at the top of the stack."""
    return _run(_js("""
        var doc=_doc(), l=doc.layers.add();
        l.name=$NAME;
        return JSON.stringify({ name:l.name, visible:l.visible, locked:l.locked });
    """, NAME=name))


@mcp.tool()
def set_layer_state(name: str, visible: bool = None, locked: bool = None):
    """Shows, hides, locks or unlocks a layer."""
    return _run(_js("""
        var doc=_doc(), l=_layerByName(doc, $NAME);
        if($VIS!==null) l.visible=$VIS;
        if($LOCK!==null) l.locked=$LOCK;
        return JSON.stringify({ name:l.name, visible:l.visible, locked:l.locked });
    """, NAME=name, VIS=visible, LOCK=locked))


@mcp.tool()
def move_to_layer(items: list, layer: str):
    """Moves items onto a layer."""
    return _run(_js("""
        var doc=_doc(), l=_layerByName(doc, $LAYER), refs=$ITEMS, out=[];
        for(var i=0;i<refs.length;i++){
            var it=_find(doc, refs[i]);
            it.move(l, ElementPlacement.PLACEATBEGINNING);
            out.push(_brief(it));
        }
        return JSON.stringify(out);
    """, ITEMS=items or [], LAYER=layer))


# ===========================================================================
# Colour
# ===========================================================================

@mcp.tool()
def list_swatches(limit: int = 80):
    """Lists the document's swatches, with hex values where they convert cleanly."""
    return _run(_js("""
        var doc=_doc(), out=[];
        function hex(n){ var s=Math.round(n).toString(16); return s.length<2 ? "0"+s : s; }
        for(var i=0;i<doc.swatches.length && out.length<$LIMIT;i++){
            var s=doc.swatches[i], e={ name:s.name };
            try {
                var c=s.color;
                if(c.typename==="RGBColor"){ e.hex="#"+hex(c.red)+hex(c.green)+hex(c.blue); }
                else if(c.typename==="CMYKColor"){ e.cmyk=[Math.round(c.cyan),Math.round(c.magenta),Math.round(c.yellow),Math.round(c.black)]; }
                else if(c.typename==="GrayColor"){ e.gray=Math.round(c.gray); }
                else { e.kind=c.typename; }
            } catch(err){}
            out.push(e);
        }
        return JSON.stringify(out);
    """, LIMIT=limit))


@mcp.tool()
def apply_swatch(item: str, swatch: str, to: str = "fill"):
    """
    Applies a named document swatch to an item.

    Args:
        item: id or unique name.
        swatch: swatch name from list_swatches.
        to: fill or stroke.
    """
    return _run(_js("""
        var doc=_doc(), it=_find(doc, $ITEM), sw=null;
        for(var i=0;i<doc.swatches.length;i++){ if(doc.swatches[i].name===$SW){ sw=doc.swatches[i]; break; } }
        if(!sw) throw new Error("No swatch named '"+$SW+"'. Use list_swatches.");
        if($TO==="stroke"){ it.stroked=true; it.strokeColor=sw.color; }
        else { it.filled=true; it.fillColor=sw.color; }
        return JSON.stringify(_brief(it));
    """, ITEM=item, SW=swatch, TO=to))


# ===========================================================================
# Output
# ===========================================================================

@mcp.tool()
def export_artboard_png(path: str, artboard: int = -1, scale: float = 100,
                        transparent: bool = True):
    """
    Exports one artboard as a PNG.

    Args:
        path: absolute output path, ending .png.
        artboard: index, or -1 for the active one.
        scale: percentage. 200 gives a 2x export.
        transparent: keep transparency rather than filling white.
    """
    return _run(_js("""
        var doc=_doc();
        var idx = ($AB < 0) ? doc.artboards.getActiveArtboardIndex() : $AB;
        var prev = doc.artboards.getActiveArtboardIndex();
        doc.artboards.setActiveArtboardIndex(idx);
        var o=new ExportOptionsPNG24();
        o.antiAliasing=true; o.transparency=$TRANS;
        o.artBoardClipping=true;
        o.horizontalScale=$SCALE; o.verticalScale=$SCALE;
        doc.exportFile(_file($PATH), ExportType.PNG24, o);
        doc.artboards.setActiveArtboardIndex(prev);
        var f=new File($PATH);
        return JSON.stringify({ path:$PATH, exists:f.exists, artboard:idx });
    """, PATH=path, AB=artboard, SCALE=scale, TRANS=transparent))


@mcp.tool()
def export_svg(path: str):
    """Exports the document as SVG. path should end .svg."""
    return _run(_js("""
        var doc=_doc();
        var o=new ExportOptionsSVG();
        o.embedRasterImages=true;
        doc.exportFile(_file($PATH), ExportType.SVG, o);
        var f=new File($PATH);
        return JSON.stringify({ path:$PATH, exists:f.exists });
    """, PATH=path))


@mcp.tool()
def save_as(path: str):
    """
    Saves the document to a new .ai file. Does not overwrite silently — it
    fails if something is already there.
    """
    return _run(_js("""
        var doc=_doc(), f=new File($PATH);
        if(f.exists) throw new Error("A file already exists at " + $PATH + ". Choose another name.");
        doc.saveAs(_file($PATH));
        return JSON.stringify({ path:$PATH, saved:true });
    """, PATH=path))
