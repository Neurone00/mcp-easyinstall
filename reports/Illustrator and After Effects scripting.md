# Borrow MIT Illustrator tools, script AE effects

**Both of your questions are yes, with one hard wall in each app.** Illustrator can absolutely go beyond the 13 tools we wrote: there is a ready-made, MIT-licensed 67-tool taxonomy in `ie3jp/illustrator-mcp-server` that we can read, copy and adapt without legal risk, plus roughly 2,500 stars' worth of MIT script collections (creold, Ladygin, shspage) to lift individual algorithms from. After Effects effects and third-party plugins are not only scriptable, they are one of the cleanest corners of the whole ExtendScript surface — `layer.property("ADBE Effect Parade").addProperty(matchName)` applies any installed effect, Adobe's or Trapcode's, and keyframes, easing and expressions all have documented APIs. The wall in Illustrator is the Appearance panel and the Effect menu, which have no DOM API at all, taking Pathfinder, Offset Path and drop shadows with them; the wall in After Effects is the AI-ish features — Roto Brush, Content-Aware Fill, mask tracking — and any access to rendered pixels. Two popular repos we must *not* copy from are `Silly-V/Adobe-Illustrator` and `krVatsal/illustrator-mcp` (no licence at all, so all rights reserved), and one, `johnwun/js4ai`, is 4-clause BSD with an advertising clause that would follow us into our marketing copy. Finally, the strategic answer: **ExtendScript is not a bet we are making, it is the only road** — neither Illustrator nor After Effects has a public UXP panel API as of 2026, so investment here is unavoidable rather than merely defensible.

## What to build next, in priority order

Our Illustrator server currently exposes 18 tools, of which the 13 we wrote (`list_artboards`, `list_items`, `create_rectangle`, `create_ellipse`, `create_text`, `create_artboard`, `set_fill`, `move_item`, `resize_item`, `align_item`, `duplicate_item`, `delete_item`, `get_instructions`) cluster almost entirely in "create a shape and move it". The recurring operations across four independent script collections and two independently designed MCP servers tell a consistent story about what is actually missing, and the good news is that the missing tier is mostly easy DOM work.

| Build next | Why it recurs | ExtendScript difficulty |
|---|---|---|
| Layers (create, rename, reorder, lock, move items between) | `document.layers`, `item.move()` — every collection has a Layer category | Easy |
| Selection / find by criteria (type, name, colour, font, size) | creold ships 9 Select scripts; ie3jp has `find_objects` + `select_objects` | Easy |
| Artboard management (resize, rename, rearrange, fit to selection) | The single most-automated area across every source | Easy |
| Export beyond PNG (SVG, JPG, PDF with marks and bleed, per-artboard batch) | `exportFile` + option objects; ie3jp's `export_pdf` is the model | Easy–Medium |
| Colour, swatches, find-and-replace colour, gradients, design-token extraction | creold's largest category (15 scripts); Adobe's own beta MCP headlines bulk recolouring | Easy–Medium |
| Text and typography (bulk edit, find/replace, area vs point type, outline conversion) | Present in all four collections | Medium — font resolution by name is the usual failure |
| Groups, clipping masks, compound paths | creold Group\|Mask (7 scripts), Ladygin's clippers | Medium |
| Placed images and links (place, relink, detect broken links, effective PPI) | ie3jp's `get_images` reports resolution and colour-space mismatch | Medium |

([creold/illustrator-scripts](https://github.com/creold/illustrator-scripts), [alexander-ladygin/illustrator-scripts](https://github.com/alexander-ladygin/illustrator-scripts), [ie3jp/illustrator-mcp-server](https://github.com/ie3jp/illustrator-mcp-server))

One architectural correction is worth making early. Our tools address objects **by name** (`move_item(name, ...)`), which breaks the moment a document has two objects called "Rectangle 1". ie3jp solved the same problem with a **UUID-based object handle** model, and also with a coordinate-system switch: CMYK/print documents use `document` coordinates (origin bottom-left, Y up) while RGB/web documents use artboard-relative coordinates (origin top-left, Y down), with an explicit `set_workflow` override when auto-detection guesses wrong ([ie3jp README](https://github.com/ie3jp/illustrator-mcp-server)). Both patterns are the kind of thing you only discover after shipping, and both are free to adopt now.

For After Effects, where we currently have nothing but `execute_extend_script`, the first four tools write themselves: **list installed effects** (a cached dump of `app.effects`), **apply effect by match name with parameters**, **keyframe a property**, and **apply an .ffx preset**. Those four cover the overwhelming majority of what a designer would ask an agent to do to an AE comp, and every one of them is documented API rather than a workaround.

## The MIT pool is generous; three repos are legal traps

Licence compatibility matters here in a practical way, because Adobe MCP is MIT-licensed and distributed publicly on GitHub, which means anything we vendor travels with us into other people's projects. The research checked licences against the GitHub REST API's `license.spdx_id` field rather than reading README prose, which is the right method — README claims and actual LICENSE files diverge more often than you would hope.

| Project | Licence | Verdict |
|---|---|---|
| `ie3jp/illustrator-mcp-server` (127★, active Sept 2026) | **MIT** | Safe. Highest-value reuse target. |
| `creold/illustrator-scripts` (1,114★, active Aug 2026) | **MIT** | Safe and current. |
| `alexander-ladygin/illustrator-scripts` (1,505★, last push 2023) | **MIT** | Safe; largest collection. |
| `shspage/illustrator-scripts` (472★, last push 2018) | **MIT** | Safe but frozen — re-test anything borrowed. |
| `mikechambers/adb-mcp` (711★) | **MIT** | Already our engine. |
| `jinkeda/Illustrator_MCP` (7★, active) | **MIT** | Safe, small. |
| `johnwun/js4ai` (585★) | **4-clause BSD** | Avoid — advertising clause. |
| `Silly-V/Adobe-Illustrator` (472★, active) | **None** | Do not copy. All rights reserved. |
| `krVatsal/illustrator-mcp` (153★) | **None** | Do not copy. |
| `spencerhhubert/illustrator-mcp-server` (57★) | **None** | Do not copy. |
| Astute Graphics free scripts | Commercial EULA | Proprietary; per-seat activation, not open source. |

The js4ai case deserves a sentence of its own because it is easy to get wrong. The GitHub API reports `license: null`, but the real terms live at wundes.com and are a 4-clause BSD, which includes the clause: **"All advertising materials mentioning features or use of this software must display the following acknowledgement: This product includes software developed by wundes.com and its contributors"** ([copyright.txt](http://www.wundes.com/js4ai/copyright.txt)). That is an ongoing obligation on our marketing copy, not a one-line attribution in a NOTICE file, and it is GPL-incompatible besides. js4ai has genuinely interesting generative scripts (fractalize, fleurify, ArcTwister), but none of them is worth attaching a permanent advertising clause to a shipped product. Read it for ideas; do not vendor it.

The no-licence repos are the more dangerous category precisely because they look open. **Absence of a licence means default copyright — all rights reserved** — so cloning, reading and running them is fine, and copying code into Adobe MCP is not. `Silly-V` (472 stars, actively pushed in March 2026) and `krVatsal` (153 stars, the most popular unlicensed MCP server) both fall here. If a specific script from one of them turns out to be the thing we need, the cheap fix is an email asking the author to add an MIT LICENSE file.

There is a fourth licence trap that applies specifically to After Effects. The obvious way to build an "apply effect" tool is to bundle the match-name tables from the docsforadobe Scripting Guide — 200+ first-party effects, neatly categorised. **Do not.** The docsforadobe site footer states all content is copyright Adobe Systems Incorporated, the repo declares itself educational-only, and there is no open-source licence on the content ([docsforadobe/after-effects-scripting-guide](https://github.com/docsforadobe/after-effects-scripting-guide)). Nor is there a machine-readable JSON payload to grab anyway — the repo is MkDocs Markdown. The correct move is also the technically better one: generate the catalogue at runtime from `app.effects`, cache it per AE version, and you get a licence-clean dataset that is always current *and* includes whatever third-party plugins the user actually has installed.

```javascript
// Runtime effect catalogue — licence-clean and always accurate.
function dumpEffectCatalogue() {
    var rows = [];
    for (var i = 0; i < app.effects.length; i++) {
        var e = app.effects[i];
        rows.push([e.displayName, e.matchName, e.category, e.version].join("\t"));
    }
    return rows.join("\n");
}
```

Each `app.effects` entry carries `displayName` (localised), `matchName` ("the internal unique name for the effect… Use this value to apply the effect"), `category` and `version` ([Application object](https://ae-scripting.docsforadobe.dev/general/application/)).

## After Effects effects are a solved problem in forty lines

This is the part of the research that is directly implementable today. An effect is a `PropertyGroup` hanging off the layer's Effects group, whose match name is `ADBE Effect Parade`. `PropertyGroup.addProperty(name)` "creates and returns a PropertyBase object with the specified name", accepting either the localized display name or the match name ([PropertyGroup](https://ae-scripting.docsforadobe.dev/property/propertygroup/)). **Always use the match name** — match names are "stable from version to version regardless of the display name" and are language-independent ([ProVideo Coalition, David Torno](https://www.provideocoalition.com/effects-match-names/)), so a tool that accepts a friendly string from the model should resolve it through `app.effects` before calling `addProperty`.

```javascript
app.beginUndoGroup("MCP: apply effect");
try {
    var comp = app.project.activeItem;
    if (!(comp && comp instanceof CompItem)) { throw new Error("No active composition."); }
    var layer = comp.layer(1);

    var fx = layer.property("ADBE Effect Parade");
    if (fx === null) { throw new Error("This layer type has no Effects group."); }
    if (!fx.canAddProperty("ADBE Gaussian Blur 2")) { throw new Error("Effect not available."); }

    var blur = fx.addProperty("ADBE Gaussian Blur 2");
    blur.name = "Hero Blur";                                  // renames the instance only
    var blurIndex = blur.propertyIndex;                       // survives later addProperty calls
    blur.property("ADBE Gaussian Blur 2-0001").setValue(25);  // Blurriness
} finally {
    app.endUndoGroup();
}
```

Three documented hazards are baked into that snippet. First, `addProperty` "generates an exception" if it cannot create the property, so `canAddProperty()` is the documented pre-flight check. Second — and this one bites hard in an MCP tool that applies several effects in one call — **"when you add a new property to an indexed group, the indexed group gets recreated from scratch, invalidating all existing references to properties"**; the documented workaround is to store `property.propertyIndex` and re-fetch, never to cache the object ([PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)). Third, camera and light layers have no Effects group at all, because `ADBE Effect Parade` is an AVLayer property and CameraLayer/LightLayer do not inherit from AVLayer ([AV Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/avlayer/), [AVLayer object](https://ae-scripting.docsforadobe.dev/layer/avlayer/)).

Parameters are children of the effect group, reachable by 1-based index, by display name, or by parameter match name — which for Adobe effects follows a `<effect match name>-000N` convention. The researchers flagged that convention as **observed rather than formally documented**, and noted third-party vendors follow it inconsistently, so a production tool should enumerate `effect.property(i).matchName` rather than synthesise parameter names. `setValue()` "sets the static value of a property that has no keyframes" and **throws if keyframes exist**, in which case `setValueAtTime()` is required ([Property object](https://ae-scripting.docsforadobe.dev/property/property/)). Colours are arrays of four floats in the range 0.0–1.0, per `PropertyValueType.COLOR`, so any tool taking hex or 0–255 input must convert first.

```javascript
// Parameter discovery for an unknown (possibly third-party) effect.
function describeEffect(effect) {
    var out = [];
    for (var i = 1; i <= effect.numProperties; i++) {
        var p = effect.property(i);
        out.push(i + "\t" + p.matchName + "\t" + p.name + "\t" + p.propertyValueType);
    }
    return out.join("\n");
}

// Setting values, guarding the keyframed case and the unsettable types.
function setParam(effect, paramMatchName, value, comp) {
    var p = effect.property(paramMatchName);
    if (p === null) { return false; }
    if (p.propertyValueType === PropertyValueType.NO_VALUE ||
        p.propertyValueType === PropertyValueType.CUSTOM_VALUE) { return false; }
    if (p.numKeys > 0) { p.setValueAtTime(comp.time, value); }
    else               { p.setValue(value); }
    return true;
}
```

`CUSTOM_VALUE` is documented as covering things like "the Histogram property for the Levels effect" and `NO_VALUE` "stores no data" — these are the parameters a script simply cannot set, and skipping them is the only sane behaviour ([Property object](https://ae-scripting.docsforadobe.dev/property/property/)).

Animation is equally tractable. `setValuesAtTimes(times, newValues)` sets a whole run of keyframes from two equal-length arrays and should be the default path for a bulk "animate property" tool, with easing applied in a second pass because ease can only be set per key index. `setTemporalEaseAtKey(keyIndex, inEase, outEase)` takes `KeyframeEase` objects — one per dimension, so a OneD property gets one, Position gets two or three — and `new KeyframeEase(speed, influence)` requires both arguments, with **influence documented as [0.1..100.0]**, meaning zero is out of range and must be clamped ([KeyframeEase object](https://ae-scripting.docsforadobe.dev/other/keyframeease/)).

```javascript
var glow = layer.property("ADBE Effect Parade").addProperty("ADBE Glo2");
var thr  = glow.property(1);                      // Glow Threshold (OneD, %)

thr.setValuesAtTimes([0.0, 1.5, 3.0], [100, 40, 100]);

var easeIn  = new KeyframeEase(0, 75);            // speed 0 = flat; influence 75%
var easeOut = new KeyframeEase(0, 75);
for (var k = 1; k <= thr.numKeys; k++) {
    thr.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER,
                                     KeyframeInterpolationType.BEZIER);
    thr.setTemporalEaseAtKey(k, [easeIn], [easeOut]);
}

// Expressions, guarded:
var slider = layer.property("ADBE Effect Parade")
                  .addProperty("ADBE Slider Control")
                  .property("ADBE Slider Control-0001");
if (slider.canSetExpression) {
    slider.expression = 'var f = 2;\rvar amp = 30;\ramp * Math.sin(time * f * Math.PI * 2);';
    slider.expressionEnabled = true;
}
```

One caveat the researchers were careful about: the docs say a `KeyframeEase` speed's "units depend on the type of keyframe", so a generic easing tool cannot compute speed reliably across property types. Using `speed = 0` for a flat ease is the research team's recommendation, not a documented rule — safe in practice, but worth knowing it is our choice and not Adobe's.

**Third-party plugins work identically.** Trapcode Particular is `tc Particular`, Shine is `tc Shine`, Video Copilot uses a `VIDEOCOPILOT ` prefix, and all of them respond to the same `addProperty(matchName)` call ([ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)). Because `app.effects` reflects what the running AE has actually loaded, it doubles as an installed-plugin check, a match-name resolver and a version probe. Two honest limits, though. Plugins whose real UI is a custom panel — Element 3D's Scene Setup is the canonical case — still appear in `app.effects` and can still be added, but their internal scene state is not exposed as scriptable properties, so the usable parameter surface is far smaller than the plugin's UI suggests. And **what happens to an unlicensed third-party plugin under scripting is genuinely unverified**: one search summary claimed `addProperty()` would throw, but that was the search tool's summariser rather than a primary source, and the researchers explicitly declined to report it as fact. This needs empirical testing per vendor before we promise anything about trial plugins.

For effect setups that scripts cannot construct — gradients, curves, custom-value parameters — animation presets are the escape hatch, and `Layer.applyPreset(File)` has one serious trap: **"the animation preset is applied to the selected layer(s) of the comp, not to the layer whose applyPreset function is called"** ([Layer object](https://ae-scripting.docsforadobe.dev/layer/layer/)). Any tool wrapping it must snapshot `comp.selectedLayers`, isolate the target, apply, and restore. `.ffx` is an opaque binary format, so we can only apply presets that already exist; we cannot synthesise them.

## Where ExtendScript stops, in each app

Illustrator's hard wall is the **Appearance panel and the Effect menu**. Adobe's own UserVoice records the gap plainly: "The scripting API currently does not provide access to the capabilities of the Appearance Panel, such as applying multiple fills and strokes in arbitrary order. Via scripting we can only access `fillColor` and `strokeColor` with no control of order (stroke is always above fill)" ([Illustrator UserVoice](https://illustrator.uservoice.com/forums/908050-sdk-scripting-bugs-and-features/suggestions/34339813-edit-appearances-with-scripting)). That one gap takes drop shadows, blurs, warps, 3D and Offset Path with it, since all of them are Effects. The only documented workaround is `GraphicStyle.applyTo(artItem)` ([GraphicStyle](https://ai-scripting.docsforadobe.dev/jsobjref/GraphicStyle/)) — which means a live effect can be applied by script *only if a human pre-authored it into a Graphic Style*. Pathfinder is likewise absent: community consensus is that there is no DOM counterpart, and the workarounds are `app.executeMenuCommand("Live Pathfinder Add")` and siblings followed by `expandStyle` ([Adobe forum](https://community.adobe.com/t5/illustrator-discussions/shape-mode-scripting-continued-unite-equivalent-script/td-p/11367813)). **Image Trace is the one genuine exception** — a real API via `PlacedItem.trace()`, `TracingObject.tracingOptions` and `expandTracing()`, with the documented caveat that result properties read 0 until you call `Application.redraw()` ([TracingObject](https://ai-scripting.docsforadobe.dev/jsobjref/TracingObject/)).

The escape hatch is `app.doScript(actionName, actionSetName)`, available since CS6, and the answer to "does it need a pre-recorded action installed?" is **yes at play time, no at authoring time**: a script can write a `.aia` file and call `app.loadAction()` to install one at runtime, then `app.unloadAction()` to clean up ([Adobe Community](https://community.adobe.com/t5/illustrator/script-to-load-a-set-of-actions/m-p/9391171)). So Adobe MCP could ship its own action payloads and offer Pathfinder without asking users to record anything. Three warnings temper that. There is **no Illustrator equivalent of Photoshop's `executeAction`/`batchPlay`** — no ActionManager at all — so `executeMenuCommand` (which cannot pass parameters) and `doScript` (which replays only the parameters frozen into the `.aia`) are the substitutes. The `.aia` format is community-reverse-engineered with no Adobe specification, so it is fragile across versions. And there is a real deadlock: Actions and scripts run on different threads, so **an Action that runs a script that runs an Action causes a standstill** ([Adobe Community](https://community.adobe.com/t5/illustrator-discussions/weird-app-doscript-behavior/m-p/14099355)). The safe direction is script → action, never the reverse. Separately, the `executeMenuCommand` string list is unofficial: a community extraction from the 2017 SDK holds ~506 commands, **about 90 of which no longer work** in newer versions ([Adobe Community](https://community.adobe.com/t5/illustrator-discussions/executemenucommand-command-list/td-p/13131490)), and whether those strings are locale-independent is disputed and unresolved.

The researchers were explicit that several Illustrator features — **Recolor Artwork, Blend objects, Live Paint, Shape Builder, Puppet Warp, Offset Path and Width Tool profiles** — were classified by inference from the DOM object index and the general Appearance gap, not confirmed individually against the scripting reference. Shape Builder and Puppet Warp are the likeliest true "impossible" cases, being direct-manipulation tools with no menu equivalent. Before any of these appears in our public documentation, someone should grep the Illustrator Scripting Reference object index directly.

In After Effects, the boundary runs along a different seam: **estimation and AI features sit outside scripting entirely**. Roto Brush, Content-Aware Fill and mask tracking have no scripting API — a script can add the Roto Brush *effect*, but the segmentation stroke is direct manipulation with no scripted entry point. The researchers noted the evidence here is negative (no API in the reference, no community script doing it) rather than a positive Adobe statement, so the honest phrasing is "no scripting API exists", not "Adobe says it is impossible". Reading rendered pixel data is impossible by design: scripts "can only access the core functionality of After Effects", whereas pixel manipulation is what C++ plugins are for ([AE Screens](https://www.aescreens.com/blog/after-effects-plugins-vs-scripts-vs-extensions)), with pixel access living in the AEGP suites ([AE C++ SDK Guide](https://ae-plugins.docsforadobe.dev/aegps/aegps/)). The graph editor UI is not driveable either, though everything behind it — keyframe values, times, interpolation types, temporal and spatial ease — is fully accessible through the `Property` object. **Motion Graphics templates are the pleasant surprise**: Essential Graphics and `.mogrt` export are a real documented API ([docsforadobe](https://deepwiki.com/docsforadobe/after-effects-scripting-guide/10.2-essential-graphics-panel-integration)), arguably the strongest automation surface in modern AE.

Two operational constraints shape how an MCP server should behave. AE gates file and network access behind a preference — **"the default is for scripts to not be allowed to write files or send or receive communication over a network"** ([AE Scripting Guide, Overview](https://ae-scripting.docsforadobe.dev/introduction/overview/)) — so any export tool needs a clear first-run instruction. And rendering blocks everything: "while rendering is paused, you cannot change settings or use After Effects in any other way" ([Adobe Help](https://helpx.adobe.com/after-effects/using/basics-rendering-exporting.html)). Treat "render in progress" as a hard busy state; the non-blocking options are `queueInAME(true)`, the `aerender` CLI, or the undocumented `renderAsync()` — which is reported only in a forum post and whose stability across versions is unknown. There is **no documented execution timeout in either app**, so we should never promise that a runaway script fails safely; it requires force-quitting the host. One product-quality asymmetry is worth designing around: AE gives scripts `app.beginUndoGroup()`/`endUndoGroup()` to collapse a whole operation into one undo step, while Illustrator appears to have no undo-grouping API, meaning a 200-object script leaves a long undo trail. The researchers flagged the Illustrator half of that claim as inference from general practice rather than a cited fact — worth verifying, because it argues for chunking Illustrator work into many small script executions rather than one long one, which also improves cancellability.

## ExtendScript is the only road, so build the binding layer to be replaceable

The strategic question — how much to invest in ExtendScript when Adobe has been promising UXP for years — has a clearer answer than the ambient anxiety suggests. **As of April 2026, neither Illustrator nor After Effects has a public UXP plugin or panel API.** Photoshop, InDesign and Premiere Pro do; Premiere's shipped in v25.6 in December 2025. After Effects appears in the UXP version matrix from v22.0, but that covers scripting APIs only, not the panel framework ([pushREC AE SDK KB, UXP-STATUS-NOTE](https://github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/UXP-STATUS-NOTE.md)). For Illustrator, UXP reportedly remains internal to Adobe with no published API or timeline, making CEP the only public option ([Mapsoft](https://mapsoft.com/posts/illustrator-uxp-status.html)). This matters because it means our CEP-and-ExtendScript architecture is not technical debt we chose — it is the only thing that exists for these two apps.

**Carry this caveat forward rather than treating it as settled.** The cleanest 2026 status statements come from mapsoft.com, which reads as SEO/aggregator content rather than a primary Adobe source. The two claims the researchers most wanted re-verified against `developer.adobe.com` are (a) that Illustrator UXP is still internal-only in 2026, and (b) that Adobe has "confirmed CEP will eventually be retired" on a several-year horizon. The pushREC knowledge base independently corroborates the After Effects side and the Premiere v25.6 date, which raises confidence in the overall shape without validating those two specific sentences. No source anywhere gives an announced end-of-life date for ExtendScript in any app. Also relevant: a CEP panel adds **no capability** over a plain `.jsx` script — it only adds an HTML UI, a Node.js side channel and persistence. What it does add operationally is exactly what we use it for: a Node process outside ExtendScript that can do networking without blocking the host.

The mitigation is cheap and worth doing now. Keep the *logic* (what a tool should accomplish) separate from the *host bindings* (how to express it in ExtendScript), so that a future UXP port replaces only the binding layer. UXP is a genuinely different runtime — no ScriptUI, different `File`/`Folder` semantics, a modern JS engine, async APIs — so there will be no shared code across the boundary, only shared structure. Meanwhile, write the ExtendScript itself as ES3: no `let`/`const`, no arrow functions, no `JSON.parse`, no trailing commas.

## Conclusion

The most useful reframing from this research is that **Illustrator and After Effects fail in opposite directions**, and our product should present them that way. Illustrator's DOM is broad and shallow: it models one fill and one stroke per object and stops, so everything visually interesting — effects, Pathfinder, appearance stacks — falls outside and has to be faked through graphic styles, menu commands or injected `.aia` actions, each of which is fragile in its own way. After Effects' DOM is narrow and deep: it does not touch pixels or AI features at all, but within project structure it is thorough enough that applying a third-party plugin, setting its parameters, keyframing them with Bezier ease and attaching an expression is roughly forty lines of well-documented code. That asymmetry suggests the effort split should be the inverse of what the current tool counts imply. Illustrator needs many small, boring, DOM-backed tools, borrowed liberally from ie3jp's MIT taxonomy. After Effects needs four or five well-designed ones built on `app.effects` and `ADBE Effect Parade` — and those four will feel more magical than the twenty Illustrator ones.

The licence picture also carries a mild strategic lesson. The most valuable reuse target in this space, ie3jp, is MIT, actively maintained, npm-published and broad — and the two most popular alternatives have no licence at all, which is a recurring failure mode in the Adobe scripting community rather than a coincidence. That community has always distributed code as loose `.jsx` files passed between designers, where licensing never came up. Since we ship publicly under MIT, we inherit an obligation the people we are borrowing from never thought about. Build the effect catalogue at runtime, vendor only from the MIT pool, read the rest for ideas, and the obligation costs nothing.
