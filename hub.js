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
        panelMenu: "Plugins → MCP Agent",
    },
    illustrator: {
        label: "Illustrator",
        kind: "cep", cep: "com.mikechambers.ai", mcp: "ai-mcp.py",
        appGlob: "Adobe Illustrator",
        panelMenu: "Window → Extensions → MCP Agent",
    },
    aftereffects: {
        label: "After Effects",
        kind: "cep", cep: "com.mikechambers.ae", mcp: "ae-mcp.py",
        appGlob: "Adobe After Effects",
        panelMenu: "Window → Extensions → MCP Agent",
    },
    premiere: {
        label: "Premiere Pro",
        kind: "uxp", uxp: "pr", mcp: "pr-mcp.py",
        appGlob: "Adobe Premiere Pro",
        panelMenu: "Window → MCP Agent",
    },
    indesign: {
        label: "InDesign",
        kind: "uxp", uxp: "id", mcp: "id-mcp.py",
        appGlob: "Adobe InDesign",
        panelMenu: "Plugins → MCP Agent",
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

function appInstalled(glob) {
    return !!appBundle(glob);
}

function panelInstalled(key) {
    const a = APPS[key];
    if (a.kind === "cep") return fs.existsSync(path.join(CEP_DIR, a.cep));
    // UXP plugins are loaded through Adobe's UXP Developer Tool, which keeps no
    // predictable on-disk marker. A live socket connection is the real signal.
    return null;
}

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
    // TOML: manage one delimited block so hand-written config is never clobbered.
    const START = "# >>> adobe-mcp >>>";
    const END = "# <<< adobe-mcp <<<";
    const body = keys
        .map((k) => {
            const d = serverDef(k);
            const env = Object.entries(d.env || {})
                .map(([ek, ev]) => `${ek} = ${JSON.stringify(ev)}`)
                .join(", ");
            return `[${c.key}.${k}]\ncommand = ${JSON.stringify(d.command)}\nargs = [${d.args
                .map((a) => JSON.stringify(a))
                .join(", ")}]` + (env ? `\nenv = { ${env} }` : "");
        })
        .join("\n\n");
    const block = `${START}\n# Managed by Adobe MCP Hub. Edits inside this block are overwritten.\n${body}\n${END}`;
    let toml = fs.existsSync(c.file) ? fs.readFileSync(c.file, "utf8") : "";
    if (fs.existsSync(c.file)) fs.copyFileSync(c.file, c.file + ".adobe-mcp-backup");
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    toml = re.test(toml) ? toml.replace(re, block) : (toml.trimEnd() + "\n\n" + block + "\n");
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.writeFileSync(c.file, toml.trimStart());
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
    fs.copyFileSync(c.file, c.file + ".adobe-mcp-backup");
    const toml = fs
        .readFileSync(c.file, "utf8")
        .replace(/# >>> adobe-mcp >>>[\s\S]*?# <<< adobe-mcp <<</, "")
        .trimStart();
    fs.writeFileSync(c.file, toml);
}

// Claude Desktop keeps its config in memory and writes the whole file back when
// it quits, silently undoing anything we wrote while it was open. So the write
// has to happen while it is closed.
function claudeRunning() {
    try {
        execFileSync("/usr/bin/pgrep", ["-x", "Claude"], { stdio: ["ignore", "pipe", "ignore"] });
        return true;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------- panel installing -- */

function installPanel(key) {
    const a = APPS[key];
    const engine = findEngine();
    if (!engine) throw new Error("Can't find the adb-mcp engine folder.");
    if (a.kind !== "cep") throw new Error("uxp");

    const src = path.join(engine, "cep", a.cep);
    if (!fs.existsSync(src)) throw new Error(`Panel source missing: ${src}`);
    fs.mkdirSync(CEP_DIR, { recursive: true });
    fs.cpSync(src, path.join(CEP_DIR, a.cep), { recursive: true, force: true });

    // Adobe refuses to load unsigned panels unless debug mode is on.
    for (const v of ["10", "11", "12", "13"]) {
        try {
            execFileSync("/usr/bin/defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
        } catch { /* version not present on this machine */ }
    }
}

function debugModeOn() {
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
}

// First `uv run` downloads Python and the PyPI deps. Do it now, in the
// background, so the first thing the user asks Claude doesn't time out.
// Pinned deliberately.
//   [cli]  pulls typer, which `mcp run` needs; plain "mcp" leaves a fresh
//          environment unable to start a server at all.
//   <2     the engine is MCP v1 code. mcp 2.x renamed FastMCP to MCPServer,
//          so an unpinned install now fails on `from mcp.server.fastmcp
//          import FastMCP` — which broke every new install the day 2.0
//          shipped, while existing venvs carried on working.
const PY_DEPS = ["fonttools", "python-socketio", "mcp[cli]<2", "requests",
                 "websocket-client", "pillow"];
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
        execFileSync(py, ["-c", "import mcp, socketio, requests, PIL, fontTools, websocket"],
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

    execFile(uv, ["venv", VENV], { timeout: 300000 }, (e1) => {
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
function repairClientPaths() {
    const want = serverDef(Object.keys(APPS)[0]);
    if (!want) return;
    for (const id of Object.keys(CLIENTS)) {
        const connected = connectedApps(id);
        if (!connected.length) continue;
        // Claude Desktop would overwrite us while it is open — leave it alone.
        if (id === "claude-desktop" && claudeRunning()) continue;
        // This runs on a 30s timer: anything thrown here is an uncaught
        // exception that kills the hub, so the read is inside the try too.
        let stale = false;
        try {
            if (CLIENTS[id].format === "json") {
                const servers = readJSON(CLIENTS[id].file, {})[CLIENTS[id].key] || {};
                stale = connected.some((k) => servers[k] &&
                    (servers[k].command !== want.command ||
                     !(servers[k].env || {}).PYTHONDONTWRITEBYTECODE));
            } else {
                const toml = fs.readFileSync(CLIENTS[id].file, "utf8");
                stale = !toml.includes(want.command) || !toml.includes("PYTHONDONTWRITEBYTECODE");
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
    res.status(403).json({ error: "Adobe MCP only accepts requests from its own window." });
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
        socket.data.application = application;
        (applicationClients[application] ||= new Set()).add(socket.id);
        socket.emit("registration_response", {
            type: "registration",
            status: "success",
            message: `Registered for ${application}`,
        });
        console.log(`✓ ${application} panel connected`);
    });

    socket.on("command_packet_response", ({ packet }) => {
        if (packet.senderId) io.to(packet.senderId).emit("packet_response", packet);
    });

    socket.on("command_packet", ({ application, command }) => {
        const packet = { senderId: socket.id, application, command };
        const clients = applicationClients[application];
        if (!clients) return console.log(`⚠ no panel open for ${application}`);
        clients.forEach((id) => io.to(id).emit("command_packet", packet));
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
    try {
        installPanel(req.params.key);
        res.json({ ok: true });
    } catch (e) {
        res.status(e.message === "uxp" ? 400 : 500).json({ error: e.message });
    }
});

app.post("/api/client/:id", (req, res) => {
    try {
        const keys = registerableApps();
        if (!serverDef(keys[0])) throw new Error("Engine or uv not found — run Setup first.");
        connectClient(req.params.id, keys);
        res.json({ ok: true, connected: keys });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/client/:id", (req, res) => {
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
const UDT_HOST = { photoshop: "PS", premiere: "premierepro", indesign: "ID" };

// Register a UXP plugin in Adobe's Developer Tool so the user only has to press
// "Load". Adobe rejects unsigned .ccx packages outright (UPIA status -267), so
// this is as far as automation can go without an Adobe-signed plugin.
function setupUxp(key) {
    const engine = findEngine();
    if (!engine) throw new Error("Can't find the adb-mcp engine folder.");
    const manifest = path.join(engine, "uxp", APPS[key].uxp, "manifest.json");
    if (!fs.existsSync(manifest)) throw new Error(`Plugin source missing: ${manifest}`);

    const ws = readJSON(UDT_WORKSPACE, { version: 1, plugins: [] });
    ws.plugins = (ws.plugins || []).filter(
        (p) => p.hostParam !== UDT_HOST[key] && p.manifestPath !== manifest
    );
    ws.plugins.push({ manifestPath: manifest, pluginOptions: { breakOnStart: false }, hostParam: UDT_HOST[key] });
    writeJSON(UDT_WORKSPACE, ws);

    const udt = fs.readdirSync("/Applications").find((n) => n.startsWith("Adobe UXP Developer Tool"));
    if (!udt) {
        return { ok: true, udtMissing: true,
                 message: "Install Adobe's free UXP Developer Tool from Creative Cloud, then press Set up again." };
    }
    execFile("/usr/bin/open", ["-a", path.join("/Applications", udt)]);
    return { ok: true };
}

app.post("/api/uxp/:key", (req, res) => {
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

app.post("/api/quit", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
});

app.use(express.static(HERE));

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
setInterval(() => {
    if (process.ppid === 1) {
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
    console.log(`Adobe MCP ${VERSION}  \u2192  ${URL}`);
    fs.mkdirSync(SUPPORT, { recursive: true });
    refreshPanels();
    ensureVenv(() => repairClientPaths());
    // Claude Desktop is skipped while it is open, so keep checking: the moment
    // it closes, its config gets fixed without the user doing anything.
    setInterval(repairClientPaths, 30000).unref();
    checkForUpdate();
    setInterval(checkForUpdate, 6 * 3600 * 1000);
});
