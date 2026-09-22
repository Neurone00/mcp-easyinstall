# After Effects: applying, configuring and animating effects via ExtendScript

Scope note: all API signatures below are taken from the community-maintained *After Effects Scripting Guide* (docsforadobe), which is the reformatted, continuously-updated version of Adobe's official Scripting Guide. Where a version requirement is documented it is stated; where it is not, that is flagged in Gaps. Code blocks are written by me from the documented signatures — they are syntactically valid ExtendScript (ES3-era JavaScript: `var`, no `let`/arrow functions/`JSON`), but only the snippets explicitly quoted from a source are verbatim-documented.

---

## Q1. Adding an effect to a layer: `layer.property("ADBE Effect Parade").addProperty(matchName)`

### Takeaway
An effect is added by calling `addProperty()` on the layer's Effects property group, whose match name is `ADBE Effect Parade`; the argument may be either the effect's localized display name or its match name, and the match name is the version- and language-stable internal identifier, which is why an MCP tool should always use it.

### Cited Findings
- `PropertyGroup.addProperty(name)` — "Creates and returns a PropertyBase object with the specified name, and adds it to this group." The `name` parameter is documented as the "Display name or matchName of property to add" — [After Effects Scripting Guide, PropertyGroup](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- "If the method cannot create a property with the specified name, it generates an exception. To check that you can add a particular property to this group, call `canAddProperty` before calling this method." — [PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- `PropertyGroup.canAddProperty(name)` returns Boolean: "Returns `true` if a property with the given name can be added to this property group." — [PropertyGroup.canAddProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- Documented warning: "When you add a new property to an indexed group, the indexed group gets recreated from scratch, invalidating all existing references to properties." The documented workaround is to store `property.propertyIndex` of the added property — [PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- Also documented: you can only add properties to an *indexed* group (`PropertyType.INDEXED_GROUP`); the one exception is a text animator property, which can be added to a named group — [PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/) (as summarised in search results from the same page)
- The Effects group's match name on an AV layer is `ADBE Effect Parade` (display name "Effects"). Sibling top-level AVLayer match names are `ADBE Marker`, `ADBE Time Remapping`, `ADBE MTrackers`, `ADBE Mask Parade`, `ADBE Layer Overrides` (Essential Properties) and `ADBE Transform Group` — [AV Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/avlayer/)
- `PropertyGroup.property(name)` accepts "Match name, expression 'parenthesis style,' or 'intercap style' syntax"; `PropertyGroup.property(index)` takes an Integer in range `[1..numProperties]`. Both return a PropertyBase object or `null` — [PropertyGroup.property()](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- `matchName` is "After Effects' internal name for any given layer or property type… Match names are stable from version to version regardless of the display name or any changes to the application." — [ProVideo Coalition, After Effects Plugin Match Names (David Torno)](https://www.provideocoalition.com/effects-match-names/)
- Match names are also language-independent, which matters for scripts run outside your own locale — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/); the docsforadobe effects page likewise gives display names "in English" alongside the match name — [First-Party Effect Match Names](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/)
- `app.effects[n].matchName` is documented as "A string representing the internal unique name for the effect… Use this value to apply the effect" — [Application object](https://ae-scripting.docsforadobe.dev/general/application/)

### Working pattern (adapt directly)

```javascript
// Apply an effect by match name, safely, inside one undo group.
function addEffect(layer, matchName, instanceName) {
    var fx = layer.property("ADBE Effect Parade");   // Effects group
    if (fx === null) {
        throw new Error("Layer '" + layer.name + "' has no Effects group (camera/light layer?).");
    }
    if (!fx.canAddProperty(matchName)) {
        throw new Error("Effect not available: " + matchName);
    }
    var effect = fx.addProperty(matchName);
    if (instanceName) { effect.name = instanceName; }   // rename the instance, not the effect
    return effect;
}

app.beginUndoGroup("Add Gaussian Blur");
try {
    var comp  = app.project.activeItem;                       // may be null or not a CompItem
    if (!(comp && comp instanceof CompItem)) { throw new Error("No active composition."); }
    var layer = comp.layer(1);
    var blur  = addEffect(layer, "ADBE Gaussian Blur 2", "Hero Blur");
    blur.property("ADBE Gaussian Blur 2-0001").setValue(25);  // Blurriness
} finally {
    app.endUndoGroup();
}
```

Re-finding an effect later (indices shift after every `addProperty`, per the documented warning):

```javascript
// Safer than caching the object across further addProperty() calls:
var idx = blur.propertyIndex;                       // store this
var again = layer.property("ADBE Effect Parade").property(idx);

// Or look it up by the instance NAME you assigned:
var byName = layer.property("ADBE Effect Parade").property("Hero Blur");
```

### Inferences
- `addProperty()` accepting the display name is a convenience that breaks on non-English installs and when Adobe renames an effect; an MCP tool should accept a human string but resolve it to a match name via `app.effects` before calling `addProperty` (see Q5).
- `effect.name = "..."` renames only the instance in the Effect Controls panel; the match name is unchanged, so subsequent lookups can use either the new name or the stored index. (Consistent with the documented `PropertyBase.name` / `matchName` split, but I did not find an explicit statement of this for effect instances — treat as high-confidence but unverified.)

### Gaps
- I did not find a documented statement of what the *minimum* AE version is for `property("ADBE Effect Parade").addProperty()`; it predates the versions covered by current docs (CS-era), so this is effectively "any modern AE", but unverified.

---

## Q2. Where to find a complete list of built-in effect match names (and machine-readable forms)

### Takeaway
The canonical, continuously-updated public list of first-party effect match names is the docsforadobe *After Effects Scripting Guide* match-names section, which is Markdown-only (no bundled JSON); the largest third-party list is David Torno's community PDF/Google Sheet. Neither carries a permissive licence — both are effectively "Adobe copyright, educational use" — so the safe strategy for an MCP tool is to generate its own list at runtime from `app.effects`.

### Cited Findings
- Canonical first-party list: [First-Party Effect Match Names — After Effects Scripting Guide](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/). It is organised by the Effect menu categories: 3D Channel, Audio, Blur & Sharpen, Channel, Color Correction, Distort, Expression Controls, Generate, Keying, Matte, Noise & Grain, Perspective, Simulation, Stylize, Text, Time, Transition, Utility, plus obsolete categories. Each entry lists the English display name, match name, bits-per-channel support, and the AE version that added GPU acceleration where applicable — [First-Party Effect Match Names](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/)
- Sample entries from that page: `ADBE Gaussian Blur 2` (Gaussian Blur), `ADBE Glo2` (Glow), `ADBE Tint` (Tint), `ADBE HUE SATURATION` (Hue/Saturation) — [First-Party Effect Match Names](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/)
- Coverage reported in search results for that page: 200+ effects across the listed categories — [search summary of the same page](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/)
- Layer/property match names live in sibling pages, e.g. [AV Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/avlayer/), [Text Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/textlayer/), [Camera Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/cameralayer/)
- Licence: the docsforadobe site footer states "All content is copyright Adobe Systems Incorporated"; the GitHub repo [docsforadobe/after-effects-scripting-guide](https://github.com/docsforadobe/after-effects-scripting-guide) likewise declares the content Adobe-copyright and the project "exists for educational purposes only", with **no open-source licence** for the content — [repo page](https://github.com/docsforadobe/after-effects-scripting-guide)
- Format: the repo is an MkDocs (Material for MkDocs) site; the docs are Markdown under `/docs` with `mkdocs.yml` — I found **no JSON/YAML/CSV machine-readable match-name data** in it — [repo page](https://github.com/docsforadobe/after-effects-scripting-guide)
- docsforadobe is "a united 3rd-party Adobe developers community… not legally affiliated with Adobe", pages "exist for educational purposes only" — [docsforadobe GitHub org](https://github.com/docsforadobe)
- Third-party list: David Torno's "After Effects Plugin Match Names" is a PDF backed by a Google Sheet, covering native plugins across AE CC–CC 2015 plus third-party plugins grouped by developer (Trapcode, Video Copilot, Boris Continuum Complete, Red Giant, and a "Misc" section including Mettle and Rowbyte) — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- That resource also ships an open-source "After Effects Plugin Match Name Contribution Script" that writes a tab-delimited text file of plugin name, match name, category, version, plus AE version and OS; example row: `3D Channel Extract	ADBE AUX CHANNEL EXTRACT	1.5x1` — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- Other community mirrors/aggregators exist: [AE Portal — AE Plug-in Matchnames](http://aeportal.blogspot.com/2011/02/ae-plug-in-matchnames.html) and [Fendra FX — After Effects Plugin Match Names List](https://fendrafx.com/utility/after-effects-plugin-match-names-list/) (both older aggregations of the same lineage).
- Adobe's own older authoritative PDF (CS6 Scripting Guide) is still mirrored publicly: [After-Effects-CS6-Scripting-Guide.pdf](https://fendrafx.com/wp-content/uploads/After-Effects-CS6-Scripting-Guide.pdf). Adobe's current end-user entry point is [helpx.adobe.com — Scripts in After Effects](https://helpx.adobe.com/after-effects/using/scripts.html).

### Recommended approach for bundling a list

```javascript
// Generate your own machine-readable catalogue at runtime — no licence question,
// and it includes every third-party plugin actually installed on this machine.
function dumpEffectCatalogue(outFile) {
    var rows = [];
    for (var i = 0; i < app.effects.length; i++) {
        var e = app.effects[i];
        rows.push([e.displayName, e.matchName, e.category, e.version].join("\t"));
    }
    var f = new File(outFile);
    f.encoding = "UTF-8";
    f.open("w");
    f.write("displayName\tmatchName\tcategory\tversion\n" + rows.join("\n"));
    f.close();
    return rows.length;
}
// dumpEffectCatalogue("~/Desktop/ae_effects.tsv");
```

### Inferences
- Because the docsforadobe content is Adobe-copyright with no permissive licence, shipping a scraped copy of its match-name tables inside a product is legally uncomfortable; generating the catalogue from `app.effects` on first run (and caching it per AE version) gives an equivalent, always-accurate, licence-clean dataset.
- A runtime-generated catalogue is also the only way to stay correct across AE releases (Adobe adds effects) and across each user's plugin set.

### Gaps
- I did not locate a GitHub repository literally named `ae-matchnames` with a JSON payload. Searches for it returned only unrelated "name matching" repos plus the docsforadobe pages. If such a repo exists it did not surface; the machine-readable list the user hoped for appears not to exist as a maintained, licensed artifact.
- The licence of Torno's contribution script is described only as "simple open source" with no specific licence stated — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/).
- Whether Torno's PDF/Sheet is still being updated in 2026 (it is documented as covering up to CC 2015) is unverified.

---

## Q3. Setting an effect's parameter values

### Takeaway
Effect parameters are children of the effect PropertyGroup and can be reached by 1-based index, by display name, or by parameter match name (typically `<effect match name>-000N`); use `setValue()` for a static value and `setValueAtTime()` once the property has keyframes — `setValue()` throws if keyframes exist.

### Cited Findings
- `Property.setValue(newValue)`: "Sets the static value of a property that has no keyframes." It throws an error if keyframes exist; use `setValueAtTime()` or `setValueAtKey()` instead — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.setValueAtTime(time, newValue)`: "Sets the value of a keyframe at the specified time. Creates a new keyframe for the named property, if one does not currently exist." Time is in seconds measured from the start of the composition — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- Documented sample: `var myProperty = myLayer.opacity; myProperty.setValue(50); var myOpacity = myProperty.value;` — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.numKeys` is read-only: "The number of keyframes in the named property. If the value is 0, the property is not being keyframed." — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- Child access: `PropertyGroup.property(index)` with index in `[1..numProperties]`, or `PropertyGroup.property(name)` with a match name / parenthesis-style / intercap-style name — [PropertyGroup](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- Value shapes are governed by `PropertyValueType`: `OneD` (single float), `TwoD` / `TwoD_SPATIAL` (array of 2), `ThreeD` / `ThreeD_SPATIAL` (array of 3), `COLOR` (array of four floats in range 0.0–1.0), plus `NO_VALUE`, `CUSTOM_VALUE`, `MARKER`, `LAYER_INDEX`, `MASK_INDEX`, `SHAPE`, `TEXT_DOCUMENT` — [PropertyValueType enum, Property object docs](https://ae-scripting.docsforadobe.dev/property/property/)
- `CUSTOM_VALUE` is explicitly described as a custom property value "e.g. Histogram for Levels effect" — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- Community guidance: "using match names for effects and their parameters is suggested in most cases… use the `property()` method of the parent PropertyGroup passing it the match name string to receive a reference to the effect or parameter you want" — [aenhancers forum, scripting effects properties](https://aenhancers.com/viewtopic.php?t=223)

### Code

```javascript
var fx = layer.property("ADBE Effect Parade");

// --- by index (1-based) --------------------------------------------------
var tint = fx.addProperty("ADBE Tint");
tint.property(1).setValue([0, 0, 0, 1]);        // Map Black To (COLOR: RGBA 0..1)
tint.property(2).setValue([1, 1, 1, 1]);        // Map White To
tint.property(3).setValue(100);                 // Amount to Blend (OneD, percent)

// --- by parameter match name (stable, preferred) -------------------------
var blur = fx.addProperty("ADBE Gaussian Blur 2");
blur.property("ADBE Gaussian Blur 2-0001").setValue(40);   // Blurriness
blur.property("ADBE Gaussian Blur 2-0002").setValue(1);    // Blur Dimensions (popup: 1=Horizontal and Vertical)

// --- by display name (locale-dependent; avoid in shipped code) -----------
blur.property("Blurriness").setValue(40);

// --- discover parameters of an unknown effect ----------------------------
function describeEffect(effect) {
    var out = [];
    for (var i = 1; i <= effect.numProperties; i++) {
        var p = effect.property(i);
        out.push(i + "\t" + p.matchName + "\t" + p.name + "\t" + p.propertyValueType);
    }
    return out.join("\n");
}

// --- setValue vs setValueAtTime ------------------------------------------
var opacity = layer.property("ADBE Transform Group").property("ADBE Opacity");
if (opacity.numKeys === 0) {
    opacity.setValue(50);                 // static
} else {
    opacity.setValueAtTime(comp.time, 50); // would throw with setValue()
}
```

Slider/Checkbox/Angle/Point/Color expression controls (useful for rigging):

```javascript
var slider = fx.addProperty("ADBE Slider Control");
slider.property("ADBE Slider Control-0001").setValue(1.0);

var pointCtl = fx.addProperty("ADBE Point Control");
pointCtl.property(1).setValue([960, 540]);        // TwoD

var colorCtl = fx.addProperty("ADBE Color Control");
colorCtl.property(1).setValue([1, 0.2, 0.1, 1]);  // COLOR, 0..1 floats
```

Dropdown Menu Control (AE 17.0.1+), the only effect whose *menu items* can be authored by script:

```javascript
// Documented example, verbatim from the Scripting Guide:
var dropdownItems = ["First Item", "Second Item", "(-", "Another Item", "Last Item"];
var dropdownEffect = layer.property("ADBE Effect Parade").addProperty("ADBE Dropdown Control");
dropdownEffect.property(1).setPropertyParameters(dropdownItems);
```

### Inferences
- The `<effectMatchName>-000N` parameter match-name convention holds for Adobe effects (observable in the code above and in the community lists); third-party vendors follow it inconsistently, so an MCP tool should enumerate `effect.property(i).matchName` rather than synthesising parameter match names. (Convention observed rather than formally documented — treat as unverified.)
- Colour values are 0.0–1.0 floats with 4 components, per `PropertyValueType.COLOR` — an MCP tool taking hex or 0–255 input must convert before `setValue`.
- Checkbox parameters take `0`/`1` (OneD); popup/menu parameters take the 1-based item number as a OneD value. (Standard practice; not explicitly stated in the pages I read — unverified.)

### Gaps
- No source found that enumerates which built-in parameters are read-only versus writable; the docs only state that setting values on incompatible property types raises exceptions.

---

## Q4. Animating a property: keyframes, easing, expressions

### Takeaway
`setValueAtTime()`/`setValuesAtTimes()` create keyframes; easing is applied after the fact with `KeyframeEase` objects passed to `setTemporalEaseAtKey()` (one ease object per dimension); interpolation type is set with `setInterpolationTypeAtKey()`; expressions are written to `property.expression` when `canSetExpression` is `true`.

### Cited Findings
- `Property.setValuesAtTimes(times, newValues)`: "Sets values for a set of keyframes at specified times." Both arguments must be arrays of equal length — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.setTemporalEaseAtKey(keyIndex, inTemporalEase[, outTemporalEase])`: sets incoming/outgoing temporal ease using `KeyframeEase` objects; the array length depends on the property value type (1, 2 or 3 objects) — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `new KeyframeEase(speed, influence)` — both parameters required. `speed` is a float whose "units depend on the type of keyframe, and are displayed in the Keyframe Velocity dialog box"; `influence` is a float in range **[0.1..100.0]** — [KeyframeEase object](https://ae-scripting.docsforadobe.dev/other/keyframeease/)
- Documented KeyframeEase samples (verbatim): `var easeIn = new KeyframeEase(0.5, 50); var easeOut = new KeyframeEase(0.75, 85); myPositionProperty.setTemporalEaseAtKey(2, [easeIn], [easeOut]);` and for Scale, `[easeIn, easeIn, easeIn]` / `[easeOut, easeOut, easeOut]` — [KeyframeEase object](https://ae-scripting.docsforadobe.dev/other/keyframeease/)
- `Property.setInterpolationTypeAtKey(keyIndex, inType[, outType])` accepts `KeyframeInterpolationType.LINEAR`, `.BEZIER`, `.HOLD`; if `outType` is omitted it defaults to `inType` — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.setSpatialTangentsAtKey(keyIndex, inTangent[, outTangent])` requires `TwoD_SPATIAL` or `ThreeD_SPATIAL` property types and throws an exception otherwise — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.addKey(time)` "Adds a new keyframe or marker to the named property at the specified time and returns the index of the new keyframe" (Integer) — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.nearestKeyIndex(time)` "Returns the index of the keyframe nearest to the specified time." — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.expression` is a String, "Writeable only when `canSetExpression` for the named property is `true`"; setting the empty string disables the expression without error — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.expressionEnabled` (Boolean, read/write): "When `true`, the named property uses its associated expression to generate a value." It can only be set `true` when `canSetExpression` is `true` and the expression string is valid — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.canSetExpression` (Boolean, read-only): "When `true`, the named property is of a type whose expression can be set by a script." — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- Documented keyframe sample (verbatim): `myProperty.setValueAtTime(0, 0); myProperty.setValueAtTime(5, 90); myProperty.setValueAtTime(10, 0);` on a rotation property — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- `Property.setSelectedAtKey(keyIndex, onOff)` selects/deselects a keyframe — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)

### Code

```javascript
// --- 1. Keyframe an effect parameter -------------------------------------
var glow  = layer.property("ADBE Effect Parade").addProperty("ADBE Glo2");
var thr   = glow.property(1);                       // Glow Threshold (OneD, %)

thr.setValueAtTime(0.0, 100);
thr.setValueAtTime(1.5,  40);
thr.setValueAtTime(3.0, 100);

// Bulk version (arrays must be the same length):
thr.setValuesAtTimes([0.0, 1.5, 3.0], [100, 40, 100]);

// --- 2. Ease the keyframes ------------------------------------------------
// OneD property => ONE KeyframeEase per side. TwoD => 2, ThreeD => 3.
var easeIn  = new KeyframeEase(0, 75);              // speed 0 = flat, influence 75%
var easeOut = new KeyframeEase(0, 75);

for (var k = 1; k <= thr.numKeys; k++) {
    thr.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER,
                                     KeyframeInterpolationType.BEZIER);
    thr.setTemporalEaseAtKey(k, [easeIn], [easeOut]);
}

// Dimension-aware helper for any value type:
function easeAllKeys(prop, influence) {
    var dims = 1;
    var t = prop.propertyValueType;
    if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) { dims = 2; }
    if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) { dims = 3; }
    var eIn = [], eOut = [];
    for (var d = 0; d < dims; d++) {
        eIn.push(new KeyframeEase(0, influence));
        eOut.push(new KeyframeEase(0, influence));
    }
    for (var k = 1; k <= prop.numKeys; k++) {
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER,
                                          KeyframeInterpolationType.BEZIER);
        prop.setTemporalEaseAtKey(k, eIn, eOut);
    }
}
// NOTE: influence must be within [0.1 .. 100.0]; 0 is invalid.

// --- 3. Hold keyframes ----------------------------------------------------
thr.setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD,
                                 KeyframeInterpolationType.HOLD);

// --- 4. Spatial tangents (Position only) ---------------------------------
var pos = layer.property("ADBE Transform Group").property("ADBE Position");
pos.setValueAtTime(0, [0, 540]);
pos.setValueAtTime(2, [1920, 540]);
pos.setSpatialTangentsAtKey(1, [0, 0], [200, -300]);   // throws on non-spatial props

// --- 5. Expressions -------------------------------------------------------
var slider = layer.property("ADBE Effect Parade")
                  .addProperty("ADBE Slider Control")
                  .property("ADBE Slider Control-0001");

if (slider.canSetExpression) {
    // Use \r or \n for newlines; escape quotes carefully in generated code.
    slider.expression = 'var f = 2;\rvar amp = 30;\ramp * Math.sin(time * f * Math.PI * 2);';
    slider.expressionEnabled = true;
}

// Remove an expression:
slider.expression = "";     // documented: disables without error
```

### Inferences
- `setValuesAtTimes` is materially faster than looping `setValueAtTime` for long keyframe runs and should be the default path in an MCP "animate property" tool; the per-key easing pass then runs separately because ease can only be set per key index.
- An MCP tool exposing "ease in/out" should map friendly presets to `KeyframeEase(speed, influence)` pairs (e.g. "smooth" ≈ speed 0, influence 33–75) and must clamp influence into `[0.1, 100]`, since 0 is outside the documented range.
- Because expressions are ExtendScript strings containing JavaScript, quoting/escaping is the main practical hazard — prefer single-quoted ExtendScript literals around double-quoted expression code, or build with `String.fromCharCode(13)` for newlines.

### Gaps
- The docs do not state the exact speed units per property type ("units depend on the type of keyframe"), so a generic easing tool cannot compute speed values reliably — using `speed = 0` for a flat ease is the safe default, but that is my recommendation, not a documented one.

---

## Q5. Third-party plugin effects and runtime discovery

### Takeaway
Third-party effects are added exactly like first-party ones — by match name through `addProperty()` — and `app.effects` enumerates every effect currently registered in the running After Effects, which is the reliable way to discover a plugin's match name (and to verify it is installed before trying to apply it).

### Cited Findings
- `app.effects` is a read-only array of effect descriptions; each element has `displayName` ("the localized display name of the effect as seen in the Effect menu"), `matchName` ("the internal unique name for the effect… Use this value to apply the effect"), `category` ("the localized category label as seen in the Effect menu") and `version` ("Effect's internal version string"). Documented example: `var effectName = app.effects[12].displayName;` — [Application object](https://ae-scripting.docsforadobe.dev/general/application/)
- Third-party match names follow vendor-specific prefixes rather than `ADBE`, e.g. Trapcode `tc Shine` and `tc Particular`, Video Copilot `VIDEOCOPILOT 3DArray` — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- Retrieving matchName gives names that are "more descriptive and consistent between languages" than display names — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- Torno's community list is explicitly organised by third-party developer, covering Trapcode, Video Copilot, Boris Continuum Complete, Red Giant, Mettle and Rowbyte — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- The contribution script that generated those lists works by dumping installed plugin name, match name, category and version — i.e. exactly what `app.effects` exposes — [ProVideo Coalition](https://www.provideocoalition.com/effects-match-names/)
- `addProperty()` accepts "any match name for a property that can be added through the user interface"; `canAddProperty()` is the documented pre-flight check — [PropertyGroup](https://ae-scripting.docsforadobe.dev/property/propertygroup/)

### Code

```javascript
// Resolve a fuzzy user string ("particular", "Shine") to a real match name.
function findEffects(query) {
    var q = query.toLowerCase(), hits = [];
    for (var i = 0; i < app.effects.length; i++) {
        var e = app.effects[i];
        if (e.displayName.toLowerCase().indexOf(q) !== -1 ||
            e.matchName.toLowerCase().indexOf(q) !== -1) {
            hits.push({ displayName: e.displayName,
                        matchName:   e.matchName,
                        category:    e.category,
                        version:     e.version });
        }
    }
    return hits;
}

function effectIsInstalled(matchName) {
    for (var i = 0; i < app.effects.length; i++) {
        if (app.effects[i].matchName === matchName) { return true; }
    }
    return false;
}

// Applying a third-party effect is identical to a first-party one:
if (effectIsInstalled("tc Particular")) {
    var p = layer.property("ADBE Effect Parade").addProperty("tc Particular");
}

// List only third-party effects (everything not prefixed ADBE):
function thirdPartyEffects() {
    var out = [];
    for (var i = 0; i < app.effects.length; i++) {
        if (app.effects[i].matchName.indexOf("ADBE ") !== 0) { out.push(app.effects[i].matchName); }
    }
    return out;
}
```

### Inferences
- `app.effects` reflects what the running AE has actually loaded, so it is simultaneously an installed-plugin check, a match-name resolver and a version probe — an MCP server should call it once per AE session and cache the result.
- Because `category` is localized, category filtering should not be used for logic; match-name prefix (`ADBE `, `tc `, `VIDEOCOPILOT `, `BCC `, etc.) is the more robust vendor signal, though prefixes are vendor conventions rather than a guaranteed scheme.
- Effects that expose most of their UI through a custom panel (Element 3D's Scene Setup being the canonical example) will still appear in `app.effects` and can still be added, but their internal scene state is not exposed as scriptable properties — an MCP tool should expect a much smaller usable parameter surface for such plugins than the plugin's UI suggests.

### Gaps
- I found **no** vendor documentation from Video Copilot, Maxon/Red Giant or Boris FX describing a scripting API, match-name list, or scripting-specific licensing behaviour. Searches surfaced only Adobe/community material. Whether e.g. Element 3D's Scene Setup data is script-accessible is unverified (my expectation is no).
- **Licensing/activation under scripting is unverified.** One search summary asserted that an unlicensed third-party effect would make `addProperty()` throw, but that claim was generated by the search tool's summariser, not quoted from a primary source, so I am not reporting it as fact. The plausible behaviour — plugin loads and applies, and the licence check surfaces as a watermark or render-time error rather than a scripting exception — is consistent with the existence of community threads about plugins that show a licence error at render time ([Adobe community thread](https://community.adobe.com/questions-529/searching-for-an-effect-plugin-that-shows-error-message-e-g-no-license-if-you-try-to-render-69726)), but I could not confirm this for a specific vendor.
- The AE version that introduced `app.effects` is not stated on the docsforadobe Application page I read.

---

## Q6. Animation presets (.ffx) and `applyPreset`

### Takeaway
`Layer.applyPreset(File)` applies an `.ffx` animation preset, but with a large trap: the preset is applied to the **currently selected layers of the comp**, not to the layer the method was called on — so a script must manage `comp.selectedLayers` / `layer.selected` itself.

### Cited Findings
- Signature: `app.project.item(index).layer(index).applyPreset(presetName);` where `presetName` is "An ExtendScript File object representing the animation preset file". Returns nothing — [Layer object](https://ae-scripting.docsforadobe.dev/layer/layer/)
- Description: it "applies the specified collection of animation settings (an animation preset) to all the currently selected layers of the comp" — [Layer object](https://ae-scripting.docsforadobe.dev/layer/layer/)
- Documented warning: "the animation preset is applied to the selected layer(s) of the comp, not to the layer whose applyPreset function is called" — [Layer object](https://ae-scripting.docsforadobe.dev/layer/layer/)
- Preset files come from the installed Presets folder, and users can author custom presets from the UI — [Layer object](https://ae-scripting.docsforadobe.dev/layer/layer/)

### Code

```javascript
// Robust applyPreset: save selection, isolate the target, apply, restore.
function applyPresetToLayer(layer, ffxPath) {
    var comp = layer.containingComp;
    var file = new File(ffxPath);
    if (!file.exists) { throw new Error("Preset not found: " + ffxPath); }

    var prevSelection = comp.selectedLayers;      // array snapshot
    var i;
    for (i = 0; i < prevSelection.length; i++) { prevSelection[i].selected = false; }

    layer.selected = true;
    layer.applyPreset(file);                      // applies to SELECTED layers
    layer.selected = false;

    for (i = 0; i < prevSelection.length; i++) { prevSelection[i].selected = true; }
}

// Applying the same preset to several layers at once is just: select them all,
// then call applyPreset once on any one of them.
```

### Inferences
- Since the preset targets the selection, an MCP "apply preset" tool must never assume the caller's selection state; wrapping in select/restore (above) is mandatory for predictable behaviour.
- Presets are the only practical way to reproduce effect setups that include parameters a script cannot set (custom-value parameters, curves, gradients) — authoring an `.ffx` by hand in the UI and applying it by script is the standard workaround.
- `.ffx` is an opaque binary format, so an MCP server cannot synthesise presets programmatically; it can only apply files that already exist.

### Gaps
- No documented behaviour for applying a preset whose effects are not installed (does it silently drop them, or raise?) — unverified.
- No documented version requirement for `applyPreset`; it is long-standing.
- I found no documentation of a scripting API to *save* an animation preset (the UI-only "Save Animation Preset" command); `app.executeCommand` with a `findMenuCommandId` lookup is the usual community workaround, and `app.findMenuCommandId` is explicitly warned to be "not reliable across different language packages of AE" — [Application object](https://ae-scripting.docsforadobe.dev/general/application/).

---

## Q7. Known traps

### Takeaway
The documented hazards are: index invalidation after every `addProperty`, `setValue` throwing on keyframed properties, non-AV layer types having no Effects group at all, `CUSTOM_VALUE`/`NO_VALUE` parameters that scripts cannot meaningfully set, and spatial-only methods that throw on other property types. Third-party licensing behaviour under scripting is undocumented.

### Cited Findings
- **Index invalidation:** "When you add a new property to an indexed group, the indexed group gets recreated from scratch, invalidating all existing references to properties." Workaround: store `property.propertyIndex` — [PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- **addProperty throws:** "If the method cannot create a property with the specified name, it generates an exception"; use `canAddProperty()` first — [PropertyGroup](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- **Indexed-group restriction:** properties can only be added to an indexed group (`PropertyType.INDEXED_GROUP`), except text animators which may be added to a named group — [PropertyGroup.addProperty](https://ae-scripting.docsforadobe.dev/property/propertygroup/)
- **setValue on keyframed property:** throws an error if keyframes exist; must use `setValueAtTime()`/`setValueAtKey()` — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- **Spatial-only methods:** `setSpatialTangentsAtKey()` requires `TwoD_SPATIAL` or `ThreeD_SPATIAL` and "throws an exception otherwise" — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- **Expressions not always settable:** `expression` is "Writeable only when `canSetExpression`… is `true`"; `expressionEnabled` can only be set true if `canSetExpression` is true and the expression string is valid — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- **Layer types:** `ADBE Effect Parade` is listed among AV Layer match names — [AV Layer Match Names](https://ae-scripting.docsforadobe.dev/matchnames/layer/avlayer/). Text, Shape, ThreeDModel and ParametricMesh layers are AVLayer subclasses; CameraLayer and LightLayer are separate types that do not inherit AVLayer — [AVLayer object](https://ae-scripting.docsforadobe.dev/layer/avlayer/)
- **Parameter types scripts can't set sensibly:** `PropertyValueType.CUSTOM_VALUE` covers "Custom property value, such as the Histogram property for the Levels effect"; `NO_VALUE` "stores no data" — [Property object](https://ae-scripting.docsforadobe.dev/property/property/)
- **Dropdown menu items:** only Dropdown Menu Control properties accept `setPropertyParameters()` (AE 17.0.1+), guarded by `Property.isDropdownEffect`; items must be non-empty, unique, backslash-free strings — [Property object / setPropertyParameters](https://ae-scripting.docsforadobe.dev/property/property/)
- **Menu-command fallback is fragile:** `app.findMenuCommandId()` "is not reliable across different language packages of AE" — [Application object](https://ae-scripting.docsforadobe.dev/general/application/)
- **Not everything is scriptable:** the Scripting Guide overview notes that not all objects in an After Effects project are accessible to scripting — [Overview, After Effects Scripting Guide](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- **Undo:** `app.beginUndoGroup(undoString)` / `app.endUndoGroup()`; nested groups merge into the larger group and undo correctly — [Application object](https://ae-scripting.docsforadobe.dev/general/application/)
- Community reports exist of "Object is Invalid" errors when holding stale property references while modifying shape layer stroke/fill properties — [Adobe community thread](https://community.adobe.com/t5/after-effects-discussions/after-effects-scripting-quot-object-is-invalid-quot-error-with-stroke-and-fill-properties/m-p/15421186)

### Defensive pattern for an MCP tool

```javascript
function safeApplyEffect(comp, layerIndex, matchName, params) {
    app.beginUndoGroup("MCP: apply " + matchName);
    try {
        var layer = comp.layer(layerIndex);
        var fx = layer.property("ADBE Effect Parade");
        if (fx === null) { throw new Error("This layer type has no Effects group."); }
        if (!fx.canAddProperty(matchName)) {
            throw new Error("Cannot add '" + matchName + "' (not installed, or not addable here).");
        }
        var effect = fx.addProperty(matchName);
        var effectIndex = effect.propertyIndex;      // survives later addProperty calls

        for (var key in params) {
            if (!params.hasOwnProperty(key)) { continue; }
            var p = effect.property(key);            // key = parameter match name
            if (p === null) { continue; }
            if (p.propertyValueType === PropertyValueType.NO_VALUE ||
                p.propertyValueType === PropertyValueType.CUSTOM_VALUE) { continue; }
            if (p.numKeys > 0) { p.setValueAtTime(comp.time, params[key]); }
            else               { p.setValue(params[key]); }
        }
        return { index: effectIndex, name: effect.name, matchName: effect.matchName };
    } finally {
        app.endUndoGroup();
    }
}
```

### Inferences
- Camera and light layers reject effects entirely (no `ADBE Effect Parade`); guide layers, adjustment layers, solids, nulls, text and shape layers all accept them because they are AVLayers. Audio-only layers technically have an Effects group but only audio effects are addable — the latter half is my inference, unverified.
- Because `addProperty` rebuilds the indexed group, an MCP tool that applies several effects in one call must re-fetch `layer.property("ADBE Effect Parade")` and address earlier effects by stored `propertyIndex` or by instance name, never by a cached object.
- Every write should sit inside a `beginUndoGroup`/`endUndoGroup` pair so the user can undo an agent's whole action in one step; use `try/finally` so a thrown exception doesn't leave an undo group open.
- ExtendScript is ES3-era: avoid `let/const`, arrow functions, `JSON.parse/stringify` (unless you polyfill), `Array.prototype.forEach/map/indexOf` on older hosts, and trailing commas.

### Gaps
- No authoritative list of "effects that cannot be added by script" was found; `canAddProperty()` is the only reliable runtime test.
- No authoritative list of read-only effect parameters; `propertyValueType` (`NO_VALUE`, `CUSTOM_VALUE`) plus a try/catch is the practical guard.
- Third-party licence/activation behaviour under scripting (trial watermarks, render-time licence errors, demo-mode plugins that still appear in `app.effects`) is undocumented in every source I checked — this needs empirical testing per vendor.
- AE-version minimums for most of the effect APIs are not stated in the docs; the only firm version data points found were `setPropertyParameters` (After Effects 17.0.1, 2020) and `essentialPropertySource` (After Effects 22.0) — [Property object](https://ae-scripting.docsforadobe.dev/property/property/).
