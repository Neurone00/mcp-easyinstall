/* ---------------------------------------------------------------------------
 * Moskito Easy MCP — UXP panel front-end.
 *
 * Appended to the UXP plugin's main.js at build time, not injected as a second
 * script, because main.js is a module: `socket`, `APPLICATION` and
 * connectToServer() are module-scope, and a separate <script> cannot see any
 * of them.
 *
 * The CEP add-on cannot be reused here. UXP is not a browser: there is no
 * window.cep, no <details>, no reliable inline SVG, and layout is a subset of
 * CSS. So this is a smaller build of the same idea — the same actions, in the
 * same order, over the same hub protocol — rather than a shared file pretending
 * two environments are one.
 * ------------------------------------------------------------------------- */

(function () {
    "use strict";

    var LABELS = {
        photoshop: "Photoshop", premiere: "Premiere Pro",
        illustrator: "Illustrator", aftereffects: "After Effects",
    };
    var APP = (typeof APPLICATION !== "undefined" && LABELS[APPLICATION]) || "this app";

    /* ------------------------------------------------- talking to the hub -- */

    var pending = {};
    var reqId = 0;

    function hubRequest(payload, done) {
        if (typeof socket === "undefined" || !socket || !socket.connected) {
            return done({ ok: false, error: "Connect the panel first." });
        }
        var id = "u" + (++reqId);
        pending[id] = done;
        payload.id = id;
        payload.application = APPLICATION;
        socket.emit("app_request", payload);
        setTimeout(function () {
            if (pending[id]) { delete pending[id]; done({ ok: false, error: "No reply from Moskito Easy MCP." }); }
        }, 25000);
    }

    // socket is null until the panel connects, and is replaced on reconnect,
    // so bind whenever we meet one we have not seen.
    function bindSocketOnce() {
        if (typeof socket === "undefined" || !socket || socket._amcpBound) return;
        socket._amcpBound = true;
        socket.on("app_response", function (r) {
            var fn = r && r.id && pending[r.id];
            if (fn) { delete pending[r.id]; fn(r); }
        });
    }
    setInterval(bindSocketOnce, 1000);

    /* --------------------------------------------------------------- ui -- */

    function el(tag, style, text) {
        var n = document.createElement(tag);
        if (style) n.setAttribute("style", style);
        if (text) n.textContent = text;
        return n;
    }

    var ROW = "display:flex;gap:6px;margin:0 0 6px";
    var BTN = "flex:1";

    var ui = el("div", "margin:0 0 10px");

    var status = el("div", "font-size:11px;margin:0 0 8px;opacity:.75", "");
    function say(text) {
        status.textContent = text;
        if (text) setTimeout(function () {
            if (status.textContent === text) status.textContent = "";
        }, 3000);
    }

    function action(label, onClick) {
        // sp-button, not <button>: Spectrum components are what UXP renders
        // reliably, and they pick up the host app's theme for free.
        var b = document.createElement("sp-button");
        b.setAttribute("variant", "secondary");
        b.setAttribute("style", BTN);
        b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
    }

    var askRow = el("div", ROW);
    askRow.appendChild(action("Ask Claude", function () { ask("Claude"); }));
    askRow.appendChild(action("Ask ChatGPT", function () { ask("ChatGPT"); }));

    function ask(name) {
        say("Opening " + name + "…");
        bindSocketOnce();
        hubRequest({ type: "open_assistant", which: name }, function (r) {
            say(r && r.ok ? "" : (r && r.error) || ("Couldn't open " + name));
        });
    }

    var arrangeRow = el("div", ROW);
    var arrangeBtn = action("Arrange windows", function () {
        arrangeBtn.setAttribute("disabled", "true");
        say("Arranging…");
        bindSocketOnce();
        hubRequest({ type: "arrange", split: 0.8 }, function (r) {
            arrangeBtn.removeAttribute("disabled");
            if (r && r.ok) return say("Arranged " + (r.layout || "80/20"));
            say((r && r.error) || "Couldn't arrange the windows");
            if (r && r.needsAccessibility) hubRequest({ type: "open_accessibility" }, function () {});
        });
    });
    arrangeBtn.setAttribute("title", APP + " on the left, Claude and ChatGPT on the right");
    arrangeRow.appendChild(arrangeBtn);

    var settings = el("div", ROW);
    settings.appendChild(action("Settings", function () {
        bindSocketOnce();
        hubRequest({ type: "open_panel" }, function (r) {
            say(r && r.ok ? "" : "Open Moskito Easy MCP from the menu bar.");
        });
    }));

    ui.appendChild(askRow);
    ui.appendChild(arrangeRow);
    ui.appendChild(settings);
    ui.appendChild(status);

    // Above the upstream Connect button, which is the rarely-wanted control,
    // for the same reason it sits behind a menu in the CEP panels.
    if (document.body.firstChild) {
        document.body.insertBefore(ui, document.body.firstChild);
    } else {
        document.body.appendChild(ui);
    }
}());
