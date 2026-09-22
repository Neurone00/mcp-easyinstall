# Hard limits of ExtendScript automation in Adobe Illustrator and After Effects

> Scope note on versions: research conducted September 2026. Where sources are dated they are dated inline.
> The newest documented community status notes found are from April 2026. Exact shipping version numbers
> for the "2026" releases of Illustrator and After Effects could not be confirmed from a primary Adobe
> source during this research — see Gaps. Claims below are keyed to the versions the cited source names
> (e.g. Illustrator CS6+, v26.3.1, v29.0; After Effects 22.0, 25.6).

---

## ILLUSTRATOR: What is not exposed in the ExtendScript DOM (Pathfinder, Image Trace, Recolor, Blends, Envelope Distort, Live Paint, Shape Builder, Puppet Warp, Offset Path, Width profiles, Appearance, Effects)

### Takeaway
Only **Image Trace** has a real, documented DOM API. Almost everything else in this list is either **not in the DOM at all** and reachable only through `app.executeMenuCommand()` or a recorded Action played with `app.doScript()`, or (Appearance/Effects) is **effectively unreachable** except by pre-baking the look into a Graphic Style and calling `GraphicStyle.applyTo()`. The Appearance panel and the Effect menu are the two hardest walls: the DOM models exactly one fill and one stroke per object, in fixed order.

### Cited Findings

**Image Trace — genuinely in the DOM (the exception).**
- Illustrator's DOM exposes a `TracingObject`, started from `PlacedItem.trace()` or `RasterItem.trace()`, which creates a `PluginItem` holding the traced art; `tracingOptions` controls the conversion settings, `expandTracing([viewed])` converts the result to a `GroupItem`, and `releaseTracing()` reverts to the original raster — [Adobe Illustrator Scripting Guide, TracingObject](https://ai-scripting.docsforadobe.dev/jsobjref/TracingObject/)
- Documented caveat: "The read-only properties that describe the tracing result have valid values only after the first tracing operation completes. A value of 0 indicates that the operation has not yet been completed." Scripts must call `Application.redraw()` after creating the tracing object before reading `pathCount`, `anchorCount`, `usedColorCount`, etc. — [Adobe Illustrator Scripting Guide, TracingObject](https://ai-scripting.docsforadobe.dev/jsobjref/TracingObject/)

**Pathfinder — not in the DOM.**
- "There is no DOM support for pathfinder in ExtendScript." Actions are the documented escape hatch: "Actions can be used to apply commands that are not available in the scripting language (example: Make Compound Shape)" — [Adobe Illustrator scripts / Medium, "Running scripts via drag-and-drop"](https://aiscripts.medium.com/running-scripts-via-drag-and-drop-84021c505ed4); see also [Adobe Community: Script ran via actions does not select properly](https://community.adobe.com/t5/illustrator-discussions/script-ran-via-actions-does-not-select-properly/td-p/13032773)
- Pathfinder via Action is fragile in one specific configuration: a script that runs Pathfinder works when launched from File > Scripts, but fails to select the right layer when the *script itself* is launched from inside an Action. A reported workaround is to select-all then deselect-all at the top of the script — [Adobe Community thread](https://community.adobe.com/t5/illustrator-discussions/script-ran-via-actions-does-not-select-properly/m-p/13033493/highlight/true)

**Appearance panel and the Effect menu — not in the DOM.**
- "The scripting API currently does not provide access to the capabilities of the Appearance Panel, such as applying multiple fills and strokes in arbitrary order. Via scripting we can only access `fillColor` and `strokeColor` with no control of order (stroke is always above fill)." This is an open feature request on Adobe's own Illustrator UserVoice — [Illustrator UserVoice: Edit Appearances with Scripting](https://illustrator.uservoice.com/forums/908050-sdk-scripting-bugs-and-features/suggestions/34339813-edit-appearances-with-scripting)
- Scripts also cannot read back complex appearances (pattern fills, stacked fills/strokes/effects), and the "Align Stroke to" options are not exposed — [Illustrator UserVoice: Edit Appearances with Scripting](https://illustrator.uservoice.com/forums/908050-sdk-scripting-bugs-and-features/suggestions/34339813-edit-appearances-with-scripting)
- Partial workaround that *is* documented: `GraphicStyle.applyTo(artItem)` "applies a graphic style to a specified art item", and a graphic style "defines a set of appearance attributes that you can apply non-destructively to page items" — [Adobe Illustrator Scripting Guide, GraphicStyle](https://ai-scripting.docsforadobe.dev/jsobjref/GraphicStyle/). So a live effect can be applied by a script only if the effect was pre-authored into a Graphic Style by a human (or loaded from a style library).
- Community threads asking "how can I apply any effects to a layer using scripts" converge on the same answer (graphic styles / actions), not a DOM API — [Adobe Community](https://community.adobe.com/t5/illustrator-discussions/how-can-i-apply-any-effects-to-a-layer-using-scripts-in-illustrator/m-p/11433011/highlight/true)

**Envelope Distort — not creatable from the DOM; contents barely readable.**
- "Illustrator's scripting API doesn't support accessing text frames inside an envelope object", and the known hack requires the envelope item to be in "Edit Contents" mode — reported in Illustrator scripting discussion surfaced via [creold/illustrator-scripts docs](https://github.com/creold/illustrator-scripts/blob/master/md/Item.md)
- Non-scripting constraint that also bites automation: envelope distort works on **embedded** images only, not linked ones (linking is Illustrator's default for placed rasters) — [Adobe Community: Envelope distort on JPEG not working](https://community.adobe.com/t5/illustrator-discussions/envelope-distort-on-jpeg-not-working/m-p/10131989)

**`executeMenuCommand` as the general fallback for everything above.**
- Since CS6 Illustrator has `app.executeMenuCommand(menuCommandString)`, which runs a menu item by its internal string, but **Adobe publishes no official list of the strings** — [Adobe Community: [JS] CS6+ executeMenuCommand](https://community.adobe.com/t5/illustrator/js-cs6-executemenucommand/td-p/5904747)
- The community list was extracted from the 2017 SDK by Shalako Lee and contains ~506 commands; **about 90 of those no longer work** in newer versions. A maintained sheet adds a working list tested in Illustrator v26.3.1 plus new commands added in v29.0 — [Adobe Community: executeMenuCommand() Command List](https://community.adobe.com/t5/illustrator-discussions/executemenucommand-command-list/td-p/13131490)
- Community lists deliberately strip "plugin-like commands" because they do not work through `executeMenuCommand` — same thread.
- Adobe's own Illustrator bug tracker carries a standing "SDK and Scripting" category with dozens of open scripting gaps/bugs — [Illustrator UserVoice: SDK and Scripting bugs](https://illustrator.uservoice.com/forums/601447-illustrator-desktop-bugs/category/209077-sdk-and-scripting)

### Inferences
- Classification for the requested feature list, based on the above:
  - **Image Trace / Live Trace** — *DOM (real API)*: `PlacedItem.trace()`, `RasterItem.trace()`, `TracingObject.tracingOptions`, `expandTracing()`. Caveat: must `redraw()` before trusting result properties.
  - **Pathfinder** — *Not in the DOM*. Menu command or recorded Action only. (Note: `PathItem`-level boolean geometry can sometimes be hand-rolled, but there is no Pathfinder API.)
  - **Recolor Artwork** — no DOM API was found in the scripting reference; it is a menu/dialog feature. Treat as *menu-command-or-Action only*, and note the dialog is interactive, so a fully headless recolor is unlikely. **Unverified** — see Gaps.
  - **Blend objects** — blends surface as `PluginItem`s; no creation/editing API was found. Treat as *menu command ("Blend > Make") or Action only, read-only from the DOM*. **Unverified** — see Gaps.
  - **Envelope Distort** — *Not creatable from the DOM*; contents access is a documented gap with an unreliable hack.
  - **Live Paint, Shape Builder, Puppet Warp, Offset Path, Width Tool profiles** — no entries for any of these were found in the DOM reference; the Appearance/Effects gap covers Offset Path (it is an Effect) and the single-fill/single-stroke model covers width profiles. Treat as *not scriptable via DOM*; Live Paint and Offset Path have menu commands, Shape Builder and Puppet Warp are direct-manipulation tools with no obvious menu equivalent and are the likeliest true "impossible" cases. **Unverified individually** — see Gaps.
- Practical rule for an MCP/automation product: anything that in the UI opens a modal dialog with options (Image Trace panel aside, e.g. Recolor Artwork, Offset Path) cannot be driven headlessly from a script; an Action can replay *the choices recorded at record time* but cannot parameterise them at run time without regenerating the Action file (see next section).

### Gaps
- Could not find a single authoritative Adobe page enumerating "features absent from the Illustrator DOM". The Illustrator Scripting Reference documents what exists; absence is inferred from its table of contents plus community/UserVoice reports.
- **Recolor Artwork, Blend objects, Live Paint, Shape Builder, Puppet Warp, Offset Path, Width Tool profiles** were not individually confirmed against the DOM reference within the tool-call budget. My classification above is inference from the reference's object list plus the general Appearance/Effects gap. A follow-up pass should grep the Illustrator Scripting Reference object index directly before any of these is asserted publicly.
- No source found stating whether Recolor Artwork's dialog can be suppressed the way Photoshop's can.

---

## ILLUSTRATOR: `app.doScript()` with Actions as an escape hatch — how it works and its limits

### Takeaway
`app.doScript(actionName, actionSetName)` plays a pre-recorded Action from a script, and it is the standard way to reach Pathfinder, Make Compound Shape and similar non-DOM commands. It **does** require the Action to exist in the Actions panel — but a script can install one at run time by writing a `.aia` file to disk and calling `app.loadAction()`, then `app.unloadAction()` to clean up. That combination is the closest Illustrator has to Photoshop's `executeAction`/`batchPlay`; there is **no** Illustrator equivalent of the ActionManager/`batchPlay` API.

### Cited Findings
- "Scripts in Illustrator since CS6 can run actions through the `app.doScript()` method, which is convenient for those who find it easier to write down a set of operations rather than code their ExtendScript counterpart." — [Adobe Illustrator scripts / Medium](https://aiscripts.medium.com/running-scripts-via-drag-and-drop-84021c505ed4)
- "Actions can be used to apply commands that are not available in the scripting language (example: Make Compound Shape)" — same source.
- `app.loadAction()` "can read .aia files right into the Actions panel", e.g. `app.loadAction(new File("path/to/actionFile.aia"))`; `app.unloadAction(setName, actionName)` removes an action, and passing an empty string as the action name removes the whole set — [Adobe Community: Script to load a set of actions](https://community.adobe.com/t5/illustrator/script-to-load-a-set-of-actions/m-p/9391171); [Adobe Community: AppleScript or JavaScript to load action set](https://community.adobe.com/t5/illustrator-discussions/applecript-or-javascript-to-load-action-set/m-p/6396132)
- The full "dynamic action" pattern — generate the `.aia` text, `loadAction()`, `doScript()`, `unloadAction()` in a try/catch — is a well-established community technique, discussed at length in [Adobe Community: Creating a dynamic action to use with app.doScript()](https://community.adobe.com/t5/illustrator-discussions/creating-a-dynamic-action-to-use-with-app-doscript-method/td-p/8918373) and [Dynamic app.doScript() actions](https://community.adobe.com/t5/illustrator-discussions/dynamic-app-doscript-actions/m-p/10797616), with reference implementations at [Silly-V/Adobe-Illustrator-Helpers ReloadActions.jsx](https://github.com/Silly-V/Adobe-Illustrator-Helpers/blob/master/ReloadActions.jsx) and [Inventsable/Redesigning-Illustrator-Actions-in-Scripting](https://github.com/Inventsable/Redesigning-Illustrator-Actions-in-Scripting)
- **Deadlock hazard:** "When making an Action that runs a script using `app.doScript()` calls, Illustrator can freeze, as Illustrator Actions and scripts run in different execution threads, and running an Action that runs a script that runs an Action causes a standstill." — [Adobe Community discussion on doScript behaviour](https://community.adobe.com/t5/illustrator-discussions/weird-app-doscript-behavior/m-p/14099355)
- Practical unload pattern uses try/catch because `unloadAction` throws when the set is already gone — [Adobe Community](https://community.adobe.com/t5/illustrator/script-to-load-a-set-of-actions/m-p/9391171)

### Inferences
- Answer to "does it require a pre-recorded Action set to be installed?" — **Yes at play time, no at authoring time.** The Action must be in the panel when `doScript` runs, but the script can put it there itself. So an MCP server shipping its own `.aia` payloads can offer Pathfinder etc. without asking the user to record anything.
- Answer to "can a script create an Action set?" — **Not through an API.** There is no `createAction()`. Scripts create actions only by *writing the `.aia` file format by hand* and loading it. That makes the `.aia` format an undocumented dependency: it is a text format reverse-engineered by the community, and its opcode encoding is version-sensitive. Classify this as **possible but undocumented/fragile**.
- Answer to "is there an equivalent of Photoshop's `executeAction`/`batchPlay`?" — **No.** No source in this research references an ActionManager, `executeAction`, or `batchPlay` in Illustrator. `doScript` + `executeMenuCommand` are the substitutes, and both are coarser: `executeMenuCommand` cannot pass parameters at all, and `doScript` can only replay parameters frozen into the `.aia`.
- The thread-deadlock note means the safe direction is **script → action**, never **action → script → action**. Any product should refuse to be launched from inside an Action if it internally calls `doScript`.

### Gaps
- No Adobe-published specification of the `.aia` file format was found; all knowledge of it is community-derived.
- Whether `doScript` has a synchronous/asynchronous variant (some references mention a third boolean argument) was not confirmed from a primary source.

---

## AFTER EFFECTS: What is not scriptable (render engines, Roto Brush, Content-Aware Fill, mask tracking, Essential Graphics, .mogrt, pixel data, graph editor)

### Takeaway
After Effects' scripting DOM covers **project structure** — project, items, comps, layers, properties, render queue — and explicitly not everything in the app: "every object in an After Effects project has its own identity (although not all are accessible to scripting)". Essential Graphics and `.mogrt` export **are** scriptable (a genuine, documented API). Roto Brush, Content-Aware Fill, mask tracking, the graph editor and rendered pixel data are **not**.

### Cited Findings
- Scope of the DOM: "a project, items, compositions, layers, and render queue items"; and "every object in an After Effects project has its own identity (although not all are accessible to scripting)" — [After Effects Scripting Guide, Overview](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- Scripts "can automate repetitive tasks, perform complex calculations, and even use some functionality not directly exposed through the graphical user interface" — same source.
- **Security gate:** "The default is for scripts to not be allowed to write files or send or receive communication over a network." The user must enable this in Preferences (Allow Scripts to Write Files and Access Network) — [After Effects Scripting Guide, Overview](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- **Essential Graphics / .mogrt IS scriptable:** `app.project.activeItem.motionGraphicsTemplateName` sets the exported file name; a comp method exports it as a Motion Graphics template (returning true/false, with an optional output folder path); scripts can test whether a property can be added to the EGP and then add it — [docsforadobe AE Scripting Guide: Essential Graphics Panel Integration](https://deepwiki.com/docsforadobe/after-effects-scripting-guide/10.2-essential-graphics-panel-integration); tooling that batch-exports `.mogrt` from script exists commercially, e.g. [Aep to Mogrt Pro](https://aescripts.com/aep-to-mogrt/) and [AE MOGRT Batch Exporter](https://volltone.gumroad.com/l/ae-mogrt-batch-exporter)
- **Pixel data is not accessible to scripts:** "After Effects Scripts, unlike plug-ins, can only access the core functionality of After Effects... an After Effects script is written with ExtendScript and is used to communicate with the After Effects API in order to automate existing functions" — whereas plugins "manipulat[e] the actual pixels of a given layer" — [AE Screens: After Effects Plugins vs. Scripts vs. Extensions](https://www.aescreens.com/blog/after-effects-plugins-vs-scripts-vs-extensions)
- Pixel access is a C++/AEGP capability: AEGP plugins get frame pixels via `AEGP_RenderAndCheckoutFrame` and `AEGP_GetReceiptWorld`, and allocate/manipulate 8/16/32-bit pixel buffers — [After Effects C++ SDK Guide, AEGPs](https://ae-plugins.docsforadobe.dev/aegps/aegps/); [AEGP Suites](https://ae-plugins.docsforadobe.dev/aegps/aegp-suites/)
- Rendering while scripting: "While rendering is paused, you cannot change settings or use After Effects in any other way" — [Adobe Help: Basics of rendering and exporting in After Effects](https://helpx.adobe.com/after-effects/using/basics-rendering-exporting.html)
- An **undocumented** non-blocking render call exists: "app.project.renderQueue.renderAsync()" does not block the UI, at the cost of progress reporting — [Adobe Community thread on rendering from ExtendScript](https://community.adobe.com/t5/after-effects-discussions/how-to-render-a-composition-in-after-effects-using-extendscript/m-p/13940084/highlight/true)
- Offloading works: `app.project.renderQueue.queueInAME(true)` hands rendering to Adobe Media Encoder, which several users found more reliable than `render()` — [Adobe Community: renderQueue.render() doesn't work](https://community.adobe.com/t5/after-effects-discussions/app-project-renderqueue-render-doesn-t-work/m-p/15191442/highlight/true)

### Inferences
- Classification for the requested AE feature list:
  - **Motion Graphics templates / Essential Graphics panel** — *scriptable, documented API*. This is the strongest automation surface in modern AE scripting.
  - **Rendering** — *scriptable for AE's own render queue and output modules*. Third-party render engines that are implemented as AE **effects/plugins** can be applied by script (add effect by matchName, set parameters) because effects are ordinary `PropertyGroup`s; engines that are separate applications or have their own out-of-DOM UI are not driveable. External batch rendering goes through `aerender` (CLI) or `queueInAME()`. **The specific claim "third-party render engines cannot be driven by script" was not confirmed by a source** — see Gaps.
  - **Roto Brush / Roto Brush 2** — *not scriptable*. A script can add the Roto Brush effect to a layer, but the segmentation stroke is a direct-manipulation, GPU-computed operation with no scripted entry point; no API was found. Treat as **impossible from script**; requires human-in-the-loop or a C++ plugin.
  - **Content-Aware Fill** — *not scriptable*. Same reasoning: it is a panel-driven operation that generates a fill layer; no scripting API was found. Treat as **impossible from script**.
  - **Mask tracking** — *not scriptable*. No API found; it is a contextual-menu/tracker-panel operation. Treat as **impossible from script**.
  - **Reading rendered pixel data** — *impossible from ExtendScript by design*; the documented path is a C++ AEGP plugin, or render to disk and read the file externally (which itself requires the "Allow Scripts to Write Files" preference).
  - **Graph editor / timeline UI** — *not scriptable*. Scripts can read and write keyframe values, times, interpolation types and temporal/spatial ease via the `Property` object, which is the *data* behind the graph editor; they cannot drive the graph editor UI itself, change what it displays, or control panel layout. **The data-side capability is inferred from the DOM's coverage of properties, not directly cited** — see Gaps.
- Practical consequence for product promises: anything in AE that is an *estimation/AI* feature (Roto Brush, Content-Aware Fill, tracking) sits outside the scripting boundary. These should be presented as "prepare the project by script, then hand off to the human", the same human-in-the-loop shape used elsewhere in this project.

### Gaps
- Could not find an explicit Adobe statement saying Roto Brush, Content-Aware Fill or mask tracking are unscriptable. The evidence is negative (no API in the reference, no community script doing it) rather than positive. State this as "no scripting API exists" rather than "Adobe says it is impossible".
- Third-party render engine control from script was not researched to a conclusion; no source found either way.
- `renderAsync()` is reported as undocumented by a forum post only — its existence, argument list, and version availability were not verified against the scripting reference.
- The precise AE version that introduced `exportAsMotionGraphicsTemplate` / `addToMotionGraphicsTemplate` was not pinned down.

---

## AFTER EFFECTS: Scripts vs. C++ plugins (AE SDK) vs. CEP/UXP panels

### Takeaway
The dividing line is **pixels and new behaviour vs. project structure**. Scripts automate what AE can already do; C++ plugins (effects and AEGPs) can create new rendering behaviour, touch pixel buffers, and hook AE internals; CEP panels are just a browser UI wrapper that calls ExtendScript underneath, so they inherit every ExtendScript limitation and add none of a plugin's powers.

### Cited Findings
- "After Effects plugins are typically written in C++ and use the After Effects SDK, giving them the power to do more things than are natively possible within After Effects, usually involving manipulating the actual pixels of a given layer." By contrast scripts "can only access the core functionality of After Effects... almost everything done with a script is technically possible to do natively in After Effects without the script." — [AE Screens: Plugins vs. Scripts vs. Extensions](https://www.aescreens.com/blog/after-effects-plugins-vs-scripts-vs-extensions)
- AEGP (After Effects General Plug-in) capabilities and the suite-based API surface — [After Effects C++ SDK Guide: AEGPs overview](https://ae-plugins.docsforadobe.dev/aegps/overview/); [What Can I Do With This SDK?](https://ae-plugins.docsforadobe.dev/intro/what-can-i-do/)
- AEGPs render and check out frames (`AEGP_RenderAndCheckoutFrame`, `AEGP_GetReceiptWorld`) and work with 8/16/32-bit pixel worlds — [AEGP Suites](https://ae-plugins.docsforadobe.dev/aegps/aegp-suites/); [pushREC AE SDK KB: AEGP plugins](https://github.com/pushREC/after-effects-sdk-kb/blob/main/wave-1/03-aegp-plugins.md)
- Expressions are a third, separate layer: "Whereas a script tells an application to do something, an expression says that a property is something", and "Expressions cannot access information from scripts (such as variables and functions)" — [After Effects Scripting Guide, Overview](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- AE panels today are CEP + ExtendScript; commercial AE panels such as Motion 4 and BeatEdit use CEP — [pushREC AE SDK KB: UXP status note (April 2026)](https://github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/UXP-STATUS-NOTE.md)

### Inferences
- A CEP panel adds **no capability** over a plain `.jsx` script; it only adds a modern HTML/JS UI, a Node.js side channel, and persistence. If the goal is capability, the choice is script vs. C++ plugin, not script vs. panel.
- The one thing CEP adds that matters operationally: a Node.js process outside ExtendScript, which can do networking, spawn processes, and do heavy computation without blocking ExtendScript — useful for an MCP-style bridge.
- Expressions are a fourth automation surface worth noting for a product: they can encode behaviour that persists after the script exits, and a script *can* write expression strings into properties even though the two cannot share runtime state.

### Gaps
- The exact list of AEGP-only hooks (idle hooks, command hooks, menu insertion, project-change notification) was not enumerated from the SDK docs in this pass; the SDK guide pages cited are the place to get it.

---

## BOTH: Is ExtendScript deprecated? UXP migration path and current state per app

### Takeaway
ExtendScript is **legacy but not removed, and no removal date has been announced for either Illustrator or After Effects**. As of April 2026, **neither Illustrator nor After Effects has a public UXP plugin/panel API** — Photoshop, InDesign and Premiere Pro do. For these two apps specifically, ExtendScript (+ CEP for panels) remains the only public option, which means ExtendScript investment here is currently unavoidable rather than merely defensible. Note the sourcing caveat below.

### Cited Findings
- "UXP panels for After Effects are not yet available as of April 2026." After Effects appears in the UXP version matrix from version 22.0 / UXP 5.5, but that covers **scripting APIs only, not the panel framework** shipped for Photoshop, InDesign and Premiere Pro — [pushREC AE SDK KB: UXP-STATUS-NOTE.md](https://github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/UXP-STATUS-NOTE.md)
- Same source's version timeline: Photoshop first production UXP; InDesign production UXP in 2024; **Premiere Pro UXP shipped in v25.6, December 2025** — [pushREC AE SDK KB](https://github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/UXP-STATUS-NOTE.md)
- For Illustrator: "UXP remains internal to Adobe as of 2026, with no published API or release timeline for third-party developers... CEP is the only public option" for panels; "Adobe has not signalled CEP deprecation for Illustrator", and when UXP launched for Photoshop, CEP continued to load alongside it for several years — [Mapsoft: UXP for Illustrator — Status & What to Use Today](https://mapsoft.com/posts/illustrator-uxp-status.html) **(secondary/SEO source — see Gaps)**
- Adobe has confirmed CEP will eventually be retired but "committed only to a 'several years' horizon with no announced cut-off date" — [Mapsoft: Illustrator CEP Extensions in 2026](https://mapsoft.com/posts/illustrator-cep-extensions.html) **(secondary/SEO source — see Gaps)**
- Historical Adobe-adjacent statement: at an Adobe developer session, Kerri Shotts said "UXP will be reaching more Adobe products by 2021" (timelines subject to change), potentially including Illustrator, Premiere Pro and InDesign, and that legacy CEP and ExtendScript would "continue to work side by side as UXP gradually makes its appearance" — [Adobe Community: Illustrator UXP integration timeline / road map](https://community.adobe.com/t5/illustrator-discussions/adobe-illustrator-uxp-integration-timeline-road-map/td-p/11379805). A March 2024 reply in the same thread reports Illustrator UXP "is not on the schedule for at least 2024", citing the Creative Cloud Developer Forums. That 2021 prediction did not come true for Illustrator or AE.
- ExtendScript is characterised across sources as Adobe's legacy JavaScript-based automation layer for Photoshop, Illustrator, InDesign, Acrobat, After Effects and Bridge, with UXP as the strategic replacement for both CEP and ExtendScript — [Mapsoft: What is Adobe ExtendScript? Toolkit, UXP & 2026 Status](https://mapsoft.com/posts/extendscript.html) **(secondary source)**

### Inferences
- **Investment guidance:** for an Illustrator + After Effects automation product in 2026, ExtendScript is not a bet — it is the only road. There is no UXP alternative to migrate to for either app. The risk is not that ExtendScript stops working soon; it is that a future UXP API will require a rewrite with no shared code, since UXP is a different runtime (no ScriptUI, no `File`/`Folder` in the same form, modern JS engine, async APIs).
- Mitigation worth designing for now: keep the *logic* (what to do) separate from the *host bindings* (how to say it in ExtendScript), so a future UXP port replaces only the binding layer. This matters more for Illustrator than AE, since Illustrator UXP is at least internally in progress.
- The ExtendScript Toolkit (ESTK) IDE is dead; the supported debugging path is the VS Code ExtendScript Debugger extension, which appears in the Illustrator forum threads cited above (e.g. [executeMenuCommand and doScript problem in VS Code ExtendScript Debugger 2.0.3](https://community.adobe.com/t5/illustrator-discussions/executemenucommand-and-doscript-problem-in-vs-code-extendscript-debugger-2-0-3/m-p/13346131)). Treat as inference on support status; not separately cited.

### Gaps
- **Sourcing caveat, important:** several of the cleanest 2026 status statements above come from mapsoft.com, which reads as SEO/aggregator content rather than a primary Adobe source. I could not reach an Adobe-published UXP version matrix or deprecation statement within the tool budget. The two claims I would most want re-verified against `developer.adobe.com` before publishing are (a) that Illustrator UXP is still internal-only in 2026, and (b) that Adobe has "confirmed CEP will eventually be retired" with a several-year horizon. The pushREC AE knowledge base independently corroborates (a)'s AE counterpart and the Premiere v25.6 date, which raises confidence in the overall picture but not in those two specific sentences.
- The pushREC note itself states it "contains no direct Adobe quotes about AE UXP timelines — only observations about current status".
- No source found giving an announced end-of-life date for ExtendScript in any app.

---

## BOTH: Practical constraints — timeouts, modal dialogs, rendering, undo, UI freezing

### Takeaway
There is no documented per-script execution timeout in either app; the real constraint is that **ExtendScript is single-threaded and synchronous on the app's main thread**, so any long script freezes the host UI. AE ships a documented cooperative workaround (`app.scheduleTask`); Illustrator does not, and additionally has a genuine deadlock if an Action calls a script that calls an Action.

### Cited Findings
- **AE, UI freezing and the fix:** replacing `for`/`while` loops with `app.scheduleTask` keeps AE from freezing — [Adobe Community: Retain control in loop through the ScriptUI](https://community.adobe.com/t5/after-effects-discussions/retain-control-in-loop-through-the-scriptui/m-p/9057979/highlight/true)
- **AE, script UI freezes during render:** reported directly by users — [Adobe Community: My script's UI is freezing during render time](https://community.adobe.com/t5/after-effects-discussions/my-script-s-ui-is-freezing-during-render-time-is-there-a-fix-for-this/m-p/8562091/highlight/true)
- **AE, you cannot use the app during a render:** "While rendering is paused, you cannot change settings or use After Effects in any other way" — [Adobe Help: Basics of rendering and exporting](https://helpx.adobe.com/after-effects/using/basics-rendering-exporting.html)
- **AE, non-blocking alternatives:** undocumented `app.project.renderQueue.renderAsync()` does not block the UI but gives up progress reporting — [Adobe Community](https://community.adobe.com/t5/after-effects-discussions/how-to-render-a-composition-in-after-effects-using-extendscript/m-p/13940084/highlight/true); `queueInAME(true)` offloads to Adobe Media Encoder — [Adobe Community](https://community.adobe.com/t5/after-effects-discussions/app-project-renderqueue-render-doesn-t-work/m-p/15191442/highlight/true)
- **AE, file/network permission gate:** scripts cannot write files or use the network unless the user ticks the preference — [After Effects Scripting Guide, Overview](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- **Illustrator, Action/script deadlock:** Illustrator Actions and scripts "run in different execution threads", and an Action → script → `doScript` chain "causes a standstill" (Illustrator freezes) — [Adobe Community: Weird app.doScript() behavior](https://community.adobe.com/t5/illustrator-discussions/weird-app-doscript-behavior/m-p/14099355)
- **Illustrator, selection state is not reliable across the script/Action boundary:** the same script that selects correctly when run from File > Scripts fails to select when invoked from an Action; workaround is select-all/deselect-all at script start — [Adobe Community](https://community.adobe.com/t5/illustrator-discussions/script-ran-via-actions-does-not-select-properly/m-p/13033493/highlight/true)
- **Illustrator, `redraw()` is sometimes mandatory, not cosmetic:** tracing result properties read 0 until the operation completes, and `Application.redraw()` is the documented way to force it — [Adobe Illustrator Scripting Guide, TracingObject](https://ai-scripting.docsforadobe.dev/jsobjref/TracingObject/)
- **Installing/running scripts** in Illustrator (File > Scripts, Scripts folder, keyboard shortcut requires wrapping in an Action) — [Adobe Help: Install and run scripts in Illustrator](https://helpx.adobe.com/illustrator/desktop/automate-visualize-data/automate-actions/install-and-run-scripts.html); the shortcut-requires-an-Action constraint is discussed in [Adobe Community: setting a shortcut for Illustrator scripts without the need of an action](https://community.adobe.com/t5/illustrator-discussions/v28-7-9-macos-setting-a-shortcut-for-illistrator-scripts-without-the-need-of-an-action/td-p/15566841)

### Inferences
- **Timeouts:** no documented hard execution timeout was found for either app. The practical limit is the OS/app "application not responding" behaviour and user patience. Do not promise "scripts time out safely" — they do not; a runaway loop requires force-quitting the host.
- **Modal dialogs block absolutely.** Any command that raises a modal (Recolor Artwork, Image Trace panel interactions, export dialogs) halts the script until dismissed. AE offers `app.beginSuppressDialogs()`/`endSuppressDialogs()` to suppress *AE's own* dialogs (commonly used around render automation); Illustrator's equivalent is per-API `SaveOptions`/`ExportOptions` objects that avoid raising the dialog in the first place. **`beginSuppressDialogs` was not directly cited in this research** — verify against the scripting reference before asserting.
- **Scripts during render:** in AE, no — the app is unavailable during a synchronous render. The supported concurrent patterns are `aerender` as a separate process, `queueInAME()`, or the undocumented `renderAsync()`. An MCP server should treat "render in progress" as a hard busy state and queue requests.
- **Undo:** AE gives scripts explicit control via `app.beginUndoGroup(name)` / `app.endUndoGroup()`, which collapses a whole script's changes into one undo step — this is standard practice in every published AE script. Illustrator has **no undo-grouping API**: each DOM mutation lands on the undo stack individually, so a 200-object script leaves a long undo trail the user must step through. This is a real product-quality difference between the two hosts. **Both claims are inference from general practice; neither was directly cited in this pass** — see Gaps.
- **UI freezing:** yes in both, by default. AE has the documented `scheduleTask` escape; Illustrator has none, so long Illustrator jobs should be chunked by the *caller* (e.g. an MCP server issuing many small `.jsx` executions rather than one long one), which also improves cancellability and error isolation.

### Gaps
- No primary-source confirmation of `app.beginUndoGroup`/`endUndoGroup` (AE) or of Illustrator's lack of undo grouping was obtained within the tool budget, though both are well-established in practice. Verify at `ae-scripting.docsforadobe.dev` (Application object) before publishing.
- No primary-source confirmation of `app.beginSuppressDialogs` (AE).
- No documentation found on whether Illustrator imposes any script execution time limit.
- Whether `renderAsync()` is safe/stable across AE versions is unknown; it is undocumented and reported only in forum posts.
