#!/usr/bin/env node
/*
 * Adobe MCP Hub — control panel + command proxy in one process.
 *
 * Serves the dashboard on http://localhost:3001 AND acts as the socket.io
 * command proxy the Adobe panels connect to. Running this replaces
 * `node adb-proxy-socket/proxy.js` — don't run both, they share port 3001.
 *
 * Proxy logic adapted from adb-mcp by Mike Chambers (MIT).
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const PORT = 3001;
const HOME = os.homedir();
const REPO = "Neurone00/mcp-easyinstall";
const SUPPORT = path.join(HOME, "Library", "Application Support", "AdobeMCP");
const VENV = path.join(SUPPORT, "venv");
const VERSION = require("./package.json").version;
const HERE = __dirname;
const SETTINGS = path.join(HERE, "settings.json");

/* ---------------------------------------------------------------- engine -- */

// Where the adb-mcp checkout lives. Remembered in settings.json once found.
function findEngine() {
    // Our own settings file — a malformed one should not stop the app booting.
    let saved;
    try {
        saved = readJSON(SETTINGS, {}).enginePath;
    } catch { saved = undefined; }
    const candidates = [
        saved,
        path.join(HERE, "engine"),
        path.join(HERE, "..", "adb-mcp-main"),
        path.join(HERE, "..", "adb-mcp"),
        path.join(HOME, "Downloads", "claude_premiere_mcp", "adb-mcp-main"),
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, "mcp", "core.py"))) return path.resolve(c);
    }
    return null;
}

// uv runs the Python MCP servers. Installed by setup, or already on PATH.
function findUv() {
    const candidates = [
        path.join(HERE, "runtime", "uv"),          // bundled inside the .app
        path.join(HOME, ".local", "bin", "uv"),
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    try {
        return execFileSync("/usr/bin/which", ["uv"], { encoding: "utf8" }).trim() || null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ apps -- */

const CEP_DIR = path.join(HOME, "Library", "Application Support", "Adobe", "CEP", "extensions");

const APPS = {
    photoshop: {
        label: "Photoshop",
        kind: "uxp", uxp: "ps", mcp: "ps-mcp.py",
        appGlob: "Adobe Photoshop",
        panelMenu: "Plugins → Moskito Easy MCP",
    },
    illustrator: {
        label: "Illustrator",
        kind: "cep", cep: "com.mikechambers.ai", mcp: "ai-mcp.py",
        appGlob: "Adobe Illustrator",
        panelMenu: "Window → Extensions → Moskito Easy MCP",
    },
    aftereffects: {
        label: "After Effects",
        kind: "cep", cep: "com.mikechambers.ae", mcp: "ae-mcp.py",
        appGlob: "Adobe After Effects",
        panelMenu: "Window → Extensions → Moskito Easy MCP",
    },
    premiere: {
        label: "Premiere Pro",
        kind: "uxp", uxp: "pr", mcp: "pr-mcp.py",
        appGlob: "Adobe Premiere Pro",
        panelMenu: "Window → Moskito Easy MCP",
    },
    // InDesign is deliberately absent. Its server exposes exactly one tool,
    // create_document, and no scripting escape hatch — it can make an empty
    // document and nothing else. Listing it promised a capability that does
    // not exist, and cost the user the UXP Developer Tool dance for no payoff.
};

// Adobe installs each app inside its own folder — /Applications/Adobe Illustrator
// 2026/Adobe Illustrator.app — so the folder itself is not launchable. Uninstalls
// also leave empty "Adobe After Effects 2025" folders behind, and some folders
// hold extra apps (After Effects' Render Engine). Walk newest-first and return
// the first folder that actually contains the app.
function appBundle(glob) {
    let dirs;
    try {
        dirs = fs.readdirSync("/Applications").filter((n) => n.startsWith(glob)).sort().reverse();
    } catch {
        return null;
    }
    for (const dir of dirs) {
        const full = path.join("/Applications", dir);
        if (full.endsWith(".app")) return full;
        let inner;
        try {
            inner = fs.readdirSync(full)
                .filter((n) => n.endsWith(".app") && !/Render Engine|Distiller/.test(n))
                .sort((a, b) => a.length - b.length)[0];
        } catch { continue; }
        if (inner) return path.join(full, inner);
    }
    return null;
}

// Apps do not appear and disappear while the panel is open.
const appInstalled = memo((glob) => !!appBundle(glob), 30000);

function panelInstalled(key) {
    const a = APPS[key];
    if (a.kind === "cep") return fs.existsSync(path.join(CEP_DIR, a.cep));
    // UXP plugins are loaded through Adobe's UXP Developer Tool, which keeps no
    // predictable on-disk marker. A live socket connection is the real signal.
    return null;
}

/* ----------------------------------------------------- window arranging -- */

// Put the Adobe app on most of the screen and the assistant beside it, so you
// can type a request and watch it happen without hunting for windows.
//
// Moving another app's windows needs macOS Accessibility permission, and macOS
// grants that to whichever process asks. The osascript version this replaces
// therefore asked on behalf of `osascript`, not Moskito Easy MCP: the grant
// attached to the wrong thing, or never appeared, and the call did nothing,
// silently. The menu bar binary carries the app's own signed identity, so it
// does the work. We leave it a note and read the answer back.
const ARRANGE_REQ = path.join(SUPPORT, "arrange-request");
const ARRANGE_RES = path.join(SUPPORT, "arrange-result");
const FOCUS_REQ = path.join(SUPPORT, "focus-request");

// `open -a` reopens an already-running app without bringing it forward when the
// caller is a background process: measured, the frontmost app did not change.
// The menu bar binary can do it, for the same reason it can arrange windows.
function focusApp(bundle) {
    if (!bundle) return;
    try {
        fs.mkdirSync(SUPPORT, { recursive: true });
        fs.writeFileSync(FOCUS_REQ, [Date.now(), bundle].join("\n"));
    } catch (e) {
        console.log("\u26a0 couldn't ask for focus: " + e.message);
    }
}

async function arrangeWindows(appKey, split) {
    const bundle = appBundle(APPS[appKey].appGlob);
    if (!bundle) throw new Error(`${APPS[appKey].label} isn't installed.`);

    fs.mkdirSync(SUPPORT, { recursive: true });
    try { fs.unlinkSync(ARRANGE_RES); } catch { /* no previous answer to clear */ }
    // Both assistants go in the same column, so there is nothing to choose
    // between: whichever you bring forward fills it.
    const assistants = ["Claude", "ChatGPT"]
        .map((n) => path.join("/Applications", n + ".app"))
        .filter((f) => fs.existsSync(f));
    // The timestamp is what makes a repeat request differ from the last one.
    fs.writeFileSync(ARRANGE_REQ, [Date.now(), split, bundle, ...assistants].join("\n"));

    // The watcher ticks twice a second; give it a few ticks before giving up.
    for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 150));
        let answer;
        try { answer = fs.readFileSync(ARRANGE_RES, "utf8").trim(); } catch { continue; }
        if (answer === "needs-permission") {
            const e = new Error(
                "macOS needs your permission before Moskito Easy MCP can move other apps' " +
                "windows. Allow it under Privacy & Security → Accessibility, then press " +
                "Arrange again."
            );
            e.needsAccessibility = true;
            throw e;
        }
        if (answer.startsWith("ok")) {
            return { ok: true, layout: `${Math.round(split * 100)}/${100 - Math.round(split * 100)}` };
        }
        throw new Error(`Couldn't arrange the windows — ${answer}.`);
    }
    throw new Error("Moskito Easy MCP didn't answer. Try Restart Background Service from its menu.");
}

/* ------------------------------------------------------------- caching -- */

// /api/status is polled every two seconds by every open tab, and it was doing
// all of this synchronously on each call: pgrep, up to three `defaults` reads,
// five scans of /Applications, and a parse of ~/.claude.json, which is often
// several megabytes. All of that blocks the event loop, so an Adobe command
// arriving mid-poll waited behind it. None of these change second to second.
// Cached per argument — a single shared slot would have made all five apps
// share whichever answer was computed first.
function memo(fn, ms) {
    const cache = new Map();
    return (...args) => {
        const key = args.length ? JSON.stringify(args) : "";
        const hit = cache.get(key);
        const now = Date.now();
        if (hit && now - hit.at <= ms) return hit.value;
        const value = fn(...args);
        cache.set(key, { value, at: now });
        return value;
    };
}

/* --------------------------------------------------- panels: open vs live -- */

// A panel can be open in the Adobe app and still not connected to us, and the
// control panel could not tell that apart from "not open" — both showed the
// same unhelpful message. It cost us three debugging detours in one day, and
// it will cost a colleague more.
//
// CEP exposes each panel on a local DevTools port (declared in the panel's
// .debug file, which our build points at the right extension id). If a port
// answers, the panel is open — and we can click its Connect button for the
// user through the same channel.

function cepDebugPort(key) {
    const engine = findEngine();
    const a = APPS[key];
    if (!engine || a.kind !== "cep") return null;
    try {
        const xml = fs.readFileSync(path.join(engine, "cep", a.cep, ".debug"), "utf8");
        const m = xml.match(/Port="(\d+)"/);
        return m ? parseInt(m[1], 10) : null;
    } catch {
        return null;
    }
}

// Refreshed in the background: /api/status is polled every 2s and is already
// doing too much synchronous work to add network probes to it.
const panelOpen = {};

async function cdpTarget(key) {
    const port = cepDebugPort(key);
    if (!port) return null;
    try {
        const r = await fetch(`http://127.0.0.1:${port}/json`, {
            signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) return null;
        const targets = await r.json();
        return targets.find((t) => t.webSocketDebuggerUrl) || null;
    } catch {
        return null;   // nothing listening: the panel is not open
    }
}

async function refreshPanelOpen() {
    for (const key of Object.keys(APPS)) {
        if (APPS[key].kind !== "cep") continue;
        if (applicationClients[key]) { panelOpen[key] = true; continue; }  // already talking to us
        panelOpen[key] = !!(await cdpTarget(key));
    }
}

// Click the panel's own Connect button, and tick "connect automatically" so it
// does not need doing twice.
async function connectPanel(key) {
    const target = await cdpTarget(key);
    if (!target) {
        throw new Error(
            `The ${APPS[key].label} panel isn't open. In ${APPS[key].label}: ${APPS[key].panelMenu}.`
        );
    }
    const WebSocket = require("ws");
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    const expression = `(function(){
        var btn = document.getElementById("btnConnect");
        var status = document.getElementById("statusText");
        var before = status ? status.textContent : "?";
        if (btn && before !== "Connected") { btn.click(); }
        var chk = document.getElementById("chkConnectOnLaunch");
        if (chk && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event("change")); }
        return before;
    })()`;

    return new Promise((resolve, reject) => {
        const done = setTimeout(() => { ws.close(); reject(new Error("The panel did not respond.")); }, 8000);
        ws.on("open", () => ws.send(JSON.stringify({
            id: 1, method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
        })));
        ws.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.id !== 1) return;
            clearTimeout(done);
            ws.close();
            const err = msg.result && msg.result.exceptionDetails;
            if (err) return reject(new Error("The panel refused: " + (err.text || "unknown")));
            resolve({ ok: true, was: msg.result && msg.result.result && msg.result.result.value });
        });
        ws.on("error", (e) => { clearTimeout(done); reject(new Error("Couldn't reach the panel: " + e.message)); });
    });
}

/* --------------------------------------------------------------- icons -- */

// Use each Adobe app's own icon rather than a hand-drawn "Ai" square. They are
// in the app bundle; sips turns the .icns into a PNG. Cached, because this
// shells out and /api/status is polled constantly.
const ICON_DIR = path.join(SUPPORT, "icons");

// Any .app, not just the Adobe ones: the panel puts Claude's and ChatGPT's own
// icons on its two Ask buttons.
function iconFor(name, bundle) {
    const dest = path.join(ICON_DIR, `${name}.png`);
    if (fs.existsSync(dest)) return dest;
    if (!bundle || !fs.existsSync(bundle)) return null;
    try {
        let name = execFileSync("/usr/libexec/PlistBuddy",
            ["-c", "Print CFBundleIconFile", path.join(bundle, "Contents", "Info.plist")],
            { encoding: "utf8" }).trim();
        if (!name) return null;
        if (!name.endsWith(".icns")) name += ".icns";
        const icns = path.join(bundle, "Contents", "Resources", name);
        if (!fs.existsSync(icns)) return null;
        fs.mkdirSync(ICON_DIR, { recursive: true });
        execFileSync("/usr/bin/sips", ["-s", "format", "png", icns, "--out", dest, "-Z", "128"],
            { stdio: "ignore", timeout: 20000 });
        return fs.existsSync(dest) ? dest : null;
    } catch {
        return null;
    }
}

function appIconPath(key) {
    return APPS[key] ? iconFor(key, appBundle(APPS[key].appGlob)) : null;
}

// The two assistants, by the name of their bundle in /Applications.
const ASSISTANT_ICONS = { claude: "Claude", chatgpt: "ChatGPT" };

/* ------------------------------------------------------------ json helper -- */

// Missing file -> fallback. Unreadable or malformed file -> throw, never the
// fallback: callers merge into this and write it back, so returning {} for a
// config we simply failed to parse would replace the whole thing.
function readJSON(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch (e) {
        throw new Error(`Can't read ${path.basename(file)}: ${e.message}`);
    }
    if (raw.trim() === "") return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(
            `${path.basename(file)} isn't valid JSON, so it wasn't touched. ` +
            `Fix or remove it, then try again. (${e.message})`
        );
    }
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
        // Timestamped: a single backup slot gets clobbered by the next write,
        // and repairClientPaths runs every 30s.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(file, `${file}.adobe-mcp-backup-${stamp}`);
        pruneBackups(file);
    }
    // Write-then-rename, so an interrupted write can't truncate the real file.
    const tmp = `${file}.adobe-mcp-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

// Keep the five most recent backups of a file; drop the rest.
function pruneBackups(file) {
    const dir = path.dirname(file);
    const prefix = path.basename(file) + ".adobe-mcp-backup-";
    try {
        fs.readdirSync(dir)
            .filter((n) => n.startsWith(prefix))
            .sort()
            .slice(0, -5)
            .forEach((n) => fs.rmSync(path.join(dir, n), { force: true }));
    } catch { /* best effort */ }
}

/* --------------------------------------------------------- mcp server defs -- */

// The command an AI client runs to start one app's MCP server.
function serverDef(key) {
    const engine = findEngine();
    if (!engine) return null;
    // Deliberately NOT `uv run`. Codex and the ChatGPT desktop app sandbox MCP
    // servers with writes confined to the workspace, so uv could not build its
    // virtualenv and every call died as "user cancelled MCP tool call". The venv
    // is built once by the hub, which is not sandboxed; clients only read it.
    return {
        command: path.join(VENV, "bin", "mcp"),
        args: ["run", path.join(engine, "mcp", APPS[key].mcp)],
        // Python writes __pycache__ next to the script, i.e. inside the .app.
        // A sandboxed client can't do that, and the server dies before it can
        // answer. Nothing here needs the bytecode cache.
        env: { PYTHONDONTWRITEBYTECODE: "1" },
    };
}

// Which apps are worth registering: the Adobe app is actually on this machine.
function registerableApps() {
    return Object.keys(APPS).filter((k) => appInstalled(APPS[k].appGlob));
}

/* ------------------------------------------------------------- ai clients -- */

const CLIENTS = {
    "claude-desktop": {
        label: "Claude Desktop",
        blurb: "The Claude app. Needs a restart after connecting.",
        file: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        format: "json",
        key: "mcpServers",
    },
    "claude-code": {
        label: "Claude Code",
        blurb: "Claude in the terminal and in the desktop app's Code tab.",
        file: path.join(HOME, ".claude.json"),
        format: "json",
        key: "mcpServers",
    },
    codex: {
        label: "ChatGPT",
        blurb: "Desktop app, Codex CLI and the IDE extension \u2014 they share one config file.",
        file: path.join(HOME, ".codex", "config.toml"),
        format: "toml",
        key: "mcp_servers",
    },
};

// Read-only, and called from /api/status every couple of seconds — a config we
// can't parse must not take the whole status endpoint down. connectClient is the
// one that has to be strict, because it writes.
function connectedApps(clientId) {
    const c = CLIENTS[clientId];
    if (!fs.existsSync(c.file)) return [];
    try {
        if (c.format === "json") {
            const servers = readJSON(c.file, {})[c.key] || {};
            return Object.keys(APPS).filter((k) => servers[k]);
        }
        const toml = fs.readFileSync(c.file, "utf8");
        return Object.keys(APPS).filter((k) => toml.includes(`[${c.key}.${k}]`));
    } catch {
        return [];
    }
}

function connectClient(clientId, keys) {
    const c = CLIENTS[clientId];
    if (c.format === "json") {
        const cfg = readJSON(c.file, {});
        cfg[c.key] = cfg[c.key] || {};
        for (const k of keys) cfg[c.key][k] = serverDef(k);
        writeJSON(c.file, cfg);
        return;
    }

    // TOML is edited one table at a time, not as a marker-delimited block.
    // The block approach broke twice: retiring the last table inside it
    // swallowed the closing marker, and — worse — Codex writes its own tables
    // such as [mcp_servers.aftereffects.tools.execute_extend_script] in among
    // ours, which a block rewrite would have deleted along with the user's
    // settings. Removing exactly our own table headers leaves everything else,
    // including child tables, untouched.
    const lines = fs.existsSync(c.file) ? fs.readFileSync(c.file, "utf8").split("\n") : [];
    const ours = new Set(Object.keys(APPS).map((k) => `[${c.key}.${k}]`));

    const keep = [];
    let dropping = false;
    for (const line of lines) {
        const t = line.trim();
        if (/^\[/.test(t)) dropping = ours.has(t);
        // Retire the old markers wherever they still are.
        if (t === "# >>> adobe-mcp >>>" || t === "# <<< adobe-mcp <<<") continue;
        // Must match the comment this function WRITES, or it accumulates one
        // copy per repair pass — and repair runs every 30 seconds.
        if (t.startsWith("# Managed by Adobe MCP") || t.startsWith("# Managed by Moskito") ||
            t.startsWith("# Written by Moskito")) continue;
        if (!dropping) keep.push(line);
    }

    const body = keys.map((k) => {
        const d = serverDef(k);
        const env = Object.entries(d.env || {})
            .map(([ek, ev]) => `${ek} = ${JSON.stringify(ev)}`).join(", ");
        return `[${c.key}.${k}]\n` +
               `command = ${JSON.stringify(d.command)}\n` +
               `args = [${d.args.map((a) => JSON.stringify(a)).join(", ")}]` +
               (env ? `\nenv = { ${env} }` : "");
    }).join("\n\n");

    // Collapse the gaps left where our old tables were, or the file grows by a
    // blank line on every repair pass — which runs every 30 seconds.
    const text = keep.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() +
        "\n\n# Written by Moskito Easy MCP. These tables are rewritten when the app moves.\n" +
        body + "\n";
    writeTomlChecked(c.file, text.trimStart(), c.key);
}

function tomlLooksSane(text, sectionKey) {
    const headers = (text.match(/^\s*\[[^\]]+\]/gm) || []).map((h) => h.trim());
    if (new Set(headers).size !== headers.length) return "a table is declared twice";
    return null;
}

// Write TOML, then read it back and undo the write if it looks broken. Both
// times this file was corrupted in testing, a check this simple would have
// caught it before the user's Codex ever saw it.
function writeTomlChecked(file, text, sectionKey) {
    const problem = tomlLooksSane(text, sectionKey);
    if (problem) throw new Error(`Refusing to write ${path.basename(file)}: ${problem}.`);
    let backup = null;
    if (fs.existsSync(file)) {
        backup = `${file}.adobe-mcp-backup-${Date.now()}`;
        fs.copyFileSync(file, backup);
        pruneBackups(file);
    }
    const tmp = `${file}.adobe-mcp-tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);

    const after = tomlLooksSane(fs.readFileSync(file, "utf8"), sectionKey);
    if (after && backup) {
        fs.copyFileSync(backup, file);
        throw new Error(`${path.basename(file)} came out malformed (${after}) — put the previous version back.`);
    }
}

function disconnectClient(clientId) {
    const c = CLIENTS[clientId];
    if (!fs.existsSync(c.file)) return;
    if (c.format === "json") {
        const cfg = readJSON(c.file, {});
        if (cfg[c.key]) for (const k of Object.keys(APPS)) delete cfg[c.key][k];
        writeJSON(c.file, cfg);
        return;
    }
    const lines = fs.readFileSync(c.file, "utf8").split("\n");
    const ours = new Set(Object.keys(APPS).map((k) => `[${c.key}.${k}]`));
    const keep = [];
    let dropping = false;
    for (const line of lines) {
        const t = line.trim();
        if (/^\[/.test(t)) dropping = ours.has(t);
        if (t === "# >>> adobe-mcp >>>" || t === "# <<< adobe-mcp <<<") continue;
        if (t.startsWith("# Written by Moskito") || t.startsWith("# Managed by Adobe MCP")) continue;
        if (!dropping) keep.push(line);
    }
    writeTomlChecked(c.file, keep.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", c.key);
}

// Claude Desktop keeps its config in memory and writes the whole file back when
// it quits, silently undoing anything we wrote while it was open. So the write
// has to happen while it is closed. Cached: /api/status asks every two seconds.
const claudeRunning = memo(() => {
    try {
        execFileSync("/usr/bin/pgrep", ["-x", "Claude"], { stdio: ["ignore", "pipe", "ignore"] });
        return true;
    } catch {
        return false;
    }
}, 3000);

/* ------------------------------------------------------- panel installing -- */

function installPanel(key) {
    const a = APPS[key];
    const engine = findEngine();
    if (!engine) throw new Error("Can't find the adb-mcp engine folder.");
    if (a.kind !== "cep") throw new Error("uxp");

    const src = path.join(engine, "cep", a.cep);
    if (!fs.existsSync(src)) throw new Error(`Panel source missing: ${src}`);
    fs.mkdirSync(CEP_DIR, { recursive: true });
    const dest = path.join(CEP_DIR, a.cep);
    fs.cpSync(src, dest, { recursive: true, force: true });

    // A CEP panel can only load files sitting next to it, so the icons it shows
    // — the host app's, and the two assistants' — are copied in beside it.
    const icon = appIconPath(key);
    if (icon) fs.copyFileSync(icon, path.join(dest, "appicon.png"));
    for (const [name, app] of Object.entries(ASSISTANT_ICONS)) {
        const f = iconFor(name, path.join("/Applications", app + ".app"));
        if (f) fs.copyFileSync(f, path.join(dest, name + ".png"));
    }

    // Adobe refuses to load unsigned panels unless debug mode is on.
    for (const v of ["10", "11", "12", "13"]) {
        try {
            execFileSync("/usr/bin/defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
        } catch { /* version not present on this machine */ }
    }
}

const debugModeOn = memo(() => {
    return ["11", "12", "13"].some((v) => {
        try {
            return execFileSync("/usr/bin/defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim() === "1";
        } catch {
            return false;
        }
    });
}, 30000)

// First `uv run` downloads Python and the PyPI deps. Do it now, in the
// background, so the first thing the user asks Claude doesn't time out.
// Pinned deliberately.
//   [cli]  pulls typer, which `mcp run` needs; plain "mcp" leaves a fresh
//          environment unable to start a server at all.
//   <2     the engine is MCP v1 code. mcp 2.x renamed FastMCP to MCPServer,
//          so an unpinned install now fails on `from mcp.server.fastmcp
//          import FastMCP` — which broke every new install the day 2.0
//          shipped, while existing venvs carried on working.
// numpy is ps-mcp.py's alone, and was missing: the Photoshop server could
// never import, so it has never started for anyone. Found by probing each
// server's initialize response rather than by anyone reporting it, because
// Photoshop also needs the UXP step, so nobody had got that far.
const PY_DEPS = ["fonttools", "python-socketio", "mcp[cli]<2", "requests",
                 "websocket-client", "pillow", "numpy"];
let venvReady = false;        // proven by venvWorks(), never assumed
let venvBuilding = false;
let venvError = null;
const venvWaiters = [];       // callbacks parked while a build is in flight
// `mcp` existing is not proof the environment works: a half-finished
// `uv pip install` leaves the binary behind, and latching on existsSync alone
// meant a broken venv was treated as ready forever, with no way to retry.
function venvWorks() {
    const py = path.join(VENV, "bin", "python");
    if (!fs.existsSync(py) || !fs.existsSync(path.join(VENV, "bin", "mcp"))) return false;
    try {
        execFileSync(py, ["-c", "import mcp, socketio, requests, PIL, fontTools, websocket, numpy"],
            { timeout: 30000, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function ensureVenv(done = () => {}) {
    if (venvReady) return done();
    if (venvBuilding) return venvWaiters.push(done);
    // Already built by a previous run — don't rebuild it every launch.
    if (venvWorks()) {
        venvReady = true;
        venvError = null;
        return done();
    }

    const uv = findUv();
    if (!uv) {
        venvError = "The bundled uv runtime is missing \u2014 reinstall Adobe MCP.";
        return done(new Error(venvError));
    }

    venvBuilding = true;
    venvError = null;
    console.log("Building the Python environment (first run only, needs the internet)\u2026");

    const finish = (err) => {
        venvBuilding = false;
        venvReady = !err && venvWorks();
        if (!venvReady && !err) err = new Error("The Python environment did not come out working.");
        venvError = err ? err.message : null;
        console.log(venvReady ? "\u2713 Python environment ready" : "\u26a0 " + venvError);
        const waiters = venvWaiters.splice(0);
        done(venvReady ? null : err);
        waiters.forEach((w) => w(venvReady ? null : err));
    };

    // uv's failures are many lines of command echo. Show the one line that says
    // what went wrong; the whole thing goes to the log.
    const why = (e) => {
        console.log(e.message);
        const line = String(e.message)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^(error|cause):/i.test(l))
            .pop();
        return line ? line.replace(/^(error|cause):\s*/i, "") : "see the log for details";
    };

    // --allow-existing: without it `uv venv` refuses outright when the folder
    // is already there, so an environment that exists but is missing a package
    // could never be repaired — every launch failed with "a virtual
    // environment already exists" and venvReady stayed false forever. That is
    // the state every user upgrading to a build with a new dependency would
    // have landed in.
    execFile(uv, ["venv", "--allow-existing", VENV], { timeout: 300000 }, (e1) => {
        if (e1) return finish(new Error("Couldn't create the Python environment — " + why(e1)));
        execFile(uv, ["pip", "install", "--python", path.join(VENV, "bin", "python"), ...PY_DEPS],
            { timeout: 600000 }, (e2) => {
                finish(e2
                    ? new Error("Couldn't download the Python packages — " + why(e2) +
                                ". Check your internet connection.")
                    : null);
            });
    });
}

// An installed CEP panel is a copy, so an app update would leave a stale one
// behind. Re-copying at launch is cheap (a few hundred KB) and idempotent, so a
// panel can never drift from the app that drives it.
function refreshPanels() {
    for (const [key, a] of Object.entries(APPS)) {
        if (a.kind !== "cep" || !panelInstalled(key)) continue;
        try {
            installPanel(key);
        } catch (e) {
            console.log(`\u26a0 could not refresh the ${a.label} panel: ${e.message}`);
        }
    }
}

// Every client config records the absolute path of the bundled `uv` and engine.
// Moving the app (say, from Downloads to Applications) silently breaks all of
// them, so re-point anything that has drifted.
// Apps we used to ship. Their entries linger in config files pointing at a
// server we no longer maintain, so they are removed rather than left to rot.
const RETIRED = ["indesign"];

function removeRetired(id) {
    const c = CLIENTS[id];
    if (!fs.existsSync(c.file)) return false;
    try {
        if (c.format === "json") {
            const cfg = readJSON(c.file, {});
            const servers = cfg[c.key];
            if (!servers) return false;
            const gone = RETIRED.filter((k) => servers[k]);
            if (!gone.length) return false;
            gone.forEach((k) => delete servers[k]);
            writeJSON(c.file, cfg);
            return true;
        }

        // Line-based, NOT a regex. A first attempt used [^\[]* to run to the
        // next table header, which stops dead on the "[" inside args = [...]
        // and left a fragment behind that Codex could not parse. A TOML table
        // ends at the next line starting with "[", full stop.
        const lines = fs.readFileSync(c.file, "utf8").split("\n");
        const headers = RETIRED.map((k) => `[${c.key}.${k}]`);
        const keep = [];
        let dropping = false;
        for (const line of lines) {
            const t = line.trim();
            // A dropped table ends at the next table header — OR at our own
            // closing marker. Without that second condition, retiring the LAST
            // table in the managed block swallowed the marker with it, so the
            // next write could not find the block, appended a second one, and
            // left duplicate tables that Codex refused to parse.
            if (/^\[/.test(t)) dropping = headers.includes(t);
            else if (t.startsWith("# <<<") || t.startsWith("# >>>")) dropping = false;
            if (!dropping) keep.push(line);
        }
        if (keep.length === lines.length) return false;
        writeTomlChecked(c.file, keep.join("\n"), c.key);
        return true;
    } catch (e) {
        console.log(`⚠ could not tidy ${c.label}: ${e.message}`);
        return false;
    }
}

function repairClientPaths() {
    const want = serverDef(Object.keys(APPS)[0]);
    if (!want) return;
    for (const id of Object.keys(CLIENTS)) {
        // Claude Desktop would overwrite us while it is open — leave it alone.
        if (id === "claude-desktop" && claudeRunning()) continue;
        if (removeRetired(id)) console.log(`✓ removed retired servers from ${CLIENTS[id].label}`);
        const connected = connectedApps(id);
        if (!connected.length) continue;
        // This runs on a 30s timer: anything thrown here is an uncaught
        // exception that kills the hub, so the read is inside the try too.
        let stale = false;
        try {
            // The engine path lives in ARGS, not command — the venv binary sits
            // outside the bundle and never moves. Comparing only the command
            // meant renaming or moving the app left every server pointing at a
            // folder that no longer existed, silently.
            const engineArg = want.args[want.args.length - 1];
            if (CLIENTS[id].format === "json") {
                const servers = readJSON(CLIENTS[id].file, {})[CLIENTS[id].key] || {};
                stale = connected.some((k) => {
                    const def = servers[k];
                    if (!def) return false;
                    if (def.command !== want.command) return true;
                    if (!(def.env || {}).PYTHONDONTWRITEBYTECODE) return true;
                    const last = (def.args || [])[(def.args || []).length - 1] || "";
                    return path.dirname(last) !== path.dirname(engineArg);
                });
            } else {
                const toml = fs.readFileSync(CLIENTS[id].file, "utf8");
                stale = !toml.includes(want.command)
                    || !toml.includes("PYTHONDONTWRITEBYTECODE")
                    || !toml.includes(path.dirname(engineArg));
            }
        } catch (e) {
            console.log(`⚠ could not check ${CLIENTS[id].label}: ${e.message}`);
            continue;
        }
        if (!stale) continue;
        try {
            connectClient(id, connected);
            console.log(`\u2713 repaired ${CLIENTS[id].label} \u2014 the app had moved`);
        } catch (e) {
            console.log(`\u26a0 could not repair ${CLIENTS[id].label}: ${e.message}`);
        }
    }
}

// Codex (and the ChatGPT desktop app's Codex host) runs MCP servers in a
// workspace-write sandbox with networking off, so the Adobe servers cannot reach
// the hub on localhost:3001. Every tool call fails as "cancelled" until this is
// switched on. It widens their sandbox, so it is never done automatically.
const CODEX_TOML = process.env.ADOBE_MCP_CODEX_TOML || CLIENTS.codex.file;

// Line-based on purpose: splitting TOML with regexes lost the newline after the
// section header and produced a file Codex could not parse.
function codexTomlLines() {
    return fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, "utf8").split("\n") : [];
}

function sectionRange(lines) {
    const start = lines.findIndex((l) => l.trim() === "[sandbox_workspace_write]");
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    return { start, end };
}

function codexNetworkAllowed() {
    const lines = codexTomlLines();
    const r = sectionRange(lines);
    if (!r) return false;
    return lines.slice(r.start + 1, r.end).some((l) => /^\s*network_access\s*=\s*true/.test(l));
}

function allowCodexNetwork() {
    const lines = codexTomlLines();
    if (fs.existsSync(CODEX_TOML)) fs.copyFileSync(CODEX_TOML, CODEX_TOML + ".adobe-mcp-backup");

    const r = sectionRange(lines);
    if (!r) {
        lines.push(
            "",
            "# Added by Adobe MCP: lets local MCP servers reach the app on localhost.",
            "[sandbox_workspace_write]",
            "network_access = true",
            ""
        );
    } else {
        const i = lines.slice(r.start + 1, r.end)
            .findIndex((l) => /^\s*network_access\s*=/.test(l));
        if (i === -1) {
            // Insert before the blank lines that separate this section from the
            // next one, not after them.
            let at = r.end;
            while (at > r.start + 1 && lines[at - 1].trim() === "") at--;
            lines.splice(at, 0, "network_access = true");
        }
        else lines[r.start + 1 + i] = "network_access = true";
    }
    fs.mkdirSync(path.dirname(CODEX_TOML), { recursive: true });
    fs.writeFileSync(CODEX_TOML, lines.join("\n"));
}

/* ------------------------------------------------------------- updates -- */

// "1.2.0" > "1.10.0" is false — compare numerically, segment by segment.
function isNewer(a, b) {
    const pa = String(a).split("."), pb = String(b).split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
        if (x !== y) return x > y;
    }
    return false;
}

let update = null;        // {version, url, notes} once a newer release is seen
let updateChecked = 0;

async function checkForUpdate() {
    if (Date.now() - updateChecked < 6 * 3600 * 1000) return update;
    updateChecked = Date.now();
    try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return update;
        const d = await r.json();
        const latest = String(d.tag_name || "").replace(/^v/, "");
        // Taking the first .zip handed some Macs a build they cannot execute.
        // Prefer a universal asset, then one naming this machine's architecture.
        const zips = (d.assets || []).filter((a) => a.name.endsWith(".zip"));
        const mine = process.arch === "arm64" ? /arm64|aarch64/i : /x64|x86_64|intel/i;
        const asset = zips.find((a) => /universal/i.test(a.name)) ||
                      zips.find((a) => mine.test(a.name)) ||
                      // Only fall back to an unlabelled zip; never to one that
                      // explicitly names the other architecture.
                      zips.find((a) => !/arm64|aarch64|x64|x86_64|intel/i.test(a.name));
        update = (latest && asset && isNewer(latest, VERSION))
            ? { version: latest, url: asset.browser_download_url, notes: d.body || "" }
            : null;
    } catch {
        /* offline, rate-limited — just skip this round */
    }
    return update;
}

// The app can't overwrite itself while it is running, so hand the swap to a
// detached script that waits for this process to exit first.
async function applyUpdate() {
    if (!update) throw new Error("No update available.");
    const bundle = path.resolve(HERE, "..", "..");
    if (!bundle.endsWith(".app")) throw new Error("Updates only work on the installed app.");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adobe-mcp-"));
    const zip = path.join(tmp, "update.zip");
    const r = await fetch(update.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10 * 60 * 1000),   // a stalled download used to hang forever
    });
    if (!r.ok) throw new Error(`Download failed (${r.status}).`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));

    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, tmp]);
    const fresh = fs.readdirSync(tmp).find((n) => n.endsWith(".app"));
    if (!fresh) throw new Error("That download didn't contain an app.");

    // Check it before trusting it: an app for the wrong architecture is exactly
    // what the old first-zip-wins picker used to hand out.
    const freshBin = path.join(tmp, fresh, "Contents", "MacOS", "AdobeMCP");
    if (!fs.existsSync(freshBin)) throw new Error("That download isn't a working Adobe MCP app.");
    try {
        const archs = execFileSync("/usr/bin/lipo", ["-archs", freshBin], { encoding: "utf8" });
        if (!archs.includes(process.arch === "arm64" ? "arm64" : "x86_64")) {
            throw new Error(`That build is for ${archs.trim()}, which this Mac can't run.`);
        }
    } catch (e) {
        if (/can't run/.test(e.message)) throw e;   // our own check — surface it
        /* lipo unavailable: fall through rather than block the update */
    }

    // Move the old app aside rather than deleting it, and put it back if the
    // copy fails. The previous version removed it first, so a failed copy left
    // the user with no app at all and no message.
    const script = path.join(tmp, "swap.sh");
    const q = JSON.stringify;
    fs.writeFileSync(script, [
        "#!/bin/bash",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
        `OLD=${q(bundle + ".old")}`,
        `rm -rf "$OLD"`,
        `mv ${q(bundle)} "$OLD" || exit 1`,
        `if /usr/bin/ditto ${q(path.join(tmp, fresh))} ${q(bundle)}; then`,
        `  /usr/bin/xattr -cr ${q(bundle)}`,
        `  rm -rf "$OLD"`,
        `else`,
        `  rm -rf ${q(bundle)}`,
        `  mv "$OLD" ${q(bundle)}`,   // put the working version back
        `fi`,
        `/usr/bin/open ${q(bundle)}`,
        `rm -rf ${q(tmp)}`,
    ].join("\n"));
    fs.chmodSync(script, 0o755);
    execFile("/bin/bash", [script], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => process.exit(0), 300);
}

/* ------------------------------------------------------------- the proxy -- */

const app = express();
app.use(express.json());

// This server can rewrite the user's AI config files and drive their open Adobe
// documents, so it is for this machine and this page only.
//
// Bound to loopback below (see server.listen) — it used to bind every interface,
// which put all of that on the local Wi-Fi. Loopback alone is not enough though:
// any web page can still POST here, because our own requests are body-less with
// no Content-Type and so are "simple requests" that skip the CORS preflight. So
// reject a cross-origin Origin outright.
const ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
]);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    // No Origin at all is a same-origin navigation or curl, which is fine.
    if (!origin || ALLOWED_ORIGINS.has(origin)) return next();
    console.log(`⚠ refused a request from ${origin}`);
    res.status(403).json({ error: "Moskito Easy MCP only accepts requests from its own window." });
});

const server = http.createServer(app);
const io = new Server(server, {
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 50 * 1024 * 1024,
    // Browsers don't apply CORS to WebSocket handshakes, so without this a page
    // could register as "photoshop" and intercept commands meant for the panel.
    // The Adobe panels are CEP/UXP and send no Origin, so they are unaffected.
    // The socket carries Adobe commands, so it has to admit the panels as well
    // as our own page. CEP panels connect with Origin "file://"; some UXP hosts
    // send "null" or nothing. A remote web page cannot forge either of those —
    // it is always stuck with its own http(s) origin, which is what we refuse.
    // The dangerous endpoints (config rewrites) are on the HTTP side, which
    // stays strict.
    allowRequest: (req, done) => {
        const origin = req.headers.origin;
        const ok = !origin || origin === "null" || origin.startsWith("file://") ||
                   ALLOWED_ORIGINS.has(origin);
        if (!ok) console.log(`⚠ refused a socket from ${origin}`);
        done(null, ok);
    },
});

const applicationClients = {}; // app name -> Set of socket ids

io.on("connection", (socket) => {
    socket.on("register", ({ application }) => {
        // Unvalidated, this took the whole hub down: registering as
        // "__proto__" made ||= skip the assignment (Object.prototype is
        // truthy) and .add() then threw out of a socket handler. Any web page
        // could do it. Only the apps we know about are accepted.
        if (!Object.prototype.hasOwnProperty.call(APPS, application)) {
            console.log(`⚠ refused a panel claiming to be "${application}"`);
            return socket.emit("registration_response", {
                type: "registration", status: "error",
                message: `Unknown application "${application}".`,
            });
        }
        socket.data.application = application;
        if (!Object.prototype.hasOwnProperty.call(applicationClients, application)) {
            applicationClients[application] = new Set();
        }
        applicationClients[application].add(socket.id);
        socket.emit("registration_response", {
            type: "registration",
            status: "success",
            message: `Registered for ${application}`,
        });
        console.log(`✓ ${application} panel connected`);
    });

    // Which assistants can actually reach this app. The panel greys out the
    // button for one that can't. It asks over the socket rather than
    // /api/status because a CEP panel is a file:// origin, and opening the
    // HTTP API to that would open it to every web page too.
    socket.on("amcp_clients", () => {
        const key = socket.data.application;
        if (!key) return;
        socket.emit("amcp_clients", {
            claude: connectedApps("claude-desktop").includes(key),
            chatgpt: connectedApps("codex").includes(key) && codexNetworkAllowed(),
        });
    });

    // Requests from a panel, over the channel we already trust.
    socket.on("app_request", (req) => {
        const key = req && req.application;
        if (!Object.prototype.hasOwnProperty.call(APPS, key)) {
            return socket.emit("app_response", { id: req && req.id, ok: false, error: "Unknown app." });
        }
        try {
            if (req.type === "arrange") {
                const split = Math.min(0.9, Math.max(0.5, Number(req.split) || 0.8));
                return arrangeWindows(key, split)
                    .then((r) => socket.emit("app_response", { id: req.id, ...r }))
                    .catch((e) => socket.emit("app_response", {
                        id: req.id, ok: false, error: e.message,
                        needsAccessibility: !!e.needsAccessibility,
                    }));
            }
            if (req.type === "open_panel") {
                // Reopening the app makes the menu bar wrapper show its control
                // window (applicationShouldHandleReopen), so the panel's gear
                // raises the real window rather than a stray browser tab.
                // A flag file the menu bar app watches. Tried `open -b` and an
                // AppleScript activate first: neither reliably reaches an
                // accessory app's reopen handler, and both fail silently.
                try {
                    fs.mkdirSync(SUPPORT, { recursive: true });
                    fs.writeFileSync(path.join(SUPPORT, "show-window"), String(Date.now()));
                } catch (e) {
                    return socket.emit("app_response", { id: req.id, ok: false, error: e.message });
                }
                return socket.emit("app_response", { id: req.id, ok: true });
            }
            // The panels used to launch these themselves. CEP's createProcess
            // runs `open -a`, which does not bring an already-running app to
            // the front, and UXP has no equivalent at all. Here we can focus
            // it properly, and both kinds of panel get the same behaviour.
            if (req.type === "open_assistant") {
                const name = req.which === "ChatGPT" ? "ChatGPT" : "Claude";
                const bundle = path.join("/Applications", name + ".app");
                if (!fs.existsSync(bundle)) {
                    return socket.emit("app_response", {
                        id: req.id, ok: false, error: `${name} isn't installed.`,
                    });
                }
                execFile("/usr/bin/open", ["-a", bundle]);
                focusApp(bundle);
                return socket.emit("app_response", { id: req.id, ok: true });
            }
            if (req.type === "open_accessibility") {
                execFile("/usr/bin/open",
                    ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
                return socket.emit("app_response", { id: req.id, ok: true });
            }
            socket.emit("app_response", { id: req.id, ok: false, error: "Unknown request." });
        } catch (e) {
            socket.emit("app_response", {
                id: req.id, ok: false, error: e.message, needsAccessibility: !!e.needsAccessibility,
            });
        }
    });

    socket.on("command_packet_response", ({ packet }) => {
        if (packet.senderId) io.to(packet.senderId).emit("packet_response", packet);
    });

    socket.on("command_packet", ({ application, command }) => {
        const packet = { senderId: socket.id, application, command };
        const clients = applicationClients[application];
        const label = APPS[application] ? APPS[application].label : application;

        // The hub knows instantly that nothing is listening, but used to say
        // nothing and let the Python side sit out its timeout before reporting
        // a generic "Connection Timed Out". Answer now, and say what to do.
        if (!clients || clients.size === 0) {
            console.log(`⚠ no panel open for ${application}`);
            return socket.emit("packet_response", {
                senderId: socket.id,
                application,
                status: "FAILURE",
                message: APPS[application]
                    ? `The ${label} panel isn't connected. In ${label}: ${APPS[application].panelMenu}. ` +
                      `The Moskito Easy MCP window has a Connect button when the panel is open but idle.`
                    : `Nothing is connected for "${application}".`,
            });
        }

        // Broadcasting meant two open panels — Photoshop 2025 and 2026, or a
        // stale socket — ran every command TWICE against the document, and the
        // duplicate was invisible because Python takes the first reply. Send to
        // the most recently registered panel only.
        const ids = [...clients];
        if (ids.length > 1) {
            console.log(`⚠ ${ids.length} ${label} panels connected; using the newest`);
        }
        io.to(ids[ids.length - 1]).emit("command_packet", packet);
    });

    socket.on("disconnect", () => {
        for (const a in applicationClients) {
            applicationClients[a].delete(socket.id);
            if (!applicationClients[a].size) {
                delete applicationClients[a];
                console.log(`✗ ${a} panel disconnected`);
            }
        }
    });
});

/* --------------------------------------------------------------- the api -- */

app.get("/api/status", (_req, res) => {
    const engine = findEngine();
    const uv = findUv();
    const wired = Object.fromEntries(Object.keys(CLIENTS).map((c) => [c, connectedApps(c)]));

    res.json({
        engine,
        uv,
        debugMode: debugModeOn(),
        claudeRunning: claudeRunning(),
        codexNetwork: codexNetworkAllowed(),
        python: { ready: venvReady, building: venvBuilding, error: venvError },
        version: VERSION,
        update,
        apps: Object.entries(APPS).map(([key, a]) => ({
            key,
            label: a.label,
            kind: a.kind,
            panelMenu: a.panelMenu,
            installed: appInstalled(a.appGlob),
            panelInstalled: panelInstalled(key),
            live: !!applicationClients[key],
            // open but not live means "the panel is showing, it just hasn't
            // connected" — a one-click fix rather than a mystery.
            panelOpen: a.kind === "cep" ? !!panelOpen[key] : null,
            clients: Object.keys(CLIENTS).filter((c) => wired[c].includes(key)),
        })),
        clients: Object.entries(CLIENTS).map(([id, c]) => ({
            id,
            label: c.label,
            blurb: c.blurb,
            file: c.file.replace(HOME, "~"),
            connected: wired[id],
        })),
    });
});

app.post("/api/panel/:key", (req, res) => {
    if (!APPS[req.params.key]) return res.status(404).json({ error: "Unknown app." });
    try {
        installPanel(req.params.key);
        res.json({ ok: true });
    } catch (e) {
        res.status(e.message === "uxp" ? 400 : 500).json({ error: e.message });
    }
});

app.post("/api/client/:id", (req, res) => {
    if (!CLIENTS[req.params.id]) return res.status(404).json({ error: "Unknown assistant." });
    try {
        const keys = registerableApps();
        // Used to reach serverDef(undefined) and put a raw TypeError in a toast.
        if (!keys.length) throw new Error("No Adobe apps found in /Applications, so there's nothing to connect.");
        if (!serverDef(keys[0])) throw new Error("Engine or uv not found — run Setup first.");
        connectClient(req.params.id, keys);
        res.json({ ok: true, connected: keys });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/client/:id", (req, res) => {
    if (!CLIENTS[req.params.id]) return res.status(404).json({ error: "Unknown assistant." });
    try {
        disconnectClient(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/open/:key", (req, res) => {
    const a = APPS[req.params.key];
    if (!a) return res.status(404).json({ error: "unknown app" });
    const bundle = appBundle(a.appGlob);
    if (!bundle) return res.status(404).json({ error: `${a.label} isn't installed` });
    execFile("/usr/bin/open", ["-a", bundle]);
    focusApp(bundle);
    res.json({ ok: true });
});

// Quit Claude, write the config while it is closed, then reopen it. This is the
// only reliable way to connect Claude Desktop — see claudeRunning() above.
app.post("/api/restart-claude", (_req, res) => {
    execFile("/usr/bin/osascript", ["-e", 'tell application "Claude" to quit'], () => {
        let waited = 0;
        const finish = () => {
            try {
                connectClient("claude-desktop", registerableApps());
            } catch (e) {
                console.log("\u26a0 could not write Claude config: " + e.message);
            }
            execFile("/usr/bin/open", ["-a", "Claude"]);
        };
        const poll = () => {
            if (!claudeRunning() || waited > 15000) return finish();
            waited += 500;
            setTimeout(poll, 500);
        };
        setTimeout(poll, 500);
    });
    res.json({ ok: true });
});

app.post("/api/reveal", (req, res) => {
    const engine = findEngine();
    const target = req.body?.what === "uxp" ? path.join(engine, "uxp") : engine;
    execFile("/usr/bin/open", [target]);
    res.json({ ok: true });
});


const UDT_WORKSPACE = path.join(
    HOME, "Library", "Application Support", "Adobe", "Adobe UXP Developer Tool", "plugins_workspace.json"
);
const UDT_HOST = { photoshop: "PS", premiere: "premierepro" };
// A folder in /Applications with the .app inside it, the way Adobe ships most
// things. appBundle() unwraps that; a plain path join does not.
const UDT_GLOB = "Adobe UXP Developer Tool";

// Press Load for them.
//
// A Developer Tool load lasts only as long as the host app's session, so
// Photoshop and Premiere otherwise need a trip through Adobe's tool on every
// launch — the thing that makes them worse to live with than Illustrator.
//
// The Developer Tool runs a local service, and that is what its own CLI drives.
// Connecting to /socket/cli (the path decides the client type; the default is
// "app", which is why a connection to / just sits there) announces every
// connected host app, and a "proxy" message forwards a request to one of them.
// Read out of the tool's own bundle, so: undocumented, and Adobe could change
// it. Every failure here falls back to asking the user to click Load.
const UXP_SERVICE = "ws://127.0.0.1:14001/socket/cli";
const UXP_APP_ID = { photoshop: "PS", premiere: "PPRO" };

// A connected panel is the only trustworthy signal that a plugin is loaded:
// the service reports "already loaded" as the same flat failure string as a
// real one, so the error text cannot tell them apart.
function panelLive(key) {
    const set = applicationClients[key];
    return !!set && set.size > 0;
}

// No "it is already loaded, skip" here: loading an already-loaded plugin simply
// reloads it, which is exactly what someone pressing Load a second time wants —
// and is how a new build reaches a panel without restarting the app. The
// automatic loop does its own liveness check, so it never churns a working one.
async function loadUxpPlugin(key) {
    try {
        return await loadUxpPluginOnce(key);
    } catch (e) {
        // Give the panel a moment to come up and say hello: a load that reports
        // failure but produces a working panel is a success.
        await new Promise((r) => setTimeout(r, 2500));
        if (panelLive(key)) return { ok: true, already: true };
        throw e;
    }
}

function loadUxpPluginOnce(key) {
    return new Promise((resolve, reject) => {
        const engine = findEngine();
        const manifest = engine && path.join(engine, "uxp", APPS[key].uxp, "manifest.json");
        if (!manifest || !fs.existsSync(manifest)) return reject(new Error("Plugin source missing."));

        // The plugin FOLDER, not manifest.json. Its own PluginLoadCommand does
        // path.dirname(manifest), and passing the manifest fails with the same
        // flat "Failed to load the devtools plugin" you get for everything else.
        const folder = path.dirname(manifest);

        let WebSocket;
        try { WebSocket = require("ws"); } catch { return reject(new Error("ws unavailable.")); }

        const want = UXP_APP_ID[key];
        const ws = new WebSocket(UXP_SERVICE);
        const reqId = Date.now() % 100000;
        let hostId = null, settled = false;

        const done = (err, value) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* already closing */ }
            err ? reject(err) : resolve(value);
        };

        ws.on("error", () => done(new Error(
            "Adobe's UXP Developer Tool isn't running, so it can't load the panel.")));
        ws.on("message", (raw) => {
            let m;
            try { m = JSON.parse(String(raw)); } catch { return; }
            if (m.command === "didAddRuntimeClient" && m.app &&
                String(m.app.appId || "").toUpperCase().startsWith(want)) {
                hostId = m.id;
            }
            if (m.command === "didCompleteConnection") {
                if (!hostId) {
                    return done(new Error(`${APPS[key].label} isn't connected to the Developer Tool. `
                        + "Turn on Developer Mode in its settings and restart it."));
                }
                ws.send(JSON.stringify({
                    command: "proxy", clientId: hostId, requestId: reqId,
                    message: {
                        command: "Plugin", action: "load", breakOnStart: false,
                        params: { provider: { type: "disk", path: folder } },
                    },
                }));
            }
            if (m.requestId === reqId) {
                if (m.error) return done(new Error(m.error));
                done(null, { ok: true });
            }
        });
        setTimeout(() => done(new Error("The Developer Tool didn't answer.")), 25000);
    });
}

// Now that loading can be done for them, do it. A UXP panel dies with its host
// app, so without this every Photoshop launch means a trip through Adobe's tool
// — the thing that made these apps worse to live with than the CEP ones.
//
// Quiet on purpose: only for an app that is running, already set up, and not
// already connected, and it backs off rather than retrying forever, because the
// service is undocumented and a failure that repeats is noise, not information.
const autoLoad = {};   // key -> { next, wait }

async function autoLoadUxp() {
    for (const [key, a] of Object.entries(APPS)) {
        if (a.kind !== "uxp") continue;

        const state = autoLoad[key] || (autoLoad[key] = { next: 0, wait: 15000 });
        if (!appRunning(key)) { state.next = 0; state.wait = 15000; continue; }
        if (panelLive(key)) { state.wait = 15000; continue; }
        if (Date.now() < state.next) continue;

        // Only if they have been through setup: the workspace entry is what
        // the Developer Tool loads from.
        let registered = false;
        try {
            registered = (readJSON(UDT_WORKSPACE, { plugins: [] }).plugins || [])
                .some((p) => p.hostParam === UDT_HOST[key]);
        } catch { registered = false; }
        if (!registered) { state.next = Date.now() + 60000; continue; }

        // The service belongs to the Developer Tool, so it has to be running.
        // -g so it does not steal focus from whatever they are doing.
        if (!udtRunning()) {
            const udt = appBundle(UDT_GLOB);
            if (!udt) { state.next = Date.now() + 60000; continue; }
            execFile("/usr/bin/open", ["-g", "-a", udt]);
            state.next = Date.now() + 8000;   // let it come up, then try
            continue;
        }

        state.next = Date.now() + state.wait;
        try {
            await loadUxpPlugin(key);
            console.log(`\u2713 loaded the ${a.label} panel`);
            state.wait = 15000;
            state.said = null;
        } catch (e) {
            // "not connected" needs the user to restart the app, so retrying
            // every 15 seconds only fills the log. Go straight to the slowest
            // rate and say it once.
            const needsUser = /isn't connected/.test(e.message);
            state.wait = needsUser ? 300000 : Math.min(state.wait * 2, 300000);
            if (state.said !== e.message) {
                state.said = e.message;
                console.log(`\u26a0 couldn't load the ${a.label} panel: ${e.message}`);
            }
        }
    }
}

function udtRunning() {
    const bundle = appBundle(UDT_GLOB);
    if (!bundle) return false;
    try {
        execFileSync("/usr/bin/pgrep", ["-f", path.join(bundle, "Contents", "MacOS")],
            { stdio: "ignore", timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

app.post("/api/load-uxp/:key", async (req, res) => {
    if (!APPS[req.params.key]) return res.status(404).json({ error: "Unknown app." });
    try {
        res.json(await loadUxpPlugin(req.params.key));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Register a UXP plugin in Adobe's Developer Tool so the user only has to press
// "Load". Adobe rejects unsigned .ccx packages outright (UPIA status -267), so
// this is as far as automation can go without an Adobe-signed plugin.
// The Developer Tool loads a plugin INTO a running application. With the app
// closed, Load fails with a bare "Plugin Load Failed" and no reason — which is
// the likeliest way to be stuck here, since nothing in the flow says the app
// has to be open.
function appRunning(key) {
    const bundle = appBundle(APPS[key].appGlob);
    if (!bundle) return false;
    try {
        execFileSync("/usr/bin/pgrep", ["-f", path.join(bundle, "Contents", "MacOS")],
            { stdio: "ignore", timeout: 5000 });
        return true;
    } catch {
        return false;   // pgrep exits non-zero when nothing matches
    }
}

function setupUxp(key) {
    const engine = findEngine();
    if (!engine) throw new Error("Can't find the adb-mcp engine folder.");
    const manifest = path.join(engine, "uxp", APPS[key].uxp, "manifest.json");
    if (!fs.existsSync(manifest)) throw new Error(`Plugin source missing: ${manifest}`);

    const ws = readJSON(UDT_WORKSPACE, { version: 1, plugins: [] });
    // Also drop entries we retired, and any whose manifest is gone — a plugin
    // pointing at a deleted app shows up as a broken row the user cannot
    // explain. There were two, left by an earlier name for this app.
    ws.plugins = (ws.plugins || []).filter(
        (p) => p.hostParam !== UDT_HOST[key]
            && p.manifestPath !== manifest
            && p.hostParam !== "ID"
            && fs.existsSync(p.manifestPath || "")
    );
    ws.plugins.push({ manifestPath: manifest, pluginOptions: { breakOnStart: false }, hostParam: UDT_HOST[key] });
    writeJSON(UDT_WORKSPACE, ws);

    // Open the host app now, so it is ready by the time they reach Load.
    const wasClosed = !appRunning(key);
    if (wasClosed) {
        const bundle = appBundle(APPS[key].appGlob);
        if (bundle) execFile("/usr/bin/open", ["-a", bundle]);
    }

    const udt = appBundle(UDT_GLOB);
    if (!udt) {
        return { ok: true, udtMissing: true, wasClosed,
                 message: "Install Adobe's free UXP Developer Tool from Creative Cloud, then press Set up again." };
    }
    execFile("/usr/bin/open", ["-a", udt]);
    return { ok: true, wasClosed };
}

// Adobe ships the UXP Developer Tool through Creative Cloud, not as a download,
// so the useful thing is to open Creative Cloud if it is there and Adobe's
// install page either way. No URL comes from the client: nothing to sanitise.
// Bring Adobe's Developer Tool to the front. Launching Photoshop right after it
// means Photoshop ends up on top, so by the time anyone reaches "press Load"
// the window they need is behind the one they are told to ignore.
app.post("/api/focus-uxp", (_req, res) => {
    const bundle = appBundle(UDT_GLOB);
    if (!bundle) return res.status(404).json({ error: "The UXP Developer Tool isn't installed." });
    execFile("/usr/bin/open", ["-a", bundle]);   // launches it if it is closed
    focusApp(bundle);                            // and this is what fronts it
    res.json({ ok: true });
});

app.post("/api/uxp-help", (_req, res) => {
    // By bundle id, not path: Creative Cloud.app lives in
    // /Applications/Utilities/Adobe Creative Cloud/ACC/, which is not where
    // anyone would guess, and Adobe has moved it before.
    execFile("/usr/bin/open", ["-b", "com.adobe.acc.AdobeCreativeCloud"], (err) => {
        if (err) console.log("\u26a0 couldn't open Creative Cloud: " + err.message);
    });
    execFile("/usr/bin/open",
        ["https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/installation/"]);
    res.json({ ok: true });
});

app.post("/api/uxp/:key", (req, res) => {
    if (!APPS[req.params.key]) return res.status(404).json({ error: "Unknown app." });
    try {
        res.json(setupUxp(req.params.key));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// The single button: install what can be installed, wire up every AI client
// that is actually present on this machine.
// The Python environment has to exist BEFORE the client configs are written to
// point at it. This used to fire ensureVenv() without awaiting and reply
// "Ready", so a fresh Mac got five configs aimed at a binary that was still
// minutes from existing, and every request failed with no explanation.
app.post("/api/setup", async (_req, res) => {
    const done = [];
    const todo = [];
    const failed = [];
    try {
        await new Promise((resolve) => ensureVenv(() => resolve()));
        if (!venvReady) {
            return res.status(500).json({
                error: (venvError || "The Python environment isn't ready.") +
                       " Nothing was connected, so you won't get silent failures later.",
            });
        }
        for (const [key, a] of Object.entries(APPS)) {
            if (!appInstalled(a.appGlob)) continue;
            try {
                if (a.kind === "cep") {
                    installPanel(key);
                    done.push(a.label);
                } else {
                    setupUxp(key);
                    todo.push(a.label);
                }
            } catch (e) {
                failed.push(`${a.label} (${e.message})`);
            }
        }
        const keys = registerableApps();
        const wired = [];
        for (const id of Object.keys(CLIENTS)) {
            // Only touch clients the user actually has.
            const dir = path.dirname(CLIENTS[id].file);
            const has = fs.existsSync(CLIENTS[id].file) || fs.existsSync(dir);
            if (!has && id !== "claude-code") continue;
            try {
                connectClient(id, keys);
                wired.push(CLIENTS[id].label);
            } catch (e) {
                failed.push(`${CLIENTS[id].label} (${e.message})`);
            }
        }
        let message = `Ready: ${done.join(", ") || "no auto-installable apps"}.`;
        if (wired.length) message += ` Connected to ${wired.join(", ")}.`;
        if (todo.length) message += ` ${todo.join(" & ")} need one Load click in the UXP tool.`;
        if (failed.length) message += ` Couldn't do: ${failed.join("; ")}.`;
        res.json({ ok: true, message, done, todo, wired, failed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/update", async (_req, res) => {
    try {
        await applyUpdate();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/codex-network", (_req, res) => {
    try {
        allowCodexNetwork();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/icon/:key", (req, res) => {
    const file = appIconPath(req.params.key);
    if (!file) return res.status(404).end();
    res.type("png").sendFile(file);
});

app.post("/api/connect-panel/:key", async (req, res) => {
    const key = req.params.key;
    if (!APPS[key]) return res.status(404).json({ error: "Unknown app." });
    try {
        res.json(await connectPanel(key));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// A half-built environment used to be unrecoverable without deleting a folder
// by hand, so make rebuilding it an action in the UI.
app.post("/api/rebuild-python", (_req, res) => {
    try {
        fs.rmSync(VENV, { recursive: true, force: true });
    } catch (e) {
        return res.status(500).json({ error: "Couldn't remove the old environment: " + e.message });
    }
    venvReady = false;
    venvError = null;
    ensureVenv(() => repairClientPaths());
    res.json({ ok: true });
});

// Quitting the hub alone was pointless: the menu bar app restarted it two
// seconds later while the page claimed it had stopped. Ask the parent to quit,
// which terminates us properly on its way out.
app.post("/api/quit", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
        execFile("/usr/bin/osascript",
            ["-e", 'tell application id "com.moskitodesign.adobemcp" to quit'],
            (err) => { if (err) process.exit(0); });   // no wrapper (dev run): just stop
        setTimeout(() => process.exit(0), 3000);
    }, 200);
});

app.use(express.static(HERE));

// This is a background daemon whose only supervisor gives up after five
// restarts, so an unhandled rejection must not be the thing that kills it.
process.on("unhandledRejection", (e) => console.log("⚠ unhandled rejection: " + (e && e.message)));
process.on("uncaughtException", (e) => console.log("⚠ uncaught: " + ((e && e.stack) || e)));

const URL = `http://localhost:${PORT}`;

server.on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    // Already running (or the old adb-mcp proxy has the port). Exit quietly —
    // opening a browser tab here meant every stray launch popped one up.
    console.log("Port 3001 is already in use \u2014 another copy is running. Exiting.");
    process.exit(0);
});

// If the menu bar app is force-quit or crashes, this process is reparented to
// launchd and would sit on port 3001 forever, blocking the next launch.
// Only when the menu bar app started us. The bash fallback launcher execs node
// directly, so ITS parent is launchd and ppid is 1 from the first second —
// which made that build quit itself about five seconds after every launch.
setInterval(() => {
    if (process.env.ADOBE_MCP_SUPERVISED === "1" && process.ppid === 1) {
        console.log("Parent app is gone \u2014 shutting down.");
        process.exit(0);
    }
}, 5000).unref();

// "127.0.0.1", not the default of every interface: this is a local control
// surface, and binding publicly also triggers the macOS incoming-connections
// prompt, which a colleague who clicks Deny can never recover from.
server.listen(PORT, "127.0.0.1", () => {
    // The menu bar app decides when to show the panel — first run, its menu
    // item, or reopening the app. The hub never opens a tab on its own.
    console.log(`Moskito Easy MCP ${VERSION}  \u2192  ${URL}`);
    fs.mkdirSync(SUPPORT, { recursive: true });
    refreshPanels();
    ensureVenv(() => repairClientPaths());
    // Claude Desktop is skipped while it is open, so keep checking: the moment
    // it closes, its config gets fixed without the user doing anything.
    setInterval(repairClientPaths, 30000).unref();
    refreshPanelOpen();
    setInterval(refreshPanelOpen, 5000).unref();
    setInterval(autoLoadUxp, 5000).unref();
    checkForUpdate();
    setInterval(checkForUpdate, 6 * 3600 * 1000);
});
