/*
 * Adobe MCP — panel front-end.
 *
 * Injected into the adb-mcp CEP panels at build time (see build.sh). It rebuilds
 * the panel's layout around what a designer actually does, without touching the
 * upstream code that does the work: the original controls are still there, still
 * driving everything, just moved or folded away.
 *
 * The critique this answers, in short: the largest, brightest control was
 * Disconnect — the one thing nobody wants to press. A third of the panel was a
 * raw error log showing "Connection error" while the status said Connected. A
 * one-time preference sat there permanently. So: promote doing, demote undoing,
 * and let the log speak up only when it has something to say.
 */
(function () {
  "use strict";

  // The page title used to carry the host app's name; it now says "Moskito
  // Easy MCP" like everything else, so the app is read from main.js's own
  // APPLICATION constant instead.
  var LABELS = {
    illustrator: "Illustrator", aftereffects: "After Effects",
    premiere: "Premiere Pro", photoshop: "Photoshop",
  };
  var APP = (typeof APPLICATION !== "undefined" && LABELS[APPLICATION]) || "this app";
  var HUB = "http://localhost:3001/";

  function $(id) { return document.getElementById(id); }

  // CEP's createProcess returns {err, data} rather than throwing, so a plain
  // try/catch always reported success and the browser fallback never ran.
  function openApp(name) {
    try {
      var r = window.cep.process.createProcess("/usr/bin/open", "-a", name);
      if (r && typeof r.err !== "undefined") return r.err === 0;
      return !!r;
    } catch (e) { return false; }
  }

  function openUrl(url) {
    try { window.cep.util.openURLInDefaultBrowser(url); }
    catch (e) { window.open(url, "_blank"); }
  }

  /* ---------------------------------------------------------------- style -- */

  // Read the panel's actual background and decide from its luminance. Runs
  // again on a timer because Adobe can change panel brightness while open.
  function applyTheme() {
    var bg = window.getComputedStyle(document.body).backgroundColor || "";
    var m = bg.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    var dark = true;
    if (m) {
      var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      dark = lum < 0.5;
    }
    document.documentElement.setAttribute("data-amcp", dark ? "dark" : "light");
  }

  var css = document.createElement("style");
  css.textContent = [
    // Keyed off the PANEL's own background, not prefers-color-scheme. Adobe's
    // panel brightness is set in the app's own preferences and has nothing to
    // do with the OS setting: a dark Illustrator on a light-mode Mac reported
    // prefersDark:false while the panel behind this was rgb(42,42,42), so the
    // OS query produced light text boxes on a dark panel.
    "[data-amcp='dark']{--a-bg:#3a3a42;--a-line:#55555f;--a-ink:#ededf0;--a-soft:#a8a8b2;",
    "  --a-accent:#2855ff;--a-warn:#e8b45a;--a-ok:#4ade80}",
    "[data-amcp='light']{--a-bg:#ebebee;--a-line:#c2c2ca;--a-ink:#1d1d20;--a-soft:#55555f;",
    "  --a-accent:#2855ff;--a-warn:#8a5d00;--a-ok:#1f7a44}",

    ".amcp{font-size:12px;color:var(--a-ink)}",
    ".amcp button{font:inherit;font-size:12px;font-weight:600;padding:9px 10px;",
    "  border-radius:6px;border:1px solid var(--a-line);background:var(--a-bg);",
    "  color:var(--a-ink);cursor:pointer;transition:.12s}",
    ".amcp button:hover:not(:disabled){border-color:var(--a-soft)}",
    ".amcp button:focus-visible{outline:2px solid var(--a-accent);outline-offset:2px}",
    ".amcp button:disabled{opacity:.55;cursor:default}",
    ".amcp-row{display:flex;gap:6px;margin:0 0 8px}",
    ".amcp-row button{flex:1}",
    ".amcp-row button.icon{flex:0 0 36px;padding:9px 0;font-size:13px}",

    // Last activity: the strongest signal that any of this is actually working.
    ".amcp-act{display:flex;align-items:center;gap:6px;font-size:11px;",
    "  color:var(--a-soft);margin:0 0 10px;min-height:15px}",
    ".amcp-act b{color:var(--a-ink);font-weight:600}",
    ".amcp-act .spin{width:7px;height:7px;border-radius:50%;background:var(--a-ok);flex:none}",

    // Footer: help, settings, and the rarely-wanted things behind one menu.
    // At the top, not the bottom: these are how you reach everything that is
    // not one of the two main actions, so they should be found before them.
    ".amcp-foot{display:flex;align-items:center;gap:6px;margin:0 0 10px;",
    "  padding-bottom:9px;border-bottom:1px solid var(--a-line)}",
    ".amcp-foot button{border-color:transparent;background:transparent;color:var(--a-soft);",
    "  padding:7px 10px;font-weight:600;font-size:15px;min-width:38px;line-height:1}",
    ".amcp-foot button:hover{color:var(--a-ink);background:var(--a-bg)}",
    ".amcp-foot .sp{flex:1}",
    ".amcp-appicon{width:22px;height:22px;border-radius:5px;flex:none;margin-right:2px}",
    ".amcp-badge{display:inline-block;min-width:15px;padding:0 4px;margin-left:5px;",
    "  border-radius:8px;background:var(--a-warn);color:#1d1d20;font-size:10px;",
    "  font-weight:700;text-align:center}",

    ".amcp-sheet{margin:8px 0 0;padding:9px 10px;border:1px solid var(--a-line);",
    "  border-radius:6px;background:var(--a-bg);font-size:11px;line-height:1.5;color:var(--a-ink)}",
    ".amcp-sheet[hidden]{display:none}",
    ".amcp-sheet h4{margin:0 0 5px;font-size:11px;font-weight:700}",
    ".amcp-sheet ol,.amcp-sheet ul{margin:4px 0 8px;padding-left:15px}",
    ".amcp-sheet li{margin:3px 0}",
    ".amcp-sheet .ex{color:var(--a-soft);font-style:italic}",
    ".amcp-sheet .warn{color:var(--a-warn)}",
    ".amcp-sheet .menuitem{display:block;width:100%;text-align:left;margin:3px 0;",
    "  background:transparent;border-color:transparent;font-weight:500}",
    ".amcp-sheet .menuitem:hover{background:var(--a-line)}",
    ".amcp-sheet label{display:flex;gap:7px;align-items:flex-start;cursor:pointer}",
  ].join("");
  document.head.appendChild(css);
  applyTheme();
  setInterval(applyTheme, 4000);

  /* ------------------------------------------------------------ examples -- */

  var EXAMPLES = {
    "Illustrator": [
      "Make a 1080×1920 story with a bold headline",
      "Recolour everything to our brand palette",
      "Export each artboard as a 2× PNG"
    ],
    "After Effects": [
      "Add a Gaussian blur to the title and fade it in",
      "What effects are on this layer?",
      "Animate the logo's opacity over two seconds"
    ],
    "Premiere Pro": [
      "Build a rough cut with cross dissolves",
      "Add a marker every time the speaker changes"
    ],
    "Photoshop": [
      "Make an Instagram post that looks like a Polaroid",
      "Rename every layer to a consistent format"
    ]
  };

  /* ----------------------------------------------------------- structure -- */

  var host = document.querySelector(".container") || document.body;
  var connectBtn = $("btnConnect");
  var autoChk = $("chkConnectOnLaunch");
  var logSection = document.querySelector(".log-section");

  var ui = document.createElement("div");
  ui.className = "amcp";

  // --- primary actions
  var bar = document.createElement("div");
  bar.className = "amcp-row";

  // Two ways to do the same thing, so they look and read the same. Styling one
  // as the primary action said "use Claude", which is not ours to say.
  var claude = document.createElement("button");
  claude.textContent = "Ask Claude";
  claude.title = "Open the Claude desktop app, which can drive " + APP;
  claude.onclick = function () { if (!openApp("Claude")) openUrl("https://claude.ai/new"); };

  var gpt = document.createElement("button");
  gpt.textContent = "Ask ChatGPT";
  gpt.title = "Open the ChatGPT desktop app, which can drive " + APP;
  gpt.onclick = function () { if (!openApp("ChatGPT")) openUrl("https://chatgpt.com/"); };

  bar.appendChild(claude);
  bar.appendChild(gpt);

  var activity = document.createElement("div");
  activity.className = "amcp-act";

  ui.appendChild(bar);
  ui.appendChild(activity);

  /* ------------------------------------------------- auto-connect default -- */

  // Auto-connect is on by default and explained in the menu rather than by a
  // card the user has to dismiss. A one-time card that reappears whenever the
  // panel reloads is worse than no card at all.
  if (autoChk && !window.localStorage.getItem("amcpSeenAutoConnect")) {
    window.localStorage.setItem("amcpSeenAutoConnect", "1");
    if (!autoChk.checked) {
      autoChk.checked = true;
      autoChk.dispatchEvent(new Event("change"));
    }
  }
  if (autoChk) {
    var grp = autoChk.closest ? autoChk.closest(".checkbox-group") : null;
    if (grp) grp.style.display = "none";
  }

  /* ------------------------------------------------------------- sheets -- */

  function sheet() {
    var d = document.createElement("div");
    d.className = "amcp-sheet";
    d.hidden = true;
    return d;
  }

  var helpSheet = sheet();
  var tries = (EXAMPLES[APP] || ["Describe what you want, in plain words"])
    .map(function (t) { return "<li>“" + t + "”</li>"; }).join("");
  helpSheet.innerHTML =
    "<h4>How to use this</h4>" +
    "<ol>" +
      "<li>Leave this panel open — it is the connection.</li>" +
      "<li>Open Claude or ChatGPT above.</li>" +
      "<li>Say what you want. It works on the document you have open.</li>" +
    "</ol>" +
    "<div class='ex'>Try asking:<ul>" + tries + "</ul></div>" +
    "<p class='warn'>Save first. It edits your open document, and not every step " +
    "can be undone.</p>";

  var moreSheet = sheet();

  var logSheet = sheet();

  /* -------------------------------------------------------------- footer -- */

  var foot = document.createElement("div");
  foot.className = "amcp-foot";

  // The host app's own icon, copied in beside the panel by the hub. Makes it
  // obvious at a glance which app this panel is driving.
  var appIcon = document.createElement("img");
  appIcon.className = "amcp-appicon";
  appIcon.src = "appicon.png";
  appIcon.alt = "";
  appIcon.onerror = function () { appIcon.style.display = "none"; };
  foot.appendChild(appIcon);

  function footBtn(label, title) {
    var b = document.createElement("button");
    b.innerHTML = label;
    b.title = title;
    return b;
  }

  var helpBtn = footBtn("?", "How to use this");
  var logBtn = footBtn("Log", "Connection messages");
  var gear = footBtn("⚙", "Open the Moskito Easy MCP control panel");
  var more = footBtn("⋯", "More");
  var spacer = document.createElement("span");
  spacer.className = "sp";

  // Ask the app to raise its own window; fall back to a browser tab only if
  // the hub can't be reached.
  gear.onclick = function () {
    bindSocketOnce();
    hubRequest({ type: "open_panel" }, function (r) {
      if (!r || !r.ok) openUrl(HUB);
    });
  };

  foot.appendChild(gear);
  foot.appendChild(more);
  foot.appendChild(spacer);
  foot.appendChild(logBtn);
  foot.appendChild(helpBtn);

  function toggle(which) {
    [helpSheet, logSheet, moreSheet].forEach(function (s) {
      s.hidden = (s !== which) ? true : !s.hidden;
    });
    if (!logSheet.hidden) { errorCount = 0; paintBadge(); }
  }
  helpBtn.onclick = function () { toggle(helpSheet); };
  logBtn.onclick = function () { toggle(logSheet); };
  more.onclick = function () { toggle(moreSheet); };

  /* ---------------------------------------------------- the "more" menu -- */

  function menuItem(label, fn) {
    var b = document.createElement("button");
    b.className = "menuitem";
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  var connLabel = menuItem("Disconnect", function () {
    if (connectBtn) connectBtn.click();
    toggle(moreSheet);
  });

  var autoLabel = document.createElement("label");
  var autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.checked = autoChk ? autoChk.checked : true;
  autoBox.onchange = function () {
    if (autoChk) { autoChk.checked = autoBox.checked; autoChk.dispatchEvent(new Event("change")); }
  };
  autoLabel.appendChild(autoBox);
  autoLabel.appendChild(document.createTextNode("Connect automatically when " + APP + " opens"));

  moreSheet.innerHTML = "<h4>More</h4>";
  moreSheet.appendChild(connLabel);
  moreSheet.appendChild(menuItem("Open the control panel", function () {
    bindSocketOnce();
    hubRequest({ type: "open_panel" }, function (r) { if (!r || !r.ok) openUrl(HUB); });
  }));
  moreSheet.appendChild(menuItem("Open the control panel in a browser", function () { openUrl(HUB); }));
  moreSheet.appendChild(menuItem("Copy log to clipboard", function () {
    var t = $("messageLog");
    if (!t) return;
    t.select();
    try { document.execCommand("copy"); } catch (e) {}
    flash("Log copied");
  }));
  moreSheet.appendChild(autoLabel);

  /* ----------------------------------------------------------------- log -- */

  // The log stays — it is genuinely useful when something is wrong — but it
  // lives behind a button and only asks for attention when it has errors.
  var errorCount = 0;
  var badge = document.createElement("span");
  badge.className = "amcp-badge";
  badge.hidden = true;
  logBtn.appendChild(badge);

  function paintBadge() {
    badge.hidden = errorCount === 0;
    badge.textContent = errorCount > 9 ? "9+" : String(errorCount);
  }

  if (logSection) {
    logSheet.innerHTML = "<h4>Connection messages</h4>";
    logSection.querySelectorAll("label").forEach
      ? logSection.querySelectorAll("label").forEach(function (l) { l.style.display = "none"; })
      : null;
    logSheet.appendChild(logSection);
    var ta = $("messageLog");
    if (ta) {
      ta.setAttribute("aria-label", "Connection messages");
      ta.style.width = "100%";
      ta.style.height = "120px";
    }
  }

  /* ------------------------------------------------------ last activity -- */

  var activityTimer = null;
  function flash(text, kind) {
    activity.removeAttribute("data-owner");
    activity.innerHTML = "";
    var dot = document.createElement("span");
    dot.className = "spin";
    if (kind === "warn") dot.style.background = "var(--a-warn)";
    var span = document.createElement("span");
    span.innerHTML = text;
    activity.appendChild(dot);
    activity.appendChild(span);
    clearTimeout(activityTimer);
    activityTimer = setTimeout(function () { activity.innerHTML = ""; }, 20000);
  }

  // main.js declares log() at top level of a classic script, so it hangs off
  // window and can be wrapped without touching upstream code.
  if (typeof window.log === "function") {
    var origLog = window.log;
    window.log = function (message) {
      origLog(message);
      try { onLogLine(String(message)); } catch (e) {}
    };
  }

  function onLogLine(line) {
    var m = line.match(/Received command:\s*(\w+)/);
    if (m) return flash("<b>" + m[1] + "</b> — just now");
    if (/Response sent/.test(line)) return;
    if (/error/i.test(line)) {
      errorCount++;
      paintBadge();
      flash("Connection trouble — see Log", "warn");
    }
  }

  /* --------------------------------------------- requests to the hub -- */

  var pending = {};
  var reqId = 0;

  function hubRequest(payload, done) {
    if (typeof socket === "undefined" || !socket || !socket.connected) {
      return done({ ok: false, error: "Connect the panel first." });
    }
    var id = "r" + (++reqId);
    pending[id] = done;
    payload.id = id;
    payload.application = (typeof APPLICATION !== "undefined") ? APPLICATION : "";
    socket.emit("app_request", payload);
    setTimeout(function () {
      if (pending[id]) { delete pending[id]; done({ ok: false, error: "No reply from Adobe MCP." }); }
    }, 25000);
  }

  function bindSocketOnce() {
    if (typeof socket === "undefined" || !socket || socket._amcpBound) return;
    socket._amcpBound = true;
    socket.on("app_response", function (r) {
      var fn = r && r.id && pending[r.id];
      if (fn) { delete pending[r.id]; fn(r); }
    });
    socket.on("amcp_clients", function (c) {
      setAsk(claude, !!(c && c.claude), "Claude");
      setAsk(gpt, !!(c && c.chatgpt), "ChatGPT");
    });
  }
  setInterval(bindSocketOnce, 1000);

  // An assistant that isn't wired to this app would open and then not see it,
  // which looks like our bug. Say so on the button instead.
  function setAsk(btn, ok, name) {
    btn.disabled = !ok;
    btn.title = ok
      ? "Open the " + name + " desktop app, which can drive " + APP
      : name + " isn't connected to " + APP + ". Set it up in Moskito Easy MCP.";
  }

  function pollClients() {
    if (typeof socket !== "undefined" && socket && socket.connected) socket.emit("amcp_clients");
  }
  setInterval(pollClients, 3000);
  pollClients();

  /* ----------------------------------------------------- status mirroring -- */

  // Disconnect is no longer the biggest control on screen; the original button
  // still does the work, from the menu.
  if (connectBtn) connectBtn.style.display = "none";

  function syncStatus() {
    var txt = $("statusText") ? $("statusText").textContent : "";
    var connected = txt === "Connected";
    connLabel.textContent = connected ? "Disconnect" : "Connect";
    // This line is owned by syncStatus, so it has to clear it too — otherwise
    // "Not connected" sat there stale long after the panel had connected.
    var mine = activity.getAttribute("data-owner") === "status";
    if (!connected) {
      if (!activity.textContent || mine) {
        activity.setAttribute("data-owner", "status");
        activity.innerHTML = "<span class='spin' style='background:var(--a-soft)'></span>" +
                             "<span>Not connected — ⋯ › Connect</span>";
      }
    } else if (mine) {
      activity.removeAttribute("data-owner");
      activity.innerHTML = "";
    }
  }
  setInterval(syncStatus, 1000);
  syncStatus();

  /* --------------------------------------------------------------- mount -- */

  // The icon row goes FIRST in the panel, but it is built further down, so it
  // is inserted rather than appended.
  ui.insertBefore(foot, ui.firstChild);
  ui.appendChild(helpSheet);
  ui.appendChild(logSheet);
  ui.appendChild(moreSheet);

  // Below the status block, above everything upstream put there.
  var anchor = connectBtn || host.firstChild;
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(ui, anchor);
  else host.appendChild(ui);

  // Upstream dividers around the now-hidden controls leave stray lines.
  Array.prototype.forEach.call(document.querySelectorAll(".divider"), function (d) {
    d.style.display = "none";
  });
})();
