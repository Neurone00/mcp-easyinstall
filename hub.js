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
const HERE = __dirname;
const SETTINGS = path.join(HERE, "settings.json");

/* ---------------------------------------------------------------- engine -- */

// Where the adb-mcp checkout lives. Remembered in settings.json once found.
function findEngine() {
    const saved = readJSON(SETTINGS, {}).enginePath;
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

function readJSON(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".adobe-mcp-backup");
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* --------------------------------------------------------- mcp server defs -- */

// The command an AI client runs to start one app's MCP server.
function serverDef(key) {
    const engine = findEngine();
    const uv = findUv();
    if (!engine || !uv) return null;
    return {
        command: uv,
        args: [
            "run", "--directory", path.join(engine, "mcp"),
            "--with", "fonttools",
            "--with", "python-socketio",
            "--with", "mcp",
            "--with", "requests",
            "--with", "websocket-client",
            "--with", "pillow",
            "mcp", "run", APPS[key].mcp,
        ],
        env: {},
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

function connectedApps(clientId) {
    const c = CLIENTS[clientId];
    if (!fs.existsSync(c.file)) return [];
    if (c.format === "json") {
        const servers = readJSON(c.file, {})[c.key] || {};
        return Object.keys(APPS).filter((k) => servers[k]);
    }
    const toml = fs.readFileSync(c.file, "utf8");
    return Object.keys(APPS).filter((k) => toml.includes(`[${c.key}.${k}]`));
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
            return `[${c.key}.${k}]\ncommand = ${JSON.stringify(d.command)}\nargs = [${d.args
                .map((a) => JSON.stringify(a))
                .join(", ")}]`;
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
let warmed = false;
function warmUp() {
    if (warmed) return;
    const engine = findEngine(), uv = findUv();
    if (!engine || !uv) return;
    warmed = true;
    execFile(uv, ["run", "--directory", path.join(engine, "mcp"),
        "--with", "fonttools", "--with", "python-socketio", "--with", "mcp",
        "--with", "requests", "--with", "websocket-client", "--with", "pillow",
        "python", "-c", "print('warm')"], { timeout: 300000 },
        (err) => console.log(err ? "\u26a0 warm-up failed: " + err.message : "\u2713 Python runtime ready"));
}

/* ------------------------------------------------------------- the proxy -- */

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 50 * 1024 * 1024,
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
app.post("/api/setup", (_req, res) => {
    const done = [];
    const todo = [];
    const failed = [];
    try {
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
        warmUp();

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

app.post("/api/quit", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
});

app.use(express.static(HERE));

const URL = `http://localhost:${PORT}`;

server.on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    // Already running (or the old adb-mcp proxy has the port). Just show the window.
    console.log("Adobe MCP is already running \u2014 opening the dashboard.");
    execFile("/usr/bin/open", [URL]);
    process.exit(0);
});

server.listen(PORT, () => {
    console.log(`Adobe MCP  \u2192  ${URL}`);
    execFile("/usr/bin/open", [URL]);
});
