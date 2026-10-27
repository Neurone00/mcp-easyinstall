
// ===========================================================================
// Moskito Easy MCP — InDesign: run model-supplied code against InDesign's DOM
// ===========================================================================
//
// Appended to engine/uxp/id/commands/index.js by build.sh (from a pristine
// copy, every build). Upstream's only command is createDocument; this is the
// same route Premiere got in panel-addon-pr.js.

const __moskitoAsync = Object.getPrototypeOf(async function () {}).constructor;

commandHandlers.executeScript = async function executeScript(command) {
    const src = String((command.options && command.options.script) || "");
    try {
        const id = require("indesign");
        const run = new __moskitoAsync("app", "indesign", "uxp", src);
        const value = await run(id.app, id, require("uxp"));
        return { result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (e) {
        return { error: e && e.name && e.message ? `${e.name}: ${e.message}` : String(e) };
    }
};

// Upstream bugs, fixed here because main.js took these off module.exports
// after this file finished running.
//
// Every reply carries the active document's settings, and building them threw
// for any print document (getUnitForIntent knows only web) or with no document
// open, turning every successful command into a FAILURE. Optional, so: null.
const __settings = module.exports.getActiveDocumentSettings;
module.exports.getActiveDocumentSettings = () => {
    try { return __settings(); } catch { return null; }
};
// Called requiresActiveProject, which doesn't exist: an unhandled rejection on
// every command. The commands report a missing document themselves.
module.exports.checkRequiresActiveDocument = async () => {};
