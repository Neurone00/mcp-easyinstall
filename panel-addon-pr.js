
// ===========================================================================
// Moskito Easy MCP — Premiere: run model-supplied code against Premiere's API
// ===========================================================================
//
// Appended to engine/uxp/pr/commands/core.js by build.sh (from a pristine
// copy, every build). The upstream plugin only routes named actions, and those
// cannot cut, colour, keyframe or apply most effects, so a model asked to do
// any of that had nothing to call and fell back to computer use, taking over
// the user's Mac. After Effects never had that problem: it can run any script.
//
// Checked on Premiere 2026 (26.5.2) in the plugin's own debug console before
// this was written: UXP here allows new Function, and the code reaches
// require("premierepro") with the open project.
//
// Mutating the exported handler table registers it: module.exports holds the
// same object, and parseAndRouteCommand looks actions up in it at call time.

const __moskitoAsync = Object.getPrototypeOf(async function () {}).constructor;

commandHandlers.executeScript = async function executeScript(command) {
    const src = String((command.options && command.options.script) || "");
    try {
        const run = new __moskitoAsync("ppro", "uxp", src);
        const value = await run(require("premierepro"), require("uxp"));
        // Plain data only. Premiere objects don't survive the socket, and a
        // circular one would throw here — reported as the script's error
        // rather than as a dead reply.
        return { result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (e) {
        // Returned, not thrown: the server turns this into a real failure for
        // the model, and the hub counts it, without the panel's generic
        // FAILURE path swallowing the message.
        // "TypeError: …", like ExtendScript's e.toString(), so the failure
        // figures can tell kinds apart. e.message alone drops the type.
        return { error: e && e.name && e.message ? `${e.name}: ${e.message}` : String(e) };
    }
};
