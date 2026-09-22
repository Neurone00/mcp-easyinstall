
# ---------------------------------------------------------------------------
# Adobe MCP additions — appended to ae-mcp.py at build time by build.sh.
#
# After Effects upstream exposes exactly one tool, execute_extend_script, and
# nothing tells a model that raw scripting is therefore its only option. The
# tools below cover the effects workflow properly: list what is installed,
# apply an effect, set and animate its parameters, and apply an .ffx preset.
#
# On match names: every effect has a stable internal id ("ADBE Gaussian Blur 2")
# that does not change between versions or UI languages, unlike the display
# name. We deliberately do NOT ship a bundled list of them — the published
# tables are Adobe copyright, and app.effects enumerates what is ACTUALLY
# installed on this machine, third-party plugins included. That is both
# licence-clean and more accurate.
# ---------------------------------------------------------------------------

import json as _json


def _js(template: str, **values) -> str:
    """Substitute $NAME placeholders with JSON-encoded values (see ai addon)."""
    for key, value in values.items():
        template = template.replace("$" + key, _json.dumps(value))
    return template


_PRELUDE = r"""
function _proj(){ if(!app.project) throw new Error("No project is open."); return app.project; }
function _comp(name){
    var p=_proj();
    if(name){
        for(var i=1;i<=p.numItems;i++){
            var it=p.item(i);
            if(it instanceof CompItem && it.name===name) return it;
        }
        throw new Error("No composition named '"+name+"'.");
    }
    var c=p.activeItem;
    if(!(c instanceof CompItem)) throw new Error("No composition is open. Open one, or pass comp by name.");
    return c;
}
function _layer(comp, ref){
    if(typeof ref === "number") {
        if(ref<1 || ref>comp.numLayers) throw new Error("Layer "+ref+" doesn't exist (comp has "+comp.numLayers+").");
        return comp.layer(ref);
    }
    for(var i=1;i<=comp.numLayers;i++){ if(comp.layer(i).name===ref) return comp.layer(i); }
    throw new Error("No layer named '"+ref+"' in '"+comp.name+"'.");
}
function _fx(layer){
    var g=layer.property("ADBE Effect Parade");
    if(!g) throw new Error("'"+layer.name+"' can't take effects (cameras and lights have no Effects group).");
    return g;
}
/* Effects are looked up by match name first, then display name. */
function _effect(layer, ref){
    var g=_fx(layer);
    for(var i=1;i<=g.numProperties;i++){
        var e=g.property(i);
        if(e.matchName===ref || e.name===ref) return e;
    }
    throw new Error("'"+layer.name+"' has no effect '"+ref+"'. Use list_layer_effects.");
}
function _param(effect, ref){
    if(typeof ref === "number") return effect.property(ref);
    for(var i=1;i<=effect.numProperties;i++){
        var p=effect.property(i);
        if(p.matchName===ref || p.name===ref) return p;
    }
    throw new Error("'"+effect.name+"' has no parameter '"+ref+"'. Use describe_effect.");
}
"""


def _run(body: str):
    """
    Run generated ExtendScript and turn an in-band error into a real failure.

    The panel returns a thrown script as {error, line} inside a SUCCESS result,
    so without this a broken script looks like a working one.
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
        raise RuntimeError(f"After Effects rejected that: {parsed['error']}{where}")
    return parsed


@mcp.tool()
def get_instructions() -> str:
    """Read this first. How to work with After Effects through these tools."""
    return """
You are driving Adobe After Effects through a live panel.

WHAT YOU HAVE
  list_compositions, list_layers, list_effects, list_layer_effects,
  describe_effect, apply_effect, set_effect_parameter, animate_property,
  apply_preset, and execute_extend_script for everything else.

EFFECTS
  Effects are addressed by MATCH NAME — a stable internal id like
  "ADBE Gaussian Blur 2" — not by the name shown in the UI, which changes with
  the interface language. Call list_effects to find the match name for what you
  want; it searches everything installed on this machine, including third-party
  plugins (Video Copilot, Red Giant, Boris FX and so on), which work exactly
  like built-in ones.

  After applying an effect, call describe_effect to see its real parameter
  names before setting anything. Parameter names vary more than you would
  expect, and guessing wastes a round trip.

ANIMATION
  set_effect_parameter sets a static value. animate_property creates keyframes
  with optional easing. Times are in seconds.

WHAT IS NOT SCRIPTABLE — don't promise these
  Roto Brush, Content-Aware Fill, mask tracking, and reading rendered pixels
  have no scripting API at all. Say so plainly rather than producing something
  that looks like it worked.

CARE
  Every tool here wraps its changes in an undo group, so the user can undo your
  work in one step. If you fall back to execute_extend_script, do the same:
  app.beginUndoGroup("...") / app.endUndoGroup().
  This is someone's real project — prefer additive changes.
"""


@mcp.tool()
def list_compositions():
    """Lists the compositions in the project."""
    return _run("""
        var p=_proj(), out=[];
        for(var i=1;i<=p.numItems;i++){
            var it=p.item(i);
            if(it instanceof CompItem){
                out.push({ name:it.name, width:it.width, height:it.height,
                           duration:Math.round(it.duration*100)/100,
                           frameRate:it.frameRate, layers:it.numLayers,
                           active:(app.project.activeItem===it) });
            }
        }
        return JSON.stringify(out);
    """)


@mcp.tool()
def list_layers(comp: str = None):
    """
    Lists the layers of a composition.

    Args:
        comp: composition name. Omit for the one currently open.
    """
    return _run(_js("""
        var c=_comp($COMP), out=[];
        for(var i=1;i<=c.numLayers;i++){
            var l=c.layer(i);
            var fxCount=0;
            try { var g=l.property("ADBE Effect Parade"); fxCount = g ? g.numProperties : 0; } catch(e){}
            out.push({ index:i, name:l.name, type:l.matchName, enabled:l.enabled,
                       inPoint:Math.round(l.inPoint*100)/100,
                       outPoint:Math.round(l.outPoint*100)/100, effects:fxCount });
        }
        return JSON.stringify({ comp:c.name, layers:out });
    """, COMP=comp))


@mcp.tool()
def list_effects(contains: str = None, limit: int = 60):
    """
    Lists effects installed on this machine, with their match names.

    Generated from After Effects itself, so it includes every third-party
    plugin you have. Use the match name with apply_effect.

    Args:
        contains: filter, e.g. "blur" or "particular". Strongly recommended —
                  a typical install has several hundred effects.
    """
    return _run(_js("""
        var out=[], q=$Q, qq=q?String(q).toLowerCase():null, total=0;
        var all=app.effects;
        for(var i=0;i<all.length;i++){
            var e=all[i];
            var hay=(String(e.displayName)+" "+String(e.matchName)+" "+String(e.category)).toLowerCase();
            if(qq && hay.indexOf(qq)===-1) continue;
            total++;
            if(out.length<$LIMIT){
                out.push({ name:e.displayName, matchName:e.matchName, category:e.category });
            }
        }
        return JSON.stringify({ effects:out, matched:total, installed:all.length });
    """, Q=contains, LIMIT=limit))


@mcp.tool()
def list_layer_effects(layer, comp: str = None):
    """
    Lists the effects already on a layer, in order.

    Args:
        layer: layer name, or its 1-based index.
        comp: composition name. Omit for the one currently open.
    """
    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER), g=_fx(l), out=[];
        for(var i=1;i<=g.numProperties;i++){
            var e=g.property(i);
            out.push({ index:i, name:e.name, matchName:e.matchName, enabled:e.enabled });
        }
        return JSON.stringify({ layer:l.name, effects:out });
    """, COMP=comp, LAYER=layer))


@mcp.tool()
def describe_effect(layer, effect: str, comp: str = None):
    """
    Lists an applied effect's parameters and their current values.

    Call this after apply_effect and before set_effect_parameter — parameter
    names are not guessable, and a wrong guess costs a round trip.

    Args:
        layer: layer name or 1-based index.
        effect: the effect's match name or display name, as applied.
    """
    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER), e=_effect(l, $FX), out=[];
        for(var i=1;i<=e.numProperties;i++){
            var p=e.property(i);
            var entry={ index:i, name:p.name, matchName:p.matchName };
            try { entry.type = p.propertyValueType; } catch(err){}
            try { if(p.propertyValueType !== PropertyValueType.NO_VALUE) entry.value = p.value; } catch(err){}
            try { entry.keyframes = p.numKeys; } catch(err){}
            try { entry.canAnimate = p.canSetExpression; } catch(err){}
            out.push(entry);
        }
        return JSON.stringify({ effect:e.name, matchName:e.matchName, parameters:out });
    """, COMP=comp, LAYER=layer, FX=effect))


@mcp.tool()
def apply_effect(layer, match_name: str, comp: str = None, name: str = None):
    """
    Applies an effect to a layer.

    Args:
        layer: layer name or 1-based index.
        match_name: the effect's match name from list_effects, e.g.
                    "ADBE Gaussian Blur 2". Third-party plugins work the same way.
        comp: composition name. Omit for the one currently open.
        name: rename the effect instance, handy when applying several of the same.
    """
    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER), g=_fx(l);
        if(!g.canAddProperty($MATCH)){
            throw new Error("This layer won't take '"+$MATCH+"'. Check the match name with list_effects, and that the layer type supports it.");
        }
        app.beginUndoGroup("Adobe MCP: apply effect");
        var e;
        try {
            e=g.addProperty($MATCH);
            if($NAME) e.name=$NAME;
        } finally { app.endUndoGroup(); }
        var params=[];
        for(var i=1;i<=e.numProperties;i++){
            var p=e.property(i);
            params.push({ index:i, name:p.name, matchName:p.matchName });
        }
        return JSON.stringify({ layer:l.name, effect:e.name, matchName:e.matchName,
                                index:e.propertyIndex, parameters:params });
    """, COMP=comp, LAYER=layer, MATCH=match_name, NAME=name))


@mcp.tool()
def set_effect_parameter(layer, effect: str, parameter, value, comp: str = None):
    """
    Sets one parameter of an applied effect.

    Args:
        layer: layer name or 1-based index.
        effect: the effect's match name or display name.
        parameter: parameter name, match name, or 1-based index — see describe_effect.
        value: a number, or a list for multi-dimensional values. Colours are
               [r, g, b, a] with each component from 0 to 1, NOT 0-255.
        comp: composition name. Omit for the one currently open.
    """
    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER), e=_effect(l, $FX), p=_param(e, $PARAM);
        app.beginUndoGroup("Adobe MCP: set parameter");
        try {
            /* setValue throws once a property has keyframes. */
            if(p.numKeys > 0){ p.setValueAtTime(c.time, $VALUE); }
            else { p.setValue($VALUE); }
        } finally { app.endUndoGroup(); }
        return JSON.stringify({ effect:e.name, parameter:p.name, value:p.value });
    """, COMP=comp, LAYER=layer, FX=effect, PARAM=parameter, VALUE=value))


@mcp.tool()
def animate_property(layer, times: list, values: list, effect: str = None,
                     parameter=None, property_path: str = None, comp: str = None,
                     easing: str = "ease"):
    """
    Keyframes a property — either an effect parameter or a layer transform.

    Args:
        layer: layer name or 1-based index.
        times: keyframe times in seconds, e.g. [0, 1.5, 3].
        values: one value per time. Numbers, or lists for position/scale/colour.
        effect + parameter: to animate an effect parameter.
        property_path: to animate a transform instead, e.g. "Position",
                       "Scale", "Rotation", "Opacity". Use this OR effect.
        easing: "ease" for smooth in/out, "linear" for none, "hold" for steps.
    """
    if not times or not values or len(times) != len(values):
        raise ValueError("times and values must be non-empty and the same length.")

    target = (
        _js("var p=_param(_effect(l, $FX), $PARAM);", FX=effect, PARAM=parameter)
        if effect is not None else
        _js("""var p=l.property($PATH);
               if(!p) throw new Error("No property '"+$PATH+"' on '"+l.name+"'.");""",
            PATH=property_path)
    )

    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER);
        $TARGET
        app.beginUndoGroup("Adobe MCP: animate");
        try {
            p.setValuesAtTimes($TIMES, $VALUES);
            var mode=$EASING;
            for(var k=1;k<=p.numKeys;k++){
                if(mode==="hold"){
                    p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                } else if(mode==="linear"){
                    p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                } else {
                    p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                    /* influence must be 0.1-100; 0 is rejected. One ease per dimension. */
                    var dims=1;
                    try { dims = (p.value instanceof Array) ? p.value.length : 1; } catch(e){}
                    var eases=[];
                    for(var d=0;d<dims;d++){ eases.push(new KeyframeEase(0, 50)); }
                    p.setTemporalEaseAtKey(k, eases, eases);
                }
            }
        } finally { app.endUndoGroup(); }
        return JSON.stringify({ layer:l.name, property:p.name, keyframes:p.numKeys });
    """, COMP=comp, LAYER=layer, TIMES=times, VALUES=values, EASING=easing)
        .replace("$TARGET", target))


@mcp.tool()
def apply_preset(layer, path: str, comp: str = None):
    """
    Applies an animation preset (.ffx) to a layer.

    Presets are the only way to reproduce setups containing curve or histogram
    parameters, which cannot be set by script. The .ffx format is opaque binary,
    so presets can be applied but never generated.

    Args:
        layer: layer name or 1-based index.
        path: absolute path to the .ffx file.
    """
    return _run(_js("""
        var c=_comp($COMP), l=_layer(c, $LAYER);
        var f=new File($PATH);
        if(!f.exists) throw new Error("No preset at " + $PATH);
        /* applyPreset acts on the comp's SELECTION, not on the layer it is
           called on, so isolate the target and put the selection back after. */
        var saved=[];
        for(var i=1;i<=c.numLayers;i++){ if(c.layer(i).selected) saved.push(i); c.layer(i).selected=false; }
        app.beginUndoGroup("Adobe MCP: apply preset");
        try {
            l.selected=true;
            l.applyPreset(f);
        } finally {
            app.endUndoGroup();
            l.selected=false;
            for(var j=0;j<saved.length;j++){ c.layer(saved[j]).selected=true; }
        }
        var g=l.property("ADBE Effect Parade");
        return JSON.stringify({ layer:l.name, preset:f.name, effectsNow: g ? g.numProperties : 0 });
    """, COMP=comp, LAYER=layer, PATH=path))


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
