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

// Italian when the Mac's first language is, English for everything else. The
// menu bar app passes its own reading (so `-AppleLanguages (it)` tests both);
// a bare `node hub.js` asks macOS. Only what people read is translated: what
// goes to the assistants stays English.
const IT = /^it/i.test(process.env.MOSKITO_LANG || (() => {
    try {
        return execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8" })
            .match(/[a-z]{2}/i)[0];
    } catch { return ""; }
})());
const L = (en, it) => (IT ? it : en);

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
        panelMenuIt: "Plug-in → Moskito Easy MCP",
    },
    illustrator: {
        label: "Illustrator",
        kind: "cep", cep: "com.mikechambers.ai", mcp: "ai-mcp.py",
        appGlob: "Adobe Illustrator",
        panelMenu: "Window → Extensions → Moskito Easy MCP",
        panelMenuIt: "Finestra → Estensioni → Moskito Easy MCP",
    },
    aftereffects: {
        label: "After Effects",
        kind: "cep", cep: "com.mikechambers.ae", mcp: "ae-mcp.py",
        appGlob: "Adobe After Effects",
        panelMenu: "Window → Extensions → Moskito Easy MCP",
        panelMenuIt: "Finestra → Estensioni → Moskito Easy MCP",
    },
    premiere: {
        label: "Premiere Pro",
        kind: "uxp", uxp: "pr", mcp: "pr-mcp.py",
        appGlob: "Adobe Premiere Pro",
        panelMenu: "Window → UXP Plugins → Moskito Easy MCP",
        panelMenuIt: "Finestra → Plug-in UXP → Moskito Easy MCP",
    },
    indesign: {
        label: "InDesign",
        kind: "uxp", uxp: "id", mcp: "id-mcp.py",
        appGlob: "Adobe InDesign",
        panelMenu: "Plug-Ins → Moskito Easy MCP → Moskito Easy MCP",
        panelMenuIt: "Plug-in → Moskito Easy MCP → Moskito Easy MCP",
    },
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
    if (!bundle) throw new Error(L(`${APPS[appKey].label} isn't installed.`, `${APPS[appKey].label} non è installato.`));

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
        throw new Error(L(`Couldn't arrange the windows — ${answer}.`, `Non riesco a disporre le finestre — ${answer}.`));
    }
    throw new Error(L("Moskito Easy MCP didn't answer. Try Restart Background Service from its menu.",
        "Moskito Easy MCP non risponde. Prova Riavvia servizio in background dal suo menu."));
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
            L(`The ${APPS[key].label} panel isn't open. In ${APPS[key].label}: ${APPS[key].panelMenu}.`,
              `Il pannello di ${APPS[key].label} non è aperto. In ${APPS[key].label}: ${APPS[key].panelMenuIt}.`)
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
function serverDef(key, clientId) {
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
        // Which assistant this server belongs to, so its calls can be counted
        // separately. We generate these config files, so this is known rather
        // than inferred from a process tree.
        env: clientId
            ? { PYTHONDONTWRITEBYTECODE: "1", MOSKITO_CLIENT: clientId }
            : { PYTHONDONTWRITEBYTECODE: "1" },
    };
}

// Which apps are worth registering: the Adobe app is actually on this machine.
// Which apps to expose to the assistants.
//
// Every tool definition of every registered app rides on every request, so an
// app you own but never drive is a permanent tax: Photoshop alone is about
// 9,000 tokens. Installed is the default, but it should not be the only
// option — hence a list the user controls.
const ENABLED = path.join(SUPPORT, "enabled-apps.json");

function enabledApps() {
    try {
        const v = readJSON(ENABLED, null);
        // No file yet means "everything installed", which is what it did before.
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

function setAppEnabled(key, on) {
    const current = enabledApps() || Object.keys(APPS).filter((k) => appInstalled(APPS[k].appGlob));
    const set = new Set(current);
    on ? set.add(key) : set.delete(key);
    fs.mkdirSync(SUPPORT, { recursive: true });
    writeJSON(ENABLED, [...set]);
}

function registerableApps() {
    const allowed = enabledApps();
    return Object.keys(APPS).filter((k) =>
        appInstalled(APPS[k].appGlob) && (!allowed || allowed.includes(k)));
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

// Is the assistant actually on this Mac? Setup used to infer it from whether
// its config folder existed — true of a Mac that once had it, and of
// ~/.claude.json, which setup itself wrote for Claude Code unconditionally. So
// a Mac with no assistant at all went through setup without a word, and showed
// "Connected" for an app that wasn't there.
const ASSISTANT_DOWNLOADS = {
    claude: "https://claude.com/download",
    chatgpt: "https://chatgpt.com/download/",
};
function hasApp(name) {
    return fs.existsSync(path.join("/Applications", name))
        || fs.existsSync(path.join(HOME, "Applications", name));
}
// The command-line versions, where installers usually put them.
function hasCli(name) {
    return [path.join(HOME, ".local", "bin", name), path.join(HOME, ".claude", "local", name),
            "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name,
            path.join(HOME, ".npm-global", "bin", name)].some((f) => fs.existsSync(f));
}
function clientInstalled(id) {
    if (id === "codex") return hasApp("ChatGPT.app") || hasCli("codex");
    // The desktop app's Code tab runs Claude Code, so Claude.app covers both.
    if (id === "claude-code") return hasApp("Claude.app") || hasCli("claude");
    return hasApp("Claude.app");
}

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
        // Drop ours that are no longer wanted. Without this, switching an app
        // off left its server behind and cost exactly as much as before.
        for (const k of Object.keys(APPS)) {
            if (!keys.includes(k)) delete cfg[c.key][k];
        }
        for (const k of keys) cfg[c.key][k] = serverDef(k, clientId);
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
        const d = serverDef(k, clientId);
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
    // ~/.codex doesn't exist until Codex first runs; ChatGPT being installed
    // is enough for us to wire it.
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
// pgrep -x "Claude" matched nothing with Claude plainly running, so this
// answered "closed" every time. See bundleRunning for the measurement.
const claudeRunning = memo(
    () => bundleRunning("/Applications/Claude.app"), 3000);

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

    if (key === "aftereffects") aeStartupScript(true);

    // Adobe refuses to load unsigned panels unless debug mode is on.
    for (const v of ["10", "11", "12", "13"]) {
        try {
            execFileSync("/usr/bin/defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
        } catch { /* version not present on this machine */ }
    }
}

// After Effects never sends the start event that opens the Illustrator panel
// at launch (see panel-starter.html), but it runs every script in the per-user
// Scripts/Startup folder of each version it has been opened as. Opening the
// panel's menu item when it is already open leaves it open.
const AE_PREFS = path.join(HOME, "Library", "Preferences", "Adobe", "After Effects");
function aeStartupScript(on) {
    let versions = [];
    try { versions = fs.readdirSync(AE_PREFS).filter((v) => /^\d/.test(v)); } catch { return; }
    for (const v of versions) {
        const file = path.join(AE_PREFS, v, "Scripts", "Startup", "Moskito Easy MCP.jsx");
        try {
            if (!on) { fs.rmSync(file, { force: true }); continue; }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "// Moskito Easy MCP: open its panel when After Effects starts.\n" +
                "app.scheduleTask('var id = app.findMenuCommandId(\"Moskito Easy MCP\"); " +
                "if (id) app.executeCommand(id);', 5000, false);\n");
        } catch { /* that version's folder isn't writable: the panel opens by hand */ }
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
        venvError = L("The bundled uv runtime is missing \u2014 reinstall Adobe MCP.",
            "Manca il runtime uv incluso \u2014 reinstalla Moskito Easy MCP.");
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
    // Our own Python, never the Mac's. With no version given, uv took the first
    // interpreter on the app's PATH — and an app opened from the Dock only has
    // /usr/bin, where the Xcode tools put Python 3.9.6. The MCP library needs
    // 3.10+, so on a colleague's Mac setup failed with "requirements are
    // unsatisfiable" even though Terminal showed a Python 3.15 they had
    // installed: the app could never see it. Every Mac that rebuilt its
    // environment would have hit the same thing. uv downloads a pinned 3.12
    // (24 MB, once) into our own folder instead, so the same Python runs
    // everywhere and nothing here touches, or depends on, the user's.
    const uvEnv = { ...process.env, UV_PYTHON_PREFERENCE: "only-managed",
                    UV_PYTHON_INSTALL_DIR: path.join(SUPPORT, "python") };

    // An environment left behind on another Python — the 3.9 one above — would
    // be patched in place by --allow-existing, mixing two interpreters' files.
    try {
        const cfg = fs.readFileSync(path.join(VENV, "pyvenv.cfg"), "utf8");
        if (!/^version(_info)?\s*=\s*3\.12\b/m.test(cfg)) fs.rmSync(VENV, { recursive: true, force: true });
    } catch { /* no environment yet */ }

    // Network wording only when it's the network: a resolver failure used to end
    // "unsatisfiable.. Check your internet connection", sending people to check
    // a connection that was fine.
    const hint = (e) => /network|connect|resolve|dns|timed out|offline|tls|ssl/i.test(String(e.message))
        ? " Check your internet connection." : "";
    const sentence = (t) => String(t).replace(/[.\s]+$/, "") + ".";

    execFile(uv, ["venv", "--python", "3.12", "--allow-existing", VENV],
        { timeout: 300000, env: uvEnv }, (e1) => {
        if (e1) return finish(new Error("Couldn't create the Python environment \u2014 "
                                        + sentence(why(e1)) + hint(e1)));
        execFile(uv, ["pip", "install", "--python", path.join(VENV, "bin", "python"), ...PY_DEPS],
            { timeout: 600000, env: uvEnv }, (e2) => {
                finish(e2
                    ? new Error("Couldn't download the Python packages \u2014 " + sentence(why(e2)) + hint(e2))
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
const RETIRED = [];

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

// Which assistants the user actually wants wired up.
//
// Needed to tell "Claude Desktop threw our servers away" apart from "the user
// pressed Disconnect". Without it, restoring what went missing would also undo
// every deliberate disconnect.
const WANTED = path.join(SUPPORT, "connected-clients.json");

function wantedClients() {
    let listed = [];
    try {
        const v = readJSON(WANTED, []);
        listed = Array.isArray(v) ? v : [];
    } catch { /* unreadable: fall back to what is on disk */ }

    // Everyone who set this up before the record existed has servers in their
    // configs and no entry here. Treat a client that already carries ours as
    // wanted, or they would be left out of every rewrite from now on.
    const onDisk = Object.keys(CLIENTS).filter((id) => connectedApps(id).length);
    return [...new Set([...listed, ...onDisk])];
}

function rememberClient(id, on) {
    const set = new Set(wantedClients());
    on ? set.add(id) : set.delete(id);
    try {
        fs.mkdirSync(SUPPORT, { recursive: true });
        writeJSON(WANTED, [...set]);
    } catch (e) {
        console.log(`\u26a0 couldn't record the assistant list: ${e.message}`);
    }
}

function repairClientPaths() {
    const want = serverDef(Object.keys(APPS)[0]);
    if (!want) return;
    for (const id of Object.keys(CLIENTS)) {
        // This used to skip Claude Desktop entirely whenever Claude was
        // running, because Claude Desktop rewrites that file itself. But
        // someone using Claude has it running essentially always, so the skip
        // was permanent: a retired server sat in that config for weeks, and
        // when Claude dropped our four servers nothing ever put them back.
        // We only write when something is actually wrong, so there is nothing
        // to churn when everything is fine — and if Claude clobbers it again,
        // we restore within the next pass.
        if (removeRetired(id)) console.log(`\u2713 removed retired servers from ${CLIENTS[id].label}`);

        const connected = connectedApps(id);
        // Restoring only makes sense for an assistant the user connected; a
        // deliberate Disconnect has to stick.
        const missing = wantedClients().includes(id)
            ? registerableApps().filter((k) => !connected.includes(k))
            : [];
        if (missing.length) {
            try {
                connectClient(id, [...new Set([...connected, ...missing])]);
                console.log(`\u2713 put ${missing.join(", ")} back into ${CLIENTS[id].label}`);
            } catch (e) {
                console.log(`\u26a0 could not restore ${CLIENTS[id].label}: ${e.message}`);
            }
            continue;
        }
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
                    // A config written before the client tag existed. Counting
                    // it as drift is how every install gets labelled without
                    // anyone pressing Connect again.
                    if (!(def.env || {}).MOSKITO_CLIENT) return true;
                    const last = (def.args || [])[(def.args || []).length - 1] || "";
                    return path.dirname(last) !== path.dirname(engineArg);
                });
            } else {
                const toml = fs.readFileSync(CLIENTS[id].file, "utf8");
                stale = !toml.includes(want.command)
                    || !toml.includes("PYTHONDONTWRITEBYTECODE")
                    || !toml.includes("MOSKITO_CLIENT")
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
    // Six hours. An urgent fix does not wait that long: the push signal below
    // resets this, so a release can reach everyone in minutes when it has to.
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
//
// DOWNLOADING happens by itself; RESTARTING never does. A restart drops the
// Adobe panels' connection and ends whatever conversation is open, and no
// amount of guessing at a quiet moment makes that someone else's call to take.
// So the new version is fetched, checked and parked, and the person is asked —
// in the control panel, and by the menu bar app, which they will see without
// having to open anything.

// Anything that counts as someone working. Nothing restarts on its own any
// more, but a download still waits for the first run's setup to finish.
let lastActivityAt = 0;
const startedAt = Date.now();
// The update policy: a downloaded version installs itself once the Adobe tools
// have gone unused for an hour (counted from launch if never used), or at the
// next launch, whichever comes first. Nobody is asked.
const IDLE_BEFORE_UPDATE = 60 * 60 * 1000;
let autoUpdateAt = 0;

// A version downloaded and verified, waiting for someone to say when.
let staged = null;                                          // { version, path }
const STAGED_DIR = path.join(SUPPORT, "staged-update");
const UPDATE_READY = path.join(SUPPORT, "update-ready");    // the menu bar app watches this

// The override. The admin page writes a timestamp to the Worker; when it is
// newer than the last one this process saw, the six-hour cache is dropped and
// GitHub is asked at once. The first reading after launch is only a baseline —
// a freshly started app checks GitHub 45 seconds in regardless.
let pushSeen = null;

async function honourPush() {
    try {
        const r = await fetch("https://adobe-mcp.l-salvioni.workers.dev/signal",
                              { signal: AbortSignal.timeout(5000) });
        const { push = 0 } = await r.json();
        if (pushSeen !== null && push > pushSeen) {
            console.log("\u2192 update pushed: checking now");
            updateChecked = 0;
            autoUpdateAt = 0;
        }
        pushSeen = push;
    } catch { /* offline: the normal schedule carries on */ }
}

async function autoUpdate() {
    if (staged && Date.now() - Math.max(lastActivityAt, startedAt) > IDLE_BEFORE_UPDATE) {
        console.log(`\u2192 installing ${staged.version}: an hour without use`);
        return applyUpdate();
    }
    await honourPush();
    const found = await checkForUpdate();
    if (!found) return;
    if (staged && staged.version === found.version) return;   // already waiting
    if (venvBuilding) return;                                 // first run comes first
    if (Date.now() - autoUpdateAt < 30 * 60 * 1000) return;   // one go per half hour
    autoUpdateAt = Date.now();

    try {
        await stageUpdate();
        console.log(`\u2713 ${staged.version} is downloaded \u2014 waiting for a restart`);
    } catch (e) {
        // The banner stays as the way out: a failed download should not also
        // take away the button.
        console.log(`\u26a0 couldn't download the update: ${e.message}`);
    }
}


// Download, unpack and check it. Nothing on disk is touched that the running
// app depends on, so this is safe to do at any moment — it ends with a verified
// copy parked in Application Support and `staged` pointing at it.
async function stageUpdate() {
    if (!update) throw new Error(L("No update available.", "Nessun aggiornamento disponibile."));
    const bundle = path.resolve(HERE, "..", "..");
    if (!bundle.endsWith(".app")) throw new Error(L("Updates only work on the installed app.", "Gli aggiornamenti funzionano solo sull'app installata."));

    // Not os.tmpdir(): macOS prunes it, and this copy may sit for days waiting
    // for someone to restart.
    fs.rmSync(STAGED_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGED_DIR, { recursive: true });
    const tmp = STAGED_DIR;
    const zip = path.join(tmp, "update.zip");
    const r = await fetch(update.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10 * 60 * 1000),   // a stalled download used to hang forever
    });
    if (!r.ok) throw new Error(L(`Download failed (${r.status}).`, `Download non riuscito (${r.status}).`));
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));

    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, tmp]);
    fs.rmSync(zip, { force: true });            // 112MB we no longer need
    const fresh = fs.readdirSync(tmp).find((n) => n.endsWith(".app"));
    if (!fresh) throw new Error(L("That download didn't contain an app.", "Il download non conteneva l'app."));

    // Check it before trusting it: an app for the wrong architecture is exactly
    // what the old first-zip-wins picker used to hand out.
    const freshBin = path.join(tmp, fresh, "Contents", "MacOS", "AdobeMCP");
    if (!fs.existsSync(freshBin)) throw new Error(L("That download isn't a working Adobe MCP app.", "Il download non è un'app Moskito Easy MCP funzionante."));
    try {
        const archs = execFileSync("/usr/bin/lipo", ["-archs", freshBin], { encoding: "utf8" });
        if (!archs.includes(process.arch === "arm64" ? "arm64" : "x86_64")) {
            throw new Error(L(`That build is for ${archs.trim()}, which this Mac can't run.`, `Questa versione è per ${archs.trim()}, che questo Mac non può eseguire.`));
        }
    } catch (e) {
        if (/can't run/.test(e.message)) throw e;   // our own check — surface it
        /* lipo unavailable: fall through rather than block the update */
    }

    staged = { version: update.version, path: path.join(tmp, fresh) };
    // The menu bar app watches this file and does the asking, so the prompt
    // reaches someone who never opens the control panel.
    fs.writeFileSync(UPDATE_READY, staged.version);
    return staged;
}

// From the banner's button, after an hour without use (autoUpdate), or at
// launch for a version downloaded earlier (stagedOnDisk).
function applyUpdate() {
    if (!staged) throw new Error(L("No update has been downloaded yet.", "Nessun aggiornamento ancora scaricato."));
    const bundle = path.resolve(HERE, "..", "..");
    if (!bundle.endsWith(".app")) throw new Error(L("Updates only work on the installed app.", "Gli aggiornamenti funzionano solo sull'app installata."));
    const tmp = STAGED_DIR;

    // Move the old app aside rather than deleting it, and put it back if the
    // copy fails. The previous version removed it first, so a failed copy left
    // the user with no app at all and no message.
    const script = path.join(tmp, "swap.sh");
    const q = JSON.stringify;
    fs.writeFileSync(script, [
        "#!/bin/bash",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
        // The menu bar app too, or it keeps running the old version (and its
        // old menu) until someone quits it; it would also restart this hub.
        ...(process.env.ADOBE_MCP_SUPERVISED === "1" && process.ppid !== 1
            ? [`kill ${process.ppid} 2>/dev/null; while kill -0 ${process.ppid} 2>/dev/null; do sleep 0.3; done`]
            : []),
        `OLD=${q(bundle + ".old")}`,
        `rm -rf "$OLD"`,
        // Can't move it (permissions): drop the download and reopen this
        // version, or every launch would try again and quit.
        `mv ${q(bundle)} "$OLD" || { rm -rf ${q(tmp)} ${q(UPDATE_READY)}; /usr/bin/open ${q(bundle)}; exit 1; }`,
        `if /usr/bin/ditto ${q(staged.path)} ${q(bundle)}; then`,
        `  /usr/bin/xattr -cr ${q(bundle)}`,
        `  rm -rf "$OLD"`,
        `else`,
        `  rm -rf ${q(bundle)}`,
        `  mv "$OLD" ${q(bundle)}`,   // put the working version back
        `fi`,
        `/usr/bin/open ${q(bundle)}`,
        `rm -rf ${q(tmp)} ${q(UPDATE_READY)}`,
    ].join("\n"));
    fs.chmodSync(script, 0o755);
    execFile("/bin/bash", [script], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => process.exit(0), 300);
}

// A version downloaded in an earlier run and never restarted into. Installed at
// launch, when nothing is in use yet, so an unused download means the next start rather
// than never: Macs were sitting on versions weeks old.
function stagedOnDisk() {
    try {
        const name = fs.readdirSync(STAGED_DIR).find((n) => n.endsWith(".app"));
        if (!name) return null;
        const app = path.join(STAGED_DIR, name);
        const v = execFileSync("/usr/libexec/PlistBuddy",
            ["-c", "Print CFBundleShortVersionString", path.join(app, "Contents", "Info.plist")],
            { encoding: "utf8" }).trim();
        return isNewer(v, VERSION) ? { version: v, path: app } : null;
    } catch { return null; }
}

/* ----------------------------------------------------------- analytics -- */

// Anonymous, aggregate, and deliberately small.
//
// What leaves this Mac: a random id that is not tied to any person, the app
// version, which Adobe apps were driven, which tools were called, how often
// they failed, and how many bytes we sent back. Averaging across installs
// happens at the other end, so nothing here is ever attributable.
//
// What never leaves: document names, prompt text, script contents, file paths,
// artwork. The Settings panel promises we do not touch documents, and this
// must not quietly make that untrue.
const ANALYTICS = path.join(SUPPORT, "analytics.json");
const COLLECT_URL = "https://adobe-mcp.l-salvioni.workers.dev/collect";

// Not optional. This is a monitored tool the company hands out, the same way
// Teams is, and the app says so plainly rather than offering a switch that is
// not really a switch. What keeps that defensible is the payload, not a
// checkbox: it is anonymous by construction and carries nothing about anyone's
// work. Someone who wants to know what is sent should be able to read this
// function and the one below and be satisfied.
function analyticsState() {
    let st;
    try { st = readJSON(ANALYTICS, null); } catch { st = null; }
    if (!st || typeof st !== "object" || !st.id) {
        st = { id: crypto.randomUUID() };
    } else if ("enabled" in st) {
        // Left by the version that briefly had a switch. Nothing reads it now,
        // and leaving it there implies a control that does not exist.
        delete st.enabled;
    } else {
        return st;
    }
    try {
        fs.mkdirSync(SUPPORT, { recursive: true });
        writeJSON(ANALYTICS, st);
    } catch { /* read-only home: carry on with an id for this run only */ }
    return st;
}

// Reset after each send. Held in memory so a busy session is not writing to
// disk on every tool call.
// clients/clientBytes are the same two numbers again, cut by which assistant
// asked rather than which app answered — the only way to compare what Claude
// and ChatGPT each cost for the same work.
// scriptErrors/errorTypes: scripts that threw INSIDE the Adobe app. The panels
// catch those and reply SUCCESS with {error} in the result, so `errors` (which
// only sees status) had been reporting 0 failures for everything.
const freshTally = () => ({ calls: {}, errors: {}, bytes: {}, tools: {}, clients: {},
                            clientBytes: {}, scriptErrors: {}, errorTypes: {} });
let tally = freshTally();

// Unsent counts used to live only in memory, sent every 15 minutes — so every
// quit, shutdown and update-restart threw away up to 15 minutes of use. A
// colleague who did ten minutes of work and shut their Mac reported nothing.
// Now they are written to disk on the way out and picked up on the next start.
const PENDING = path.join(SUPPORT, "tally-pending.json");

function mergeTally(into, from) {
    for (const [k, counts] of Object.entries(from || {})) {
        if (!into[k] || typeof counts !== "object") continue;
        for (const [name, n] of Object.entries(counts)) {
            into[k][name] = (into[k][name] || 0) + (Number(n) || 0);
        }
    }
}

try {
    if (fs.existsSync(PENDING)) {
        mergeTally(tally, readJSON(PENDING, {}));
        fs.rmSync(PENDING, { force: true });
    }
} catch { /* a damaged file costs one window of counts, nothing more */ }

// Synchronous on purpose: it runs inside process.exit, where nothing async
// gets to finish. Never throws — analytics must not be able to stop an exit.
function flushTally() {
    try {
        if (!Object.values(tally).some((o) => Object.keys(o).length)) return;
        if (fs.existsSync(PENDING)) mergeTally(tally, readJSON(PENDING, {}));
        fs.mkdirSync(SUPPORT, { recursive: true });
        fs.writeFileSync(PENDING, JSON.stringify(tally));
    } catch { /* nothing to be done on the way out */ }
}

// "exit" fires on every process.exit() — the update swap, quit, the orphan
// guard — so one listener covers them all. SIGTERM (how the menu bar app and
// a macOS shutdown stop us) skips "exit" by default; routing it through
// process.exit keeps the same behaviour and lets the flush run.
process.on("exit", flushTally);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
const inFlight = new Map();   // senderId -> { app, tool } so the reply can be attributed

function bump(obj, key, by = 1) { obj[key] = (obj[key] || 0) + by; }

// The failures themselves, for the usage page's error log. Names in quotes and
// file paths are taken out first: an error can quote a layer, comp or file name,
// and documents stay private. Twenty per report at most, and only in memory: a
// quit loses the unsent ones. ponytail: add to PENDING if that ever matters.
let failures = [];
function scrub(text) {
    return String(text || "")
        // Paths first (they can hold spaces: up to the file's extension, else
        // the first space), then anything in straight or curly quotes.
        .replace(/(?:~|\/(?:Users|Volumes|Applications|private|tmp|var|Library))(?:[^\n'"`)]*?\.[A-Za-z0-9]{1,5}\b|[^\s'"`)]*)/g, "<path>")
        .replace(/(["'`])(?:(?!\1)[^\n]){1,200}\1/g, "$1\u2026$1")
        .replace(/\u201c[^\u201d\n]{1,200}\u201d/g, "\u201c\u2026\u201d")
        .replace(/\u2018[^\u2019\n]{1,200}\u2019/g, "\u2018\u2026\u2019")
        .replace(/\s+/g, " ").trim().slice(0, 200);
}
function noteFailure(app, tool, client, message) {
    if (failures.length >= 20) return;
    const text = scrub(message);
    const type = text.split(":")[0].trim();
    failures.push({ at: Date.now(), app, tool: tool || "", client: client || "",
                    type: ERROR_TYPES.has(type) ? type : "other", message: text });
}

function noteCall(app, tool, senderId, client) {
    bump(tally.calls, app);
    if (tool) bump(tally.tools, `${app}.${tool}`);
    // Absent when someone wrote the config by hand; say so rather than guess.
    bump(tally.clients, client || "unknown");
    if (senderId) {
        inFlight.set(senderId, { app, tool, client: client || "unknown" });
        // A reply that never comes must not pin an entry forever.
        setTimeout(() => inFlight.delete(senderId), 120000);
    }
}

function noteReply(senderId, packet) {
    const seen = inFlight.get(senderId);
    if (!seen) return;
    inFlight.delete(senderId);
    try {
        const size = JSON.stringify(packet || "").length;
        bump(tally.bytes, seen.app, size);
        bump(tally.clientBytes, seen.client, size);
    } catch { /* unserialisable: skip the size, keep the count */ }
    if (packet && packet.status && packet.status !== "SUCCESS") {
        bump(tally.errors, seen.app);
        noteFailure(seen.app, seen.tool, seen.client, packet.message || (packet.response && packet.response.message));
    }
    noteScriptError(seen.app, packet, seen);
}

// Only the error's TYPE is kept, and only from a fixed list. The message can
// name a layer, a comp or a file, and the Settings panel promises we never
// collect anything from inside a document; a free-text field would quietly
// break that. Anything not on the list is "other".
const ERROR_TYPES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError",
                             "RangeError", "EvalError", "URIError", "IOError", "InternalError"]);

// A script that threw comes back inside a SUCCESS reply, in one of two shapes.
// The CEP panels (Illustrator, After Effects) wrap results as
// {content:[{text:"<JSON>"}]} with {"error":"TypeError: …"} inside the JSON;
// the Premiere panel returns its handler's object as-is, so it is
// response.error directly.
function scriptErrorText(packet) {
    const resp = packet.response;
    if (resp && typeof resp.error === "string") return resp.error;
    const text = resp && resp.content && resp.content[0] && resp.content[0].text;
    if (typeof text !== "string" || !text.includes('"error"')) return null;
    const result = JSON.parse(text);
    return result && typeof result.error === "string" ? result.error : null;
}

function noteScriptError(app, packet, seen = {}) {
    try {
        if (!packet || packet.status !== "SUCCESS") return;
        const error = scriptErrorText(packet);
        if (!error) return;
        bump(tally.scriptErrors, app);
        const type = error.split(":")[0].trim();
        bump(tally.errorTypes, ERROR_TYPES.has(type) ? type : "other");
        noteFailure(app, seen.tool, seen.client, error);
    } catch { /* not JSON, or not an error: nothing to count */ }
}

// An install that has never driven an app sent nothing at all, ever — so it was
// not an install as far as the figures were concerned, and "installs" silently
// meant "machines that ran a command in the last 30 days". Ping once a day even
// with nothing to report, so a quiet install still counts as one.
let pingedOn = "";

// The Mac's own name ("Luca's MacBook Pro"), so the usage page can say who.
// Said on the settings page and in the README; the hostname is the fallback.
const computerName = memo(() => {
    try {
        return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    } catch { return os.hostname(); }
}, 24 * 3600 * 1000);

async function sendAnalytics() {
    const st = analyticsState();
    const payload = tally;
    const today = new Date().toISOString().slice(0, 10);
    const sent = failures;
    failures = [];
    const anything = sent.length || Object.keys(payload.calls).length || Object.keys(payload.tools).length
        || Object.keys(payload.clients).length || Object.keys(payload.scriptErrors).length;
    if (!anything && pingedOn === today) return;
    pingedOn = today;
    tally = freshTally();   // swap first: a failed
                                                               // send drops a window
                                                               // rather than doubling it
    try {
        await fetch(COLLECT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: st.id,
                name: computerName().slice(0, 64),
                failures: sent,
                version: VERSION,
                day: today,
                ...payload,
            }),
            signal: AbortSignal.timeout(10000),
        });
    } catch { /* offline: this is telemetry, not the product */ }
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

// Pressing buttons in the control panel is working too — setting an app up or
// connecting a client should not be interrupted any more than a command should.
app.use((req, _res, next) => {
    if (req.method !== "GET") lastActivityAt = Date.now();
    next();
});

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
        if (packet.senderId) {
            // The reply goes out first. Counting used to run before this, so
            // an exception in the analytics could have stopped a reply from
            // reaching the assistant at all.
            io.to(packet.senderId).emit("packet_response", packet);
            try { noteReply(packet.senderId, packet); } catch { /* analytics only */ }
        }
    });

    socket.on("command_packet", async ({ application, command }) => {
        lastActivityAt = Date.now();   // the updater waits for a quiet moment
        const packet = { senderId: socket.id, application, command };
        // command.tool is set by the Python side: every Illustrator tool arrives
        // as action "executeExtendScript", so the action alone counts nothing.
        noteCall(application, command && command.tool, socket.id, command && command.client);
        const clients = applicationClients[application];
        const label = APPS[application] ? APPS[application].label : application;

        // The hub knows instantly that nothing is listening, but used to say
        // nothing and let the Python side sit out its timeout before reporting
        // a generic "Connection Timed Out". Answer now, and say what to do.
        if ((!clients || clients.size === 0) && APPS[application] && APPS[application].kind === "uxp") {
            try {
                await ensureUxpPanel(application);
                console.log(`\u2713 loaded the ${label} panel for a request`);
            } catch (e) {
                console.log(`\u26a0 couldn't load the ${label} panel for a request: ${e.message}`);
                // Answered here, so noteReply never sees it: count it now, or
                // "the panel wasn't running" never shows up in the figures.
                bump(tally.errors, application);
                noteFailure(application, command && command.tool, command && command.client,
                            `The ${label} panel isn't running. ${e.message}`);
                inFlight.delete(socket.id);
                return socket.emit("packet_response", {
                    senderId: socket.id, application, status: "FAILURE",
                    message: `The ${label} panel isn't running. ${e.message}`,
                });
            }
        }
        const live = applicationClients[application];
        if (!live || live.size === 0) {
            console.log(`⚠ no panel open for ${application}`);
            bump(tally.errors, application);
            noteFailure(application, command && command.tool, command && command.client,
                        `The ${label} panel isn't connected.`);
            inFlight.delete(socket.id);
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
        const ids = [...live];
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
        setupOnLaunch,
        claudeRunning: claudeRunning(),
        codexNetwork: codexNetworkAllowed(),
        lang: L("en", "it"),
        python: { ready: venvReady, building: venvBuilding, error: venvError },
        version: VERSION,
        // `ready` tells the page whether pressing the button restarts right away
        // or still has 112MB to fetch first.
        update: update && { ...update, ready: !!(staged && staged.version === update.version) },
        apps: Object.entries(APPS).map(([key, a]) => ({
            key,
            label: a.label,
            kind: a.kind,
            panelMenu: IT ? a.panelMenuIt : a.panelMenu,
            installed: appInstalled(a.appGlob),
            enabled: registerableApps().includes(key),
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
            installed: clientInstalled(id),
            download: id === "codex" ? "chatgpt" : "claude",
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

// Turning an app off has to rewrite the configs, or it saves nothing until
// something else happens to trigger a write.
app.post("/api/app-enabled/:key", (req, res) => {
    const key = req.params.key;
    if (!APPS[key]) return res.status(404).json({ error: "Unknown app." });
    try {
        setAppEnabled(key, req.body && req.body.on !== false);
        const keys = registerableApps();
        const rewired = [];
        for (const id of wantedClients()) {
            try {
                keys.length ? connectClient(id, keys) : disconnectClient(id);
                rewired.push(CLIENTS[id].label);
            } catch (e) {
                console.log(`\u26a0 couldn't update ${CLIENTS[id].label}: ${e.message}`);
            }
        }
        res.json({ ok: true, apps: keys, rewired });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/client/:id", (req, res) => {
    if (!CLIENTS[req.params.id]) return res.status(404).json({ error: "Unknown assistant." });
    try {
        const keys = registerableApps();
        // Used to reach serverDef(undefined) and put a raw TypeError in a toast.
        if (!keys.length) throw new Error(L("No Adobe apps found in /Applications, so there's nothing to connect.", "Nessuna app Adobe in Applicazioni: non c'è niente da collegare."));
        if (!serverDef(keys[0])) throw new Error(L("Engine or uv not found — run Setup first.", "Motore o uv non trovati — prima premi Configura tutto."));
        connectClient(req.params.id, keys);
        rememberClient(req.params.id, true);
        res.json({ ok: true, connected: keys });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/client/:id", (req, res) => {
    if (!CLIENTS[req.params.id]) return res.status(404).json({ error: "Unknown assistant." });
    try {
        disconnectClient(req.params.id);
        rememberClient(req.params.id, false);   // and do not put it back
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/open/:key", (req, res) => {
    const a = APPS[req.params.key];
    if (!a) return res.status(404).json({ error: "unknown app" });
    const bundle = appBundle(a.appGlob);
    if (!bundle) return res.status(404).json({ error: L(`${a.label} isn't installed`, `${a.label} non è installato`) });
    execFile("/usr/bin/open", ["-a", bundle]);
    focusApp(bundle);
    res.json({ ok: true });
});

// Quit Claude, write the config while it is closed, then reopen it. This is the
// only reliable way to connect Claude Desktop — see claudeRunning() above.
// Changing which apps are registered only takes effect when an assistant
// starts, so the app should be able to do the restarting rather than telling
// someone to go and do it.
//
// SIGTERM rather than an AppleScript quit: "tell application X to quit" needs
// Automation permission, granted to whichever process asks, which is the trap
// that made window arranging silently do nothing for weeks. A TERM is what
// Quit sends anyway, and needs no permission.
const ASSISTANT_APPS = { claude: "Claude", chatgpt: "ChatGPT" };

app.post("/api/restart-assistants", async (req, res) => {
    const want = (req.body && Array.isArray(req.body.which))
        ? req.body.which : Object.keys(ASSISTANT_APPS);
    const restarted = [];
    for (const key of want) {
        const name = ASSISTANT_APPS[key];
        if (!name) continue;
        const bundle = path.join("/Applications", name + ".app");
        if (!fs.existsSync(bundle) || !bundleRunning(bundle)) continue;
        try {
            execFileSync("/usr/bin/pkill", ["-TERM", "-f", path.join(bundle, "Contents", "MacOS")],
                { stdio: "ignore", timeout: 5000 });
        } catch { /* it went away on its own */ }
        for (let i = 0; i < 40 && bundleRunning(bundle); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
        // Claude Desktop writes its whole config back as it quits, dropping
        // what setup wrote while it was open. Put it back before it starts.
        repairClientPaths();
        execFile("/usr/bin/open", ["-a", bundle]);
        restarted.push(name);
    }
    res.json({ ok: true, restarted });
});

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
const UDT_HOST = { photoshop: "PS", premiere: "premierepro", indesign: "ID" };
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

        // The service's appId is the same string the workspace uses as hostParam
        // — "PS", "premierepro". A separate map of guesses had "PPRO" for
        // Premiere, which matched nothing.
        const want = String(UDT_HOST[key] || "").toUpperCase();
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
            if (m.command === "didAddRuntimeClient" && m.app && want &&
                String(m.app.appId || "").toUpperCase() === want) {
                hostId = m.id;
            }
            if (m.command === "didCompleteConnection") {
                if (!hostId) {
                    // An Adobe app joins this service when IT starts, so one
                    // that was already open before the Developer Tool existed
                    // never connects, and the tool shows no row for it at all.
                    return done(new Error(`${APPS[key].label} isn't connected to Adobe's `
                        + `Developer Tool. Quit and reopen ${APPS[key].label} \u2014 it only `
                        + "connects if the Developer Tool was already running when it started."));
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

// Set up for this app: the workspace entry is what the Developer Tool loads.
function uxpRegistered(key) {
    try {
        return (readJSON(UDT_WORKSPACE, { plugins: [] }).plugins || [])
            .some((p) => p.hostParam === UDT_HOST[key]);
    } catch { return false; }
}

// -g: don't take focus. -j: start hidden. It is a background service as far
// as anyone using this is concerned, not a window they asked for.
function startUdtHidden() {
    const udt = appBundle(UDT_GLOB);
    if (!udt) return false;
    execFile("/usr/bin/open", ["-g", "-j", "-a", udt]);
    return true;
}

let udtStartedAt = 0;

async function autoLoadUxp() {
    // Photoshop and Premiere join the Developer Tool ONLY if it was already
    // running when they started. This used to start it once the Adobe app was
    // open — the one order that never works — so opening Premiere and then
    // asking Claude for something left the panel dead until Premiere was
    // restarted. Keep it up beforehand instead, whenever a UXP app is switched
    // on and set up, so whichever order someone opens things in, it's there.
    const wantUdt = Object.keys(APPS).some((k) => APPS[k].kind === "uxp"
        && registerableApps().includes(k) && uxpRegistered(k));
    if (wantUdt && !udtRunning() && Date.now() - udtStartedAt > 10 * 60 * 1000) {
        if (startUdtHidden()) udtStartedAt = Date.now();
    }

    for (const [key, a] of Object.entries(APPS)) {
        if (a.kind !== "uxp") continue;

        const state = autoLoad[key] || (autoLoad[key] = { next: 0, wait: 15000 });
        if (!appRunning(key)) { state.next = 0; state.wait = 15000; continue; }
        if (panelLive(key)) { state.wait = 15000; continue; }
        if (Date.now() < state.next) continue;

        if (!uxpRegistered(key)) { state.next = Date.now() + 60000; continue; }

        // The service belongs to the Developer Tool, so it has to be running.
        if (!udtRunning()) {
            if (!startUdtHidden()) { state.next = Date.now() + 60000; continue; }
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
    return bundleRunning(appBundle(UDT_GLOB));
}

// A request for Photoshop or Premiere that finds no panel used to fail at
// once with "open Window → UXP Plugins → …" — a menu item that only exists
// once the plugin is loaded, so the instruction could not be followed. The
// hub can load it, so do that first, and only fail with the real reason.
// One attempt per app at a time; concurrent requests wait on the same one.
const ensuring = {};

function ensureUxpPanel(key) {
    if (panelLive(key)) return Promise.resolve();
    return ensuring[key] || (ensuring[key] = (async () => {
        const label = APPS[key].label;
        if (!appRunning(key)) throw new Error(`${label} isn't open. Open it, then ask again.`);
        if (!uxpRegistered(key)) {
            throw new Error(`${label} isn't set up yet. In Moskito Easy MCP, press Set up next to ${label}.`);
        }
        if (!appBundle(UDT_GLOB)) {
            throw new Error(`${label} needs Adobe's free UXP Developer Tool: `
                + "https://www.adobe.com/download/uxp-developer-tools");
        }
        if (!udtRunning()) {
            startUdtHidden();
            await waitFor(() => udtRunning(), 15);
        }
        // Clear the background loader's backoff too: it may be sitting out
        // five minutes after an earlier failure.
        if (autoLoad[key]) { autoLoad[key].next = 0; autoLoad[key].wait = 15000; }
        // Three, not more: each try can take 25 s if the tool never answers,
        // and the assistant's side gives up at 120.
        await loadWhenReady(key, 3);
        if (!(await waitFor(() => panelLive(key), 10))) {
            throw new Error(`The ${label} panel loaded but didn't connect. Quit and reopen ${label}.`);
        }
    })().finally(() => { delete ensuring[key]; }));
}

// setupUxp has just restarted the Developer Tool, and its service takes a
// moment to come up. Worth a few tries before deciding it cannot be done.
// Launching an Adobe app takes 10-30 seconds on a cold machine, and the
// Developer Tool's service a few more after that. Setup used to fire `open`
// and ask immediately, so a fresh install was always told to finish the job
// itself. Wait for them.
async function waitFor(check, seconds) {
    for (let i = 0; i < seconds * 2; i++) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return check();
}

async function loadWhenReady(key, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
        try { return await loadUxpPlugin(key); }
        catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw last;
}

app.post("/api/load-uxp/:key", async (req, res) => {
    if (!APPS[req.params.key]) return res.status(404).json({ error: "Unknown app." });
    try {
        // Pressed straight after setup restarted the Developer Tool, its
        // service isn't up for a few seconds: one try failed every time.
        const key = req.params.key;
        if (!appRunning(key)) throw new Error(L(`${APPS[key].label} isn't open. Open it, then try again.`, `${APPS[key].label} non è aperto. Aprilo e riprova.`));
        if (!udtRunning()) startUdtHidden();
        res.json(await loadWhenReady(key, 5));
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
// Is this bundle's application running?
//
// ps, not pgrep. `pgrep -f` does not match the main application process on
// macOS: with Claude open, "Claude.app/Contents" matched fifteen helper
// processes and "Claude.app/Contents/MacOS" matched none, while ps listed
// /Applications/Claude.app/Contents/MacOS/Claude plainly. Everything asking
// "is this app open" was therefore answering no for some apps, silently.
//
// A failure to ASK is also not a no: the first Set up once reported a running
// Photoshop as closed because the probe timed out on a busy machine. Only a
// clean listing that lacks the path counts as not running.
function bundleRunning(bundle) {
    if (!bundle) return false;
    const probe = path.join(bundle, "Contents", "MacOS");
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const out = execFileSync("/bin/ps", ["-Ao", "command"],
                { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
            return out.includes(probe);
        } catch { /* could not ask: try once more */ }
    }
    console.log(`\u26a0 couldn't tell whether ${path.basename(bundle)} is running`);
    return false;
}

function appRunning(key) {
    return bundleRunning(appBundle(APPS[key].appGlob));
}

// quiet: Set everything up. Register only, and keep the Developer Tool running
// hidden; the panel then loads by itself whenever the app is opened (see
// autoLoadUxp). Not quiet: the per-app guide, which wants both on screen.
async function setupUxp(key, quiet = false) {
    const engine = findEngine();
    if (!engine) throw new Error("Can't find the adb-mcp engine folder.");
    const manifest = path.join(engine, "uxp", APPS[key].uxp, "manifest.json");
    if (!fs.existsSync(manifest)) throw new Error(`Plugin source missing: ${manifest}`);

    // The Developer Tool OWNS this file: it reads it at startup and writes its
    // own copy back when it quits. Registering Premiere while it was running
    // looked fine on disk, showed no row, and was then silently erased on quit.
    // So close it first, write, and start it again — it does not unload any
    // plugin it has already loaded, so nothing is lost by this.
    if (udtRunning()) {
        try { execFileSync("/usr/bin/pkill", ["-f", path.join(appBundle(UDT_GLOB), "Contents", "MacOS")]); }
        catch { /* already gone */ }
        for (let i = 0; i < 25 && udtRunning(); i++) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    const ws = readJSON(UDT_WORKSPACE, { version: 1, plugins: [] });
    // Also drop entries we retired, and any whose manifest is gone — a plugin
    // pointing at a deleted app shows up as a broken row the user cannot
    // explain. There were two, left by an earlier name for this app.
    ws.plugins = (ws.plugins || []).filter(
        (p) => p.hostParam !== UDT_HOST[key]
            && p.manifestPath !== manifest
            && fs.existsSync(p.manifestPath || "")
    );
    ws.plugins.push({ manifestPath: manifest, pluginOptions: { breakOnStart: false }, hostParam: UDT_HOST[key] });
    writeJSON(UDT_WORKSPACE, ws);

    // The tool first, then the app: the app only joins a Developer Tool that
    // was already running when it started, so this order needs no restart.
    const udt = appBundle(UDT_GLOB);
    if (udt) {
        if (quiet) startUdtHidden(); else execFile("/usr/bin/open", ["-a", udt]);
    }
    const wasClosed = !appRunning(key);
    if (wasClosed && !quiet) {
        await waitFor(() => udtRunning(), 15);
        const bundle = appBundle(APPS[key].appGlob);
        if (bundle) execFile("/usr/bin/open", ["-a", bundle]);
    }
    if (!udt) {
        return { ok: true, udtMissing: true, wasClosed,
                 message: L("Install Adobe's free UXP Developer Tool from Creative Cloud, then press Set up again.",
                            "Installa UXP Developer Tool, gratuito, da Creative Cloud, poi premi di nuovo Configura.") };
    }
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
    if (!bundle) return res.status(404).json({ error: L("The UXP Developer Tool isn't installed.", "UXP Developer Tool non è installato.") });
    execFile("/usr/bin/open", ["-a", bundle]);   // launches it if it is closed
    focusApp(bundle);                            // and this is what fronts it
    res.json({ ok: true });
});

// Adobe's own download page for the tool: it starts the installer, which
// brings Creative Cloud with it if it isn't there. One window that does the
// job, where this used to open Creative Cloud AND a guide to read — and the
// guide's URL was a 404.
//
// adobe.com answers 200 with the same 67KB shell for any name under
// /download/, so this was checked in a browser, not with curl: it renders as
// "Install UXP Developer Tools | Adobe".
function openUdtHelp() {
    execFile("/usr/bin/open", ["https://www.adobe.com/download/uxp-developer-tools"]);
}

// Fixed table: the page names an assistant, never a URL.
app.post("/api/download/:which", (req, res) => {
    const url = ASSISTANT_DOWNLOADS[req.params.which];
    if (!url) return res.status(404).json({ error: "Unknown assistant." });
    execFile("/usr/bin/open", [url]);
    res.json({ ok: true });
});

app.post("/api/uxp-help", (_req, res) => {
    openUdtHelp();
    res.json({ ok: true });
});

app.post("/api/uxp/:key", async (req, res) => {
    if (!APPS[req.params.key]) return res.status(404).json({ error: "Unknown app." });
    try {
        res.json(await setupUxp(req.params.key));
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
let setupOnLaunch = false;
app.post("/api/setup", async (_req, res) => {
    setupOnLaunch = false;
    const done = [];
    const todo = [];
    const failed = [];
    const udtMissing = [];
    const notes = [];     // done, but with one thing for them to do
    try {
        await new Promise((resolve) => ensureVenv(() => resolve()));
        if (!venvReady) {
            return res.status(500).json({
                error: (venvError || L("The Python environment isn't ready.", "L'ambiente Python non è pronto.")) +
                       L(" Nothing was connected, so you won't get silent failures later.",
                         " Non è stato collegato niente, così non avrai errori silenziosi dopo."),
            });
        }
        // No Accessibility prompt here: it is for Arrange windows only, which
        // asks on first use, and it was the first thing setup threw up.

        // Only what the user has switched on. Setting up an unticked app and
        // then reporting it as unfinished business was asking them to go and
        // fix something they had deliberately turned off.
        const wanted = registerableApps();
        for (const [key, a] of Object.entries(APPS)) {
            if (!wanted.includes(key)) continue;
            try {
                if (a.kind === "cep") {
                    installPanel(key);
                    // CEP reads its panels at launch: an app that is open now
                    // shows nothing until it is reopened.
                    done.push(a.label);
                    if (appRunning(key) && !panelLive(key)) notes.push(L(`Reopen ${a.label} to see its panel`, `Riapri ${a.label} per vedere il pannello`));
                } else {
                    // Nothing is opened. The panel loads by itself the next time
                    // the app is opened; one that is open now gets it loaded here.
                    const r = await setupUxp(key, true);
                    if (r.udtMissing) {
                        udtMissing.push(a.label);
                    } else if (!appRunning(key)) {
                        done.push(a.label);
                    } else {
                        await waitFor(() => udtRunning(), 20);
                        done.push(a.label);
                        try { await loadWhenReady(key, 3); }
                        catch { notes.push(L(`Reopen ${a.label} to load its panel`, `Riapri ${a.label} per caricare il pannello`)); }
                    }
                    if (key === "photoshop" && !panelLive(key) && !r.udtMissing) {
                        notes.push(L("Photoshop needs Developer Mode on once: Settings \u2192 Plugins "
                                + "\u2192 Enable Developer Mode, then reopen it",
                                "Photoshop vuole la modalità sviluppatore attiva, una volta sola: Impostazioni "
                                + "\u2192 Plug-in \u2192 Abilita modalità sviluppatore, poi riaprilo"));
                    }
                }
            } catch (e) {
                failed.push(`${a.label} (${e.message})`);
            }
        }
        // Once, after every app is registered, rather than stopping at the first.
        if (udtMissing.length) {
            openUdtHelp();
            todo.push(L(`${udtMissing.join(", ")} need${udtMissing.length > 1 ? "" : "s"} Adobe's free `
                    + "UXP Developer Tool. Its download page is open \u2014 install it, then press Set up again",
                    `Per ${udtMissing.join(", ")} serve UXP Developer Tool, gratuito, di Adobe. `
                    + "La pagina per scaricarlo è aperta \u2014 installalo, poi premi di nuovo Configura tutto"));
        }
        const keys = registerableApps();
        const wired = [];
        for (const id of Object.keys(CLIENTS)) {
            // Only assistants that are really installed; see clientInstalled.
            if (!clientInstalled(id)) continue;
            try {
                connectClient(id, keys);
                rememberClient(id, true);
                wired.push(CLIENTS[id].label);
            } catch (e) {
                failed.push(`${CLIENTS[id].label} (${e.message})`);
            }
        }
        // Two parts, because the toast shows a heading and a line: what
        // happened, then anything still outstanding. The old single string put
        // four clauses in one paragraph and ended "panel..", because the
        // messages being joined already had their own full stops.
        const and = (list) => new Intl.ListFormat(L("en", "it")).format(list);
        const incomplete = !done.length && (todo.length || failed.length) > 0;
        const title = done.length
            ? L(`${and(done)} ready`, `${and(done)}: ${done.length > 1 ? "pronti" : "pronto"}`)
            : incomplete ? L("Setup didn't finish", "Configurazione non completata")
                : L("Nothing to set up", "Niente da configurare");
        const rest = [...todo, ...failed, ...notes].map((t) => String(t).replace(/\.$/, ""));
        // Name only the assistants that are there, and say so when none is.
        const names = [Object.keys(CLIENTS).some((id) => id !== "codex" && clientInstalled(id)) && "Claude",
                       clientInstalled("codex") && "ChatGPT"].filter(Boolean);
        const body = rest.length
            ? rest.join(". ") + "."
            : names.length
                ? L(`Restart ${and(names)} and ${names.length > 1 ? "they" : "it"} can drive your apps.`,
                    `Riavvia ${and(names)} e ${names.length > 1 ? "potranno" : "potrà"} usare le tue app.`)
                : L("Now install Claude or ChatGPT — the buttons are on this page — and press Set up again.",
                    "Ora installa Claude o ChatGPT — i pulsanti sono in questa pagina — e premi di nuovo Configura tutto.");
        // The page reads these rather than matching words that are now in two languages.
        res.json({ ok: true, title, body, incomplete, onlyRestart: !rest.length && names.length > 0,
                   restart: wired.length > 0,
                   message: `${title}. ${body}`, done, todo, wired, failed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/update", async (_req, res) => {
    try {
        if (!staged) await stageUpdate();   // pressed before the background fetch got there
        applyUpdate();
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
        return res.status(500).json({ error: L("Couldn't remove the old environment: ", "Non riesco a rimuovere il vecchio ambiente: ") + e.message });
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

// The two pages learn their language from <html lang>, set here, so their
// first paint is already in it.
app.get(["/", "/index.html", "/help.html"], (req, res) => {
    const file = req.path === "/help.html" ? "help.html" : "index.html";
    res.set("Cache-Control", "no-store").type("html")
        .send(fs.readFileSync(path.join(HERE, file), "utf8").replace('<html lang="en">', `<html lang="${L("en", "it")}">`));
});

// No caching: the control window is a long-lived WKWebView, and a cached
// index.html there outlives every update to it. Nothing here is fetched over
// a network worth saving bytes on.
app.use(express.static(HERE, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

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

// `node hub.js --uninstall`, run by uninstall.sh with the app already quit (so
// repairClientPaths can't put anything back): take out everything we put
// outside our own folder. Removing that folder and the app is the script's job.
if (process.argv[2] === "--uninstall") {
    const step = (what, fn) => { try { fn(); console.log("✓ " + what); }
                                 catch (e) { console.log(`⚠ ${what}: ${e.message}`); } };
    for (const id of Object.keys(CLIENTS)) step(CLIENTS[id].label, () => disconnectClient(id));
    for (const a of Object.values(APPS)) {
        if (a.cep) step(`${a.label} panel`, () => fs.rmSync(path.join(CEP_DIR, a.cep), { recursive: true, force: true }));
    }
    step("After Effects startup script", () => aeStartupScript(false));
    step("UXP Developer Tool list", () => {
        if (!fs.existsSync(UDT_WORKSPACE)) return;
        const ws = readJSON(UDT_WORKSPACE, {});
        ws.plugins = (ws.plugins || []).filter((p) => !/\/Contents\/Resources\/engine\/uxp\//.test(p.manifestPath || ""));
        writeJSON(UDT_WORKSPACE, ws);
    });
    // Last, because every write above leaves one of these beside the file.
    for (const file of [...Object.values(CLIENTS).map((c) => c.file), UDT_WORKSPACE]) {
        const prefix = path.basename(file) + ".adobe-mcp-backup-";
        try {
            for (const n of fs.readdirSync(path.dirname(file))) {
                if (n.startsWith(prefix)) fs.rmSync(path.join(path.dirname(file), n), { force: true });
            }
        } catch { /* folder isn't there */ }
    }
    process.exit(0);
}

// "127.0.0.1", not the default of every interface: this is a local control
// surface, and binding publicly also triggers the macOS incoming-connections
// prompt, which a colleague who clicks Deny can never recover from.
server.listen(PORT, "127.0.0.1", () => {
    const pending = stagedOnDisk();
    if (pending) {
        console.log(`\u2192 installing ${pending.version}, downloaded earlier`);
        staged = pending;
        return applyUpdate();
    }
    // The menu bar app decides when to show the panel — first run, its menu
    // item, or reopening the app. The hub never opens a tab on its own.
    console.log(`Moskito Easy MCP ${VERSION}  \u2192  ${URL}`);
    fs.mkdirSync(SUPPORT, { recursive: true });
    // The .pkg installer leaves this marker: the person double-clicked an
    // installer and expects to be done, so open the window and let it press
    // "Set everything up" itself (index.html). One shot — the marker goes now.
    try {
        fs.unlinkSync(path.join(SUPPORT, "setup-on-launch"));
        setupOnLaunch = true;
        setTimeout(() => fs.writeFileSync(path.join(SUPPORT, "show-window"), String(Date.now())), 3000).unref();
    } catch {}
    refreshPanels();
    ensureVenv(() => repairClientPaths());
    // Claude Desktop is skipped while it is open, so keep checking: the moment
    // it closes, its config gets fixed without the user doing anything.
    setInterval(repairClientPaths, 30000).unref();
    refreshPanelOpen();
    setInterval(refreshPanelOpen, 5000).unref();
    setInterval(autoLoadUxp, 5000).unref();
    // Also settles the id on first run, and clears the stale "enabled" key,
    // rather than waiting for the first flush fifteen minutes later.
    analyticsState();
    // Once shortly after starting, as well as every 15 minutes. On the interval
    // alone, anyone who opened the app, did a job and quit inside 15 minutes
    // never reported at all — so they were not an install either.
    setTimeout(sendAnalytics, 60 * 1000).unref();
    setInterval(sendAnalytics, 15 * 60 * 1000).unref();
    // Give the app a moment to finish starting — panels, venv, config repair —
    // before it considers restarting itself.
    setTimeout(autoUpdate, 45000);
    // Every five minutes, not every six hours. checkForUpdate caches the
    // GitHub call for six hours, so this costs nothing — it just means that
    // once there IS an update, it goes in at the first quiet ten minutes
    // instead of whenever the next six-hourly tick happens to find one.
    setInterval(autoUpdate, 5 * 60 * 1000);
});
